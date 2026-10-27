const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const assert = require('node:assert/strict')
const { randomUUID, createHash } = require('node:crypto')
const { execFileSync, spawn } = require('node:child_process')
const execFile = require('node:util').promisify(require('node:child_process').execFile)
async function hostIo() {
  try {
    const result = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}' | Select-Object ReadTransferCount,WriteTransferCount,ReadOperationCount,WriteOperationCount | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 10000, maxBuffer: 4096 })
    const counters = JSON.parse(result.stdout)
    assert.ok(Object.values(counters).every(Number.isFinite))
    return counters
  } catch { return null }
}
const branchAppUI = process.argv.includes('--branch-app-ui')
const fastStart = process.argv.includes('--fast-start')
const agentIntent = process.argv.includes('--agent-intent') || fastStart
const branchApp = process.argv.includes('--branch-app') || branchAppUI || agentIntent
const contextual = process.argv.includes('--context') || branchApp, snapshot = process.argv.includes('--snapshot') || branchApp
const root = process.cwd(), output = path.join(root, fastStart ? '.code-awareness/runtime-preview-fast-start/acceptance' : agentIntent ? '.code-awareness/runtime-preview-agent-intent/acceptance' : branchApp ? '.code-awareness/run-branch-app/acceptance' : contextual ? '.code-awareness/active-context-b/acceptance' + (snapshot ? '-snapshot' : '-empty') : '.code-awareness/u4')
fs.mkdirSync(output, { recursive: true })
if (branchApp) process.on('uncaughtException', error => {
  fs.writeFileSync(path.join(output, 'harness-uncaught.txt'), String(error.stack))
  console.error('HARNESS_UNCAUGHT_EXCEPTION', error.message)
  if (process.versions.electron) require('electron').app.exit(1)
  else process.exit(1)
})
if (!process.versions.electron) {
  const env = { ...process.env, U4_NODE: process.execPath, U4_NODE_VERSION: process.versions.node, U4_NODE_ABI: process.versions.modules,
    U4_CANONICAL_USER_DATA: path.join(process.env.APPDATA, 'code-awareness') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit', windowsHide: !contextual })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-u4-'))
  for (const key of ['appData', 'userData', 'sessionData', 'home', 'temp']) { const value = path.join(directory, key); fs.mkdirSync(value); app.setPath(key, value) }
  app.setName('Runtime Preview U4 Isolated Acceptance')
  app.enableSandbox()
  app.whenReady().then(() => main(directory, { app, BrowserWindow, ipcMain })).catch(error => { console.error(error.stack); app.exit(1) })
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })

async function main(directory, { app, BrowserWindow, ipcMain }) {
  const bundle = path.join(output, 'bundle')
  const entries = ['work-orchestration/runtime-preview/operations', 'work-orchestration/runtime-preview/runner', 'work-orchestration/runtime-preview/session-store', 'work-orchestration/runtime-preview/host-helper', 'work-orchestration/preview-profile-store', 'work-orchestration/preview-preflight', 'work-orchestration/preview-repositories', 'core/git-service', 'git-operations/git-operations-service', 'github/github-git-transport', 'repository-catalog/repository-catalog-service', 'repository-catalog/repository-catalog-store', 'validation-ledger/validation-ledger', 'validation-execution/validation-source', 'continuum/project-continuum-session', 'mcp/channel-mcp-adapter', 'mcp/mcp-http-server', 'ipc/branch-orchestration-handler']
  const packageJson = require(path.join(root, 'package.json'))
  const external = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies }).filter(name => !['mdast-util-from-markdown', 'micromark-extension-gfm', 'mdast-util-gfm', 'mdast-util-to-string'].includes(name))
  const baselineHost = process.argv.includes('--baseline-host'), baseline = 'b529540e4f1cc3eaa9219eca70adec8557a9c36c'
  const oldGuards = new Set(['src/main/work-orchestration/runtime-preview/operations.ts', 'src/main/work-orchestration/runtime-preview/runner.ts', 'src/main/work-orchestration/preview-preflight.ts'])
  const plugins = baselineHost ? [{ name: 'controlled-baseline-host', setup(build) {
    build.onLoad({ filter: /\.ts$/ }, args => {
      const relative = path.relative(root, args.path).replaceAll('\\', '/')
      if (oldGuards.has(relative)) return { contents: execFileSync('git', ['show', baseline + ':' + relative], { cwd: root, encoding: 'utf8', windowsHide: true }), loader: 'ts', resolveDir: path.dirname(args.path) }
      if (relative === 'src/main/work-orchestration/runtime-preview/adapters.ts') return { contents: fs.readFileSync(args.path, 'utf8').replace('signal: AbortSignal, enabled = true', 'signal: AbortSignal, enabled = false'), loader: 'ts', resolveDir: path.dirname(args.path) }
    })
  } }] : []
  await require('esbuild').build({ entryPoints: entries.map(file => 'src/main/' + file + '.ts'), outdir: bundle, platform: 'node', format: 'cjs', bundle: true, external, plugins, logLevel: 'silent' })
  const get = name => require(path.join(bundle, name + '.js'))
  require('esbuild').buildSync({ entryPoints: ['context-data', 'authorization', 'context-bootstrap', 'code-awareness-profile'].map(file => 'src/main/work-orchestration/runtime-preview/' + file + '.ts'), outdir: path.join(bundle, 'work-orchestration/runtime-preview'), platform: 'node', format: 'cjs', bundle: true, external, logLevel: 'silent' })
  const base = path.join(directory, 'base'), target = path.join(directory, 'feature')
  fs.mkdirSync(path.join(base, 'runtime'), { recursive: true }); fs.mkdirSync(path.join(base, 'app'))
  for (const file of ['launch.cjs', 'cooperation.cjs']) fs.copyFileSync(path.join(root, 'scripts/runtime-preview', file), path.join(base, 'runtime', file))
  fs.copyFileSync(path.join(root, 'scripts/runtime-preview/fixtures/web/index.html'), path.join(base, 'app/index.html'))
  fs.writeFileSync(path.join(base, 'app/feature.js'), "document.querySelector('#feature').textContent = 'U4 WORKTREE WEB A'\n")
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 'u4-controlled-web', version: '1.0.0', private: true }))
  fs.writeFileSync(path.join(base, 'package-lock.json'), JSON.stringify({ name: 'u4-controlled-web', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'u4-controlled-web', version: '1.0.0' } } }))
  const gitCommand = args => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: base, stdio: 'pipe', windowsHide: true })
  gitCommand(['init', '-b', 'main']); gitCommand(['config', 'core.autocrlf', 'false']); gitCommand(['add', '.']); gitCommand(['-c', 'user.name=U4 Acceptance', '-c', 'user.email=u4@example.invalid', 'commit', '-m', 'Controlled Web acceptance application'])
  gitCommand(['worktree', 'add', '-b', 'feature/u4', target])
  const { RepositoryCatalogStore } = get('repository-catalog/repository-catalog-store'), { RepositoryCatalogService, normalizeRepositoryPath } = get('repository-catalog/repository-catalog-service')
  const catalogStore = new RepositoryCatalogStore(path.join(directory, 'catalog.db'))
  const register = (folder, name) => catalogStore.upsertLocalCheckout({ path: folder, normalizedPath: normalizeRepositoryPath(folder), name, status: 'ACTIVE', availability: 'AVAILABLE', gitState: 'GIT' }).record
  const electronRepository = contextual ? catalogStore.provisionPreviewIdentity('e1c8a999-6d73-4f56-83a3-fbcd78c9c19d', { path: root, normalizedPath: normalizeRepositoryPath(root), name: 'Code Awareness development Worktree', status: 'ACTIVE', availability: 'AVAILABLE', gitState: 'GIT' }) : register(root, 'Code Awareness development Worktree')
  const webRepository = register(base, 'U4 controlled Web')
  const catalog = new RepositoryCatalogService(catalogStore, {})
  const { GitService } = get('core/git-service'), { GitOperationsService } = get('git-operations/git-operations-service'), { GitHubGitTransport } = get('github/github-git-transport')
  const git = new GitService(), transport = new GitHubGitTransport(null, git)
  const { PreviewRepositories } = get('work-orchestration/preview-repositories')
  const repositories = new PreviewRepositories(catalog, (folder, identity) => new GitOperationsService(folder, git, transport, identity, true))
  const selections = {}, profiles = []
  for (const [kind, repository, folder] of [['web', webRepository, target], ['electron', electronRepository, root]]) {
    const port = await freePort(), electron = kind === 'electron', sdk = electron ? 'scripts/runtime-preview/' : 'runtime/', configFile = electron ? 'electron.vite.config.ts' : 'package.json'
    const fixed = [sdk + 'launch.cjs', sdk + 'cooperation.cjs', configFile, ...(electron ? ['scripts/runtime-preview/build-identity.cjs'] : [])]
    const gitExecutable = electron ? execFileSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0] : null
    const profile = { schemaVersion: 1, profileId: 'u4-' + kind, revision: electron ? 2 : 1, repositoryId: repository.id, runtime: electron ? 'ELECTRON_DEV' : 'WEB_DEV_SERVER', runtimeVersion: electron ? '32.0.0' : process.env.U4_NODE_VERSION,
      command: { executable: process.env.U4_NODE, executableHash: hash(fs.readFileSync(process.env.U4_NODE)), args: [sdk + 'launch.cjs'], cwd: '.', inputs: fixed.map(file => ({ path: file, fingerprint: hash(fs.readFileSync(path.join(folder, file))) })) }, env: electron ? { PATH: path.dirname(gitExecutable) + path.delimiter + path.join(process.env.SystemRoot, 'System32') } : {},
      resources: [{ name: 'runtime', strategy: 'SESSION_DIRECTORY' }, { name: 'http-hmr', strategy: 'SESSION_ENDPOINT' }],
      dependencies: { packageManager: 'npm', packageManagerVersion: '10.9.4', manifest: 'package.json', lockfile: 'package-lock.json', manifestHash: hash(fs.readFileSync(path.join(folder, 'package.json'))), lockfileHash: hash(fs.readFileSync(path.join(folder, 'package-lock.json'))), abi: electron ? '128' : process.env.U4_NODE_ABI, materialization: '.code-awareness/u4/unverified.json' },
      cooperation: { manifest: sdk + 'cooperation.cjs', fingerprint: hash(fs.readFileSync(path.join(folder, sdk, 'cooperation.cjs'))) },
      ...(electron ? { bootstrap: { kind: 'CODE_AWARENESS', dataPolicy: snapshot ? 'REPOSITORY_SNAPSHOT' : 'EMPTY', maxBytes: 67108864, maxArtifacts: 10000 } } : {}),
      adapter: { version: 1, kind: electron ? 'ELECTRON' : 'NODE_WEB', port, configFile,
        ...(electron ? { runtimeExecutable: 'node_modules/electron/dist/electron.exe', runtimeExecutableHash: hash(fs.readFileSync(path.join(root, 'node_modules/electron/dist/electron.exe'))) } : {}),
        nativeModules: electron ? ['better-sqlite3', 'electron', 'esbuild', 'tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript'] : [],
        artifacts: electron ? [
          ...['main.ts', 'bootstrap.ts', 'work-orchestration/runtime-preview/electron-mode.ts', 'work-orchestration/runtime-preview/context-bootstrap.ts', 'work-orchestration/runtime-preview/context-data.ts', 'core/active-project-service.ts', 'continuum/project-continuum-session.ts', 'ipc/workspace-handler.ts', 'ipc/code-map-handler.ts', 'repository-catalog/repository-catalog-store.ts'].map(file => ({ component: 'ELECTRON_MAIN', path: 'src/main/' + file })),
          { component: 'ELECTRON_PRELOAD', path: 'src/main/preload.ts' }, { component: 'ELECTRON_RENDERER', path: 'src/renderer/src/App.tsx' }] : [{ component: 'WEB', path: 'app/feature.js' }] },
      security: { mode: 'profile_only', requirements: [] }, network: { destinations: [`http://127.0.0.1:${port}`], openNetworkConsent: false, credentials: 'TARGET_OWN_TEST_PROFILE' },
      probes: { readiness: { kind: 'HTTP', address: `http://127.0.0.1:${port}/`, timeoutMs: 120000 }, liveness: 'READINESS', attestation: 'COOPERATIVE_LOADED_ARTIFACT' },
      shutdown: { spawn: 'JOB_LIST_AT_CREATE', breakaway: false, killOnJobClose: true, graceMs: 0, forceMs: 10000 } }
    profiles.push(profile)
    const context = await repositories.open(repository.id), tree = context.worktrees.find(tree => path.resolve(tree.path).toLowerCase() === folder.toLowerCase())
    assert.ok(tree)
    selections[kind] = { repositoryId: repository.id, worktreeId: tree.worktreeId, generation: tree.generation, profileId: profile.profileId }
  }
  const reuseProfileIndex = process.argv.indexOf('--branch-profiles')
  const profileDirectory = branchApp && reuseProfileIndex >= 0 ? fs.realpathSync(process.argv[reuseProfileIndex + 1]) : path.join(directory, 'profiles')
  if (reuseProfileIndex < 0) { fs.mkdirSync(profileDirectory); fs.writeFileSync(path.join(profileDirectory, 'profiles.json'), JSON.stringify(profiles.filter(p => !branchApp || p.runtime !== 'ELECTRON_DEV'))) }
  const { PreviewProfileStore } = get('work-orchestration/preview-profile-store'), { PreviewPreflightService } = get('work-orchestration/preview-preflight')
  const profileStore = new PreviewProfileStore(profileDirectory)
  for (const kind of ['web', 'electron']) if (!branchApp) selections[kind].fingerprint = hash(JSON.stringify((await profileStore.profiles(selections[kind].repositoryId))[0]))
  const faults = process.argv.includes('--faults'), build = require('./build.cjs').build(faults)
  const resolveHelper = get('work-orchestration/runtime-preview/host-helper').resolvePreviewHelper
  const helperConfig = { packaged: false, resources: '', root, developmentBuild: JSON.stringify(build) }
  if (faults) assert.throws(() => resolveHelper(helperConfig), /PREVIEW_HELPER_BUILD_INVALID/)
  const helper = faults ? { executable: build.owner, fingerprint: build.fingerprint, sdkDirectory: path.join(root, 'scripts/runtime-preview') } : resolveHelper(helperConfig)
  const store = new (get('work-orchestration/runtime-preview/session-store').PreviewSessionStore)(path.join(directory, 'sessions'))
  const releaseResources = store.releaseResources.bind(store)
  store.releaseResources = id => {
    try { return releaseResources(id) }
    catch (error) { save('resource-release-error', { success: false, sessionId: id, code: error.code ?? error.message, resource: error.path ? path.relative(store.runtime(id), error.path) : null }); throw error }
  }
  const retained = new Map(), diagnosticWatchers = new Map()
  const retainDiagnostics = () => {
    if (!branchApp) return
    for (const record of store.list()) {
      const runtime = store.runtime(record.sessionId)
      if (!fs.existsSync(runtime) || diagnosticWatchers.has(record.sessionId)) continue
      const capture = () => {
        for (const name of ['bootstrap.stdout.log', 'bootstrap.stderr.log', 'bootstrap-failure.json']) {
          const file = path.join(runtime, name)
          try {
            const stat = fs.statSync(file), key = record.sessionId + ':' + name
            if (stat.size > 65536 || retained.get(key) === stat.mtimeMs) continue
            fs.writeFileSync(path.join(output, record.sessionId + '-' + name), fs.readFileSync(file))
            retained.set(key, stat.mtimeMs)
          } catch (error) { if (error.code !== 'ENOENT') console.error('DIAGNOSTIC_CAPTURE_UNAVAILABLE') }
        }
      }
      try {
        const watcher = fs.watch(runtime, capture)
        watcher.on('error', error => { console.error('DIAGNOSTIC_WATCH_UNAVAILABLE', error.code); watcher.close(); diagnosticWatchers.delete(record.sessionId) })
        diagnosticWatchers.set(record.sessionId, watcher); capture()
      } catch (error) { if (error.code !== 'ENOENT') console.error('DIAGNOSTIC_WATCH_UNAVAILABLE', error.code) }
    }
  }
  const diagnosticTimer = branchApp ? setInterval(retainDiagnostics, 1000) : undefined
  const { RuntimePreviewRunner, CatalogPreviewLaunchAuthority } = get('work-orchestration/runtime-preview/runner')
  const provisionerModule = get('work-orchestration/runtime-preview/context-data')
  const provisioner = new provisionerModule.RepositoryPreviewContextProvisioner(catalog, path.join(contextual && snapshot ? process.env.U4_CANONICAL_USER_DATA : directory, 'continuum'))
  let bootstrapFault
  const runnerProvisioner = { watchInvalidation: (profile, invalidate) => provisioner.watchInvalidation(profile, invalidate), prepare: async input => {
    const manifest = await provisioner.prepare(input)
    if (bootstrapFault === 'generation') manifest.selection.generation = 'invalid-generation'
    if (bootstrapFault === 'digest') manifest.data.digest = 'f'.repeat(64)
    bootstrapFault = undefined
    return manifest
  } }
  const preflight = new PreviewPreflightService(profileStore)
  const cacheOptions = { buildCache: process.argv.includes('--cache-enabled') }
  const runner = new RuntimePreviewRunner(store, new CatalogPreviewLaunchAuthority(repositories, profileStore, preflight), helper, runnerProvisioner, cacheOptions)
  const start = runner.start.bind(runner)
  runner.start = async input => { try { return await start(input) } catch (error) { fs.writeFileSync(path.join(output, 'launch-diagnostic.txt'), String(error.stack)); console.error('LAUNCH_DIAGNOSTIC', error.message); throw error } }
  const ledger = new (get('validation-ledger/validation-ledger').ValidationLedger)(path.join(directory, 'ledger.db'))
  const continuum = new (get('continuum/project-continuum-session').RepositoryContinuumSession)(path.join(directory, 'continuum'), { findByPath: folder => folder === base ? webRepository : null })
  continuum.activate(base)
  let approvals = 0, approvalAllowed = true
  let authorizationWindow
  const confirmation = async (profile, policy) => {
    approvals++
    if (!contextual) return approvalAllowed
    authorizationWindow.show()
    authorizationWindow.focus()
    try { return await get('work-orchestration/runtime-preview/authorization').confirmPreviewProfile(authorizationWindow, profile, provisioner, policy) }
    finally { authorizationWindow.hide() }
  }
  const branchProfiles = branchApp ? new (get('work-orchestration/runtime-preview/code-awareness-profile').CodeAwarenessProfileResolver)(profileStore, { root, executable: process.execPath, electronVersion: process.versions.electron, abi: process.versions.modules }) : undefined
  const service = new (get('work-orchestration/runtime-preview/operations').RuntimePreviewOperations)(repositories, profileStore, store, runner, confirmation, ledger, continuum, branchProfiles, preflight)
  let active = { revision: 1, project: { id: webRepository.id, path: base, name: 'U4 controlled Web' } }
  const activeGit = (await repositories.open(webRepository.id)).git
  const { BranchOrchestrationController, registerBranchOrchestrationHandlers } = get('ipc/branch-orchestration-handler')
  const controller = new BranchOrchestrationController({ getState: () => active }, async () => false, continuum, profileStore, confirmation, repositories, service)
  controller.bind(activeGit, { branchPullRequests: async () => ({ repositoryId: webRepository.id, relations: [], received: [], orphaned: [], catalog: { coverage: 'COMPLETE', items: [], observedAt: new Date().toISOString() }, at: new Date().toISOString() }) }, base)
  registerBranchOrchestrationHandlers(controller)
  const preload = path.join(directory, 'acceptance-preload.cjs')
  fs.writeFileSync(preload, "const {ipcRenderer}=require('electron');ipcRenderer.on('u4:request',async(_,id,request)=>{try{ipcRenderer.send('u4:result',id,await ipcRenderer.invoke('work-orchestration:branches',request))}catch{ipcRenderer.send('u4:result',id,{success:false,code:'IPC_FAILURE'})}})")
  const window = new BrowserWindow({ title: 'Runtime Preview — autorização isolada', show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  authorizationWindow = window
  await window.loadURL('about:blank')
  const requests = new Map()
  ipcMain.on('u4:result', (event, id, result) => { if (event.sender !== window.webContents) return; requests.get(id)?.(result) })
  const ipc = request => new Promise((resolve, reject) => {
    if (requests.size >= 16) return reject(new Error('ACCEPTANCE_BUSY'))
    const id = randomUUID(), timeout = setTimeout(() => { requests.delete(id); reject(new Error('IPC_TIMEOUT')) }, 15000)
    requests.set(id, value => { clearTimeout(timeout); requests.delete(id); resolve(value) }); window.webContents.send('u4:request', id, request)
  })
  const { ChannelMcpAdapter } = get('mcp/channel-mcp-adapter')
  const adapter = new ChannelMcpAdapter({ projectId: active.project.id, repoRoot: base, navigation: {}, runtimePreview: { service, isCurrent: () => active.revision === 1 }, continuum: continuum.getActiveService() }, undefined, undefined, ledger)
  const token = randomUUID()
  const server = get('mcp/mcp-http-server').createMcpHttpServer(adapter, () => {}, undefined, headers => headers['x-u4-binding'] === token)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const mcpUrl = `http://127.0.0.1:${server.address().port}/mcp`
  const receipts = [], save = (label, result) => { receipts.push({ label, at: new Date().toISOString(), result }); fs.writeFileSync(path.join(output, faults ? 'acceptance-faults.json' : 'acceptance.json'), JSON.stringify({ directory, selections, approvals, active, faults, receipts }, null, 2)); console.log(JSON.stringify({ label, success: result.success, kind: result.data?.kind, code: result.code, session: result.data?.session?.sessionId, state: result.data?.session?.state, readiness: result.data?.session?.readiness, qualification: result.data?.qualification?.status })) }
  let requestNumber = 0
  const mcp = async (name, args) => {
    const response = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-u4-binding': token }, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestNumber, method: 'tools/call', params: { name, arguments: args } }) })
    const body = await response.json()
    assert.equal(response.status, 200)
    const value = body.result?.structuredContent ?? JSON.parse(body.result?.content?.[0]?.text ?? '{}')
    assert.equal(typeof value.success, 'boolean', JSON.stringify(body))
    save(name, value); return value
  }
  const branchRequest = operation => ipc({ context: { projectId: webRepository.id, revision: 1 }, operation })
  const unauthorized = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(unauthorized.status, 409)
  const listTools = adapter.listTools().filter(tool => tool.name.includes('runtime_preview') || ['run_branch_app', 'prepare_branch_app'].includes(tool.name))
  assert.equal(listTools.length, 15)
  save('isolated-mcp-tools', { success: true, tools: listTools.map(tool => tool.name), unauthorizedStatus: unauthorized.status })
  for (const [name, args] of [['start_runtime_preview', { selection: selections.web, operationId: randomUUID(), command: 'forbidden' }], ['stop_runtime_preview', { sessionId: 'all' }], ['probe_runtime_preview', { sessionId: randomUUID(), probes: ['SHELL'] }], ['read_runtime_preview_evidence', { sessionId: randomUUID(), section: 'RUNTIME', limit: 1000 }]]) assert.equal((await mcp(name, args)).success, false)
  save('ipc-inventory', await branchRequest({ action: 'INVENTORY' }))
  active = { ...active, revision: 2 }
  assert.equal((await branchRequest({ action: 'PREVIEW_RUNTIME', request: { action: 'WORKTREES', repositoryId: webRepository.id } })).success, false)
  assert.equal((await mcp('list_runtime_preview_worktrees', { repositoryId: webRepository.id })).success, false)
  active = { ...active, revision: 1 }
  for (const kind of ['web', 'electron']) {
    const response = await branchRequest({ action: 'PREVIEW_RUNTIME', request: { action: 'WORKTREES', repositoryId: selections[kind].repositoryId } })
    assert.equal(response.success, true); save('ipc-' + kind + '-worktrees', response)
  }
  if (branchAppUI) {
    active = { revision: 1, project: { id: electronRepository.id, path: root, name: 'Code Awareness UI acceptance' } }
    controller.bind((await repositories.open(electronRepository.id)).git, { branchPullRequests: async () => ({ repositoryId: electronRepository.id, relations: [], received: [], orphaned: [], catalog: { coverage: 'UNAVAILABLE', reason: 'ISOLATED_ACCEPTANCE', items: [], observedAt: new Date().toISOString() }, at: new Date().toISOString() }) }, root)
  }
  let uiWindow
  const uiRoot = path.join(output, 'ui'); fs.mkdirSync(uiRoot, { recursive: true })
  fs.writeFileSync(path.join(uiRoot, 'index.html'), '<html><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>')
  fs.writeFileSync(path.join(uiRoot, 'entry.tsx'), `import React from 'react';import{createRoot}from'react-dom/client';import{BranchManagerView}from'/src/renderer/src/components/WorkOrchestrationView/BranchManagerView';import'/src/renderer/src/index.css';const state=${JSON.stringify(active)};const request=async operation=>{const response=await fetch('/u4-branch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(operation)});return response.json()};window.codeAwareness={getBranchOrchestration:request,listRepositories:async()=>${JSON.stringify([webRepository, electronRepository])},onContinuumChanged:()=>()=>{},onWorkOrchestrationChanged:()=>()=>{},activateRepository:()=>{throw Error('ACTIVE_PROJECT_MUST_NOT_CHANGE')}};createRoot(document.getElementById('root')).render(<div className="dark" style={{height:'100vh'}}><BranchManagerView active={true} state={state} onClose={()=>{}}/></div>);`)
  const vite = await import('vite'), react = (await import('@vitejs/plugin-react')).default
  const ui = await vite.createServer({ configFile: false, root: uiRoot, cacheDir: path.join(directory, 'ui-vite-cache'), plugins: [react(), { name: 'isolated-u4-ipc-bridge', configureServer(server) { server.middlewares.use('/u4-branch', async (req, res) => { try { if (req.method !== 'POST' || req.headers.origin && req.headers.origin !== `http://127.0.0.1:${ui.httpServer.address().port}`) throw Error('INVALID_ORIGIN'); let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 32768) throw Error('INVALID_SIZE') } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(await ipc(JSON.parse(body)))) } catch { res.statusCode = 400; res.end('{}') } }) } }], resolve: { alias: { '/src': path.join(root, 'src') } }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } } })
  await ui.listen()
  console.log(JSON.stringify({ ready: true, ui: `http://127.0.0.1:${ui.httpServer.address().port}`, web: profiles[0].probes.readiness.address, directory }))
  fs.writeFileSync(path.join(output, 'identity.json'), JSON.stringify({ directory, selections, profiles, root, canonicalDataOrigin: snapshot ? 'PRIMARY_SELECTED_REPOSITORY' : 'NONE' }))
  let currentKind = branchApp ? 'electron' : 'web', sessionId, bindingId, proofId, branchIntent
  const commandFile = path.join(output, 'commands.json')
  fs.writeFileSync(commandFile, '[]')
  let consumed = 0, wake
  const commandQueue = []
  const watcher = fs.watch(commandFile, () => {
    try { const values = JSON.parse(fs.readFileSync(commandFile, 'utf8')); commandQueue.push(...values.slice(consumed)); consumed = values.length; wake?.(); wake = undefined } catch { }
  })
  async function* inputCommands() { while (true) { if (!commandQueue.length) await new Promise(resolve => { wake = resolve }); while (commandQueue.length) yield commandQueue.shift() } }
  const commands = inputCommands()
  for await (const command of commands) {
    try {
      if (fastStart && command === 'standby-trust') {
        const context = await repositories.open(electronRepository.id), inventory = await context.git.getBranchInventory()
        const tree = inventory.worktrees.find(value => path.resolve(value.path).toLowerCase() === root.toLowerCase())
        const profile = await branchProfiles.resolve(electronRepository.id, tree.worktreeId, tree.path)
        const selection = { repositoryId: electronRepository.id, worktreeId: tree.worktreeId, generation: tree.generation, profileId: profile.profileId, fingerprint: hash(JSON.stringify(profile)) }
        const policy = { idleMs: 180000, maxPrivateBytes: 2 * 1024 ** 3, maxWorkingSetBytes: 2 * 1024 ** 3, maxCpuPercent: 5, minAvailableBytes: 512 * 1048576, sampleMs: 5000 }
        await service.handle({ action: 'TRUST_REPOSITORY', selection, policy }); save('standby-trust', await service.pendingResult())
      }
      if (fastStart && command === 'standby-prepare') {
        const context = await repositories.open(electronRepository.id), inventory = await context.git.getBranchInventory()
        const tree = inventory.worktrees.find(value => path.resolve(value.path).toLowerCase() === root.toLowerCase())
        branchIntent = { repositoryId: electronRepository.id, branch: tree.branch, expectedHead: tree.head, worktreeId: tree.worktreeId, operationId: randomUUID() }
        await mcp('prepare_branch_app', branchIntent)
        const result = await service.pendingResult(); save('standby-prepared', result)
        const record = store.list().find(value => value.operationId === branchIntent.operationId)
        if (record) { sessionId = record.sessionId; save('standby-receipt', { success: true, sessionId, state: record.state, standby: record.standby, timing: record.startTiming, process: record.process }) }
      }
      if (fastStart && command === 'standby-show') {
        const before = store.read(sessionId), operationId = randomUUID(), approvalsBefore = approvals
        const start = performance.now(); await mcp('run_branch_app', { repositoryId: before.selection.repositoryId, branch: before.sourceSnapshot.branch, expectedHead: before.sourceSnapshot.head, operationId })
        const result = await service.pendingResult(); save('standby-shown', result)
        if (result?.success && result.data.kind === 'SESSION' && result.data.session) sessionId = result.data.session.sessionId
        const after = store.read(sessionId)
        save('standby-presentation', { success: after.standby?.state === 'RUNNING', remoteMs: performance.now() - start, presentation: after.standby?.presentation, samePid: before.process.pid === after.process.pid, sameSession: before.sessionId === after.sessionId, approvals: approvals - approvalsBefore })
      }
      if (fastStart && command === 'standby-metrics') save('standby-metrics', { success: true, sessionId, metrics: runner.slotMetrics(sessionId), standby: store.read(sessionId).standby })
        if (fastStart && ['cache-on', 'cache-off'].includes(command)) {
          assert.equal(baselineHost, false); assert.ok(store.list().every(record => ['STOPPED', 'FAILED'].includes(record.state)))
          cacheOptions.buildCache = command === 'cache-on'
          save('cache-policy', { success: true, enabled: cacheOptions.buildCache })
        }
      if (command.startsWith('select ')) currentKind = command.slice(7)
      const selection = selections[currentKind]; assert.ok(selection)
      if (agentIntent && ['run-agent', 'replay-agent', 'refuse-agent'].includes(command)) {
        if (command !== 'replay-agent') {
          sessionId = undefined
          const context = await repositories.open(electronRepository.id), inventory = await context.git.getBranchInventory()
          const tree = inventory.worktrees.find(w => path.resolve(w.path).toLowerCase() === root.toLowerCase())
          assert.ok(tree && tree.branch && tree.head)
          branchIntent = { repositoryId: electronRepository.id, branch: tree.branch, expectedHead: command === 'refuse-agent' ? '0'.repeat(40) : tree.head, operationId: randomUUID() }
        }
        assert.ok(branchIntent)
        save('agent-intention', { success: true, ...branchIntent, guardSource: baselineHost ? baseline : 'CURRENT_CHECKPOINT', cacheEnabled: baselineHost ? false : cacheOptions.buildCache })
        const ioBefore = fastStart ? await hostIo() : null
        const started = performance.now(), cpu = process.cpuUsage(), delayWindows = []
        let previous = started, mainMaxDelayMs = 0
        const pulse = setInterval(() => {
          const now = performance.now(), durationMs = Math.max(0, now - previous - 20)
          mainMaxDelayMs = Math.max(mainMaxDelayMs, durationMs)
          if (durationMs >= 100) { delayWindows.push({ startMs: previous - started, durationMs }); delayWindows.sort((a, b) => b.durationMs - a.durationMs); delayWindows.length = Math.min(16, delayWindows.length) }
          previous = now
        }, 20)
        try {
          await mcp('run_branch_app', branchIntent)
          const complete = service.pendingResult()
          if (fastStart && complete) void complete.finally(async () => {
            clearInterval(pulse); const used = process.cpuUsage(cpu), elapsedMs = performance.now() - started, ioAfter = await hostIo()
            save('host-startup-observation', { success: true, operationId: branchIntent.operationId,
              mainMaxDelayMs, delayWindows, hostProcessCpuMs: (used.user + used.system) / 1000, elapsedMs,
              io: ioBefore && ioAfter ? Object.fromEntries(Object.keys(ioBefore).map(key => [key, ioAfter[key] - ioBefore[key]])) : null })
          })
          else clearInterval(pulse)
        } catch (error) { clearInterval(pulse); throw error }
      }
      if (agentIntent && command === 'agent-status') {
        const result = await mcp('get_runtime_preview_status', sessionId ? { sessionId } : { operationId: branchIntent.operationId })
        assert.equal(result.success, true)
        assert.equal(result.data.kind, 'STATUS')
        assert.ok(!/coverage|qualifications|lastOperation|resourceInventory/.test(JSON.stringify(result)))
        if (result.data.sessionId) { sessionId = result.data.sessionId; Object.assign(selections.electron, store.read(sessionId).selection) }
        save('agent-status', result)
      }
      if (agentIntent && command === 'stop-agent') await mcp('stop_runtime_preview', { sessionId })
      if (fastStart && command === 'startup-evidence') await mcp('read_runtime_preview_evidence', { sessionId, section: 'RUNTIME', limit: 1 })
      if (fastStart && command === 'ready-stop') {
        const deadline = Date.now() + 240000
        let record
        while (Date.now() < deadline) {
          record = record ? store.read(record.sessionId) : store.list().find(value => value.operationId === branchIntent.operationId)
          if (record?.state === 'FAILED') throw new Error(record.failure)
          if (record?.state === 'RUNNING' && record.readiness === 'READY' && record.attestation.loadedCode === 'VERIFIED') break
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        assert.equal(record?.readiness, 'READY'); sessionId = record.sessionId
        const status = await mcp('get_runtime_preview_status', { sessionId }); assert.equal(status.data.ready, true)
        const config = JSON.parse(fs.readFileSync(path.join(store.runtime(sessionId), 'configuration.json')))
        const forbidden = [config.token, sessionId, store.runtime(sessionId), `http://127.0.0.1:${config.port}`, 'artifact-4e4b69c9-05a5-4015-89e6-11199c7d1649', 'SQLite format 3\0']
        save('ready-before-retention', { success: true, sessionId, cachePending: record.buildCache?.retainedBytes === 0, technicalWindowMs: record.startTiming.technicalWindowMs, technicalReadyMs: record.startTiming.technicalReadyMs })
        assert.equal((await mcp('stop_runtime_preview', { sessionId })).success, true)
        let stopped
        while (Date.now() < deadline) {
          stopped = await mcp('get_runtime_preview_status', { sessionId })
          if (stopped.data.phase === 'STOPPED') break
          if (stopped.data.phase === 'UNKNOWN') await runner.inspect(sessionId)
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        assert.equal(stopped.data.resourcesReleased, true); assert.equal(stopped.data.activeProcesses, 0); assert.equal(stopped.data.handlesClosed, true)
        assert.equal(fs.existsSync(store.runtime(sessionId)), false)
        const cacheRoot = path.join(store.root, 'build-cache'); let files = 0, bytes = 0
        const scan = folder => {
          for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const file = path.join(folder, entry.name)
            if (entry.isDirectory()) scan(file)
            else { const content = fs.readFileSync(file); files++; bytes += content.length; for (const value of forbidden) assert.equal(content.includes(Buffer.from(value)), false) }
          }
        }
        if (fs.existsSync(cacheRoot)) scan(cacheRoot)
        save('retention-stop-barrier', { success: true, sessionId, cache: store.read(sessionId).buildCache, files, bytes, secretsAbsent: true, privateResourcesReleased: true })
      }
      if (fastStart && command === 'hmr-check') {
        const file = path.join(root, 'src/renderer/src/App.tsx'), original = fs.readFileSync(file)
        const observe = async expected => {
          const deadline = Date.now() + 20000
          while (Date.now() < deadline) {
            const record = store.read(sessionId)
            const evidence = JSON.parse(fs.readFileSync(path.join(store.runtime(sessionId), 'electron-evidence.json'), 'utf8'))
            if (evidence.rendererModules.some(module => module.path === 'src/renderer/src/App.tsx' && module.sourceDigest === hash(expected))) {
              const current = await runner.inspect(sessionId)
              assert.equal(current.readiness, 'READY'); assert.equal(current.attestation.loadedCode, 'VERIFIED')
              return record.buildCache?.status
            }
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          throw new Error('HMR_NOT_OBSERVED')
        }
        try {
          const changed = Buffer.concat([original, Buffer.from(`\n;void "runtime-preview-hmr-${randomUUID()}";\n`)])
          fs.writeFileSync(file, changed); await observe(changed)
        } finally { fs.writeFileSync(file, original) }
        const cacheStatus = await observe(original)
        save('hmr-real-electron', { success: true, sessionId, changedObserved: true, restoredObserved: true, cacheStatus })
      }
      if (branchAppUI && command === 'ui-open') {
        uiWindow = new BrowserWindow({ title: 'Work Orchestration — aceitação isolada', show: true, width: 1440, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
        await uiWindow.loadURL(`http://127.0.0.1:${ui.httpServer.address().port}`)
        save('ui-open', { success: true, source: root, branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim() })
      }
      if (branchAppUI && ['ui-run', 'ui-stop', 'ui-details'].includes(command)) {
        assert.ok(uiWindow)
        const ref = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
        const label = (command === 'ui-run' ? 'Rodar aplicativo: ' : command === 'ui-stop' ? 'Encerrar aplicativo: ' : 'Detalhes: ') + ref
        const clicked = await uiWindow.webContents.executeJavaScript(`(() => {const button=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)});if(!button||button.disabled)return false;button.scrollIntoView({block:'center'});button.click();return true})()`, true)
        assert.equal(clicked, true); save(command, { success: true, label })
      }
      if (branchAppUI && /^ui-capture(?:-(light|dark|narrow|running|stopped|details|cancelled))?$/.test(command)) {
        assert.ok(uiWindow)
        if (command.endsWith('-dark')) await uiWindow.webContents.executeJavaScript("document.body.dataset.theme='dark'")
        if (command.endsWith('-light')) await uiWindow.webContents.executeJavaScript("document.body.dataset.theme='light'")
        if (command.endsWith('-narrow')) uiWindow.setContentSize(700, 850)
        else uiWindow.setContentSize(1440, 900)
        const state = await uiWindow.webContents.executeJavaScript("({text:document.querySelector('.bm-list')?.innerText, aside:!!document.querySelector('.bm-detail'), buttons:[...document.querySelectorAll('.bm-card button')].slice(0,6).map(b=>({label:b.getAttribute('aria-label'),disabled:b.disabled})), overflow:document.documentElement.scrollWidth>innerWidth})")
        fs.writeFileSync(path.join(output, 'ui-session-records.json'), JSON.stringify(store.list().map(record => store.read(record.sessionId)), null, 2))
        uiWindow.webContents.invalidate()
        await uiWindow.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        const capture = await uiWindow.webContents.capturePage(undefined, { stayHidden: true })
        assert.equal(capture.isEmpty(), false, 'UI_CAPTURE_EMPTY')
        fs.writeFileSync(path.join(output, command + '.png'), capture.toPNG()); save(command, { success: true, ...state })
      }
      if (branchAppUI && command === 'ui-close-details') {
        await uiWindow.webContents.executeJavaScript("document.querySelector('[aria-label=\"Fechar detalhes\"]')?.click()", true)
      }
      if (command === 'run-branch' || command === 'replay-branch') {
        assert.ok(branchApp)
        if (command === 'run-branch') {
          const context = await repositories.open(electronRepository.id), inventory = await context.git.getBranchInventory()
          const tree = inventory.worktrees.find(w => path.resolve(w.path).toLowerCase() === root.toLowerCase())
          const branch = inventory.branches.find(b => b.worktrees.some(w => w.worktreeId === tree.worktreeId && w.generation === tree.generation))
          assert.ok(branch)
          branchIntent = { action: 'RUN_BRANCH_APP', repositoryId: electronRepository.id, ref: branch.ref, revision: branch.revision, operationId: randomUUID() }
        }
        assert.ok(branchIntent)
        const response = await branchRequest({ action: 'PREVIEW_RUNTIME', request: branchIntent }); save('branch-intent-ipc', response)
        const completed = await service.pendingResult(); const result = completed ?? response.data?.result
        save('branch-app-complete', result)
        if (result?.data?.session) { sessionId = result.data.session.sessionId; Object.assign(selections.electron, result.data.session.selection) }
      }
      if (command.startsWith('bootstrap-fault ')) bootstrapFault = command.slice(16)
      if (command === 'deny' || command === 'approve') {
        approvalAllowed = command === 'approve'
        await mcp('authorize_runtime_preview_profile', { selection }); save('authorization-complete', await service.pendingResult() ?? { success: true })
      }
      if (command === 'preflight') { await mcp('preflight_runtime_preview', { selection }); const completed = await service.pendingResult(); if (completed) save('preflight-complete', completed) }
      if (command === 'attach') {
        const completed = await service.pendingResult(); if (completed) save('ui-operation-complete', completed)
        const listed = await mcp('list_runtime_previews', { repositoryId: selection.repositoryId, worktreeId: selection.worktreeId, limit: 1 })
        sessionId = listed.data.sessions.find(session => session.state === 'RUNNING')?.sessionId; assert.ok(sessionId)
      }
      if (command === 'negative-identities') {
        for (const patch of [{ repositoryId: randomUUID() }, { worktreeId: 'other-tree' }, { generation: 'other-generation' }, { fingerprint: 'f'.repeat(64) }]) { await mcp('preflight_runtime_preview', { selection: { ...selection, ...patch } }); assert.equal((await service.pendingResult()).success, false) }
      }
      if (command === 'context-check') {
        const record = store.read(sessionId), context = record.context
        assert.ok(context); assert.equal(record.state, 'RUNNING')
        const file = path.join(store.runtime(sessionId), 'electron-evidence.json'), evidence = JSON.parse(fs.readFileSync(file))
        assert.equal(evidence.context.repositoryId, selection.repositoryId)
        assert.equal(evidence.context.activeCheckout.toLowerCase(), fs.realpathSync(root).toLowerCase())
        assert.equal(evidence.context.data.policy, snapshot ? 'REPOSITORY_SNAPSHOT' : 'EMPTY')
        save('context-bound-real-electron', { sessionId, context, evidence, approvals })
      }
      if (command === 'start') {
        const operationId = randomUUID()
        await mcp('start_runtime_preview', { selection, operationId }); const completed = await service.pendingResult(); save('start-complete', completed)
        sessionId = completed?.data?.session?.sessionId
        assert.equal(completed?.data?.session?.state, 'RUNNING')
        const duplicate = await mcp('start_runtime_preview', { selection, operationId }); await service.pendingResult(); assert.equal(duplicate.success, true)
      }
      if (command === 'inspect' || command === 'probe') { await mcp(command === 'inspect' ? 'inspect_runtime_preview' : 'probe_runtime_preview', { sessionId, ...(command === 'probe' ? { probes: ['READINESS', 'ATTESTATION'] } : {}) }); const completed = await service.pendingResult(); if (completed) save(command + '-complete', completed) }
      if (command === 'evidence') await mcp('read_runtime_preview_evidence', { sessionId, section: 'COVERAGE', limit: 2 })
      if (command === 'change-web') fs.writeFileSync(path.join(target, 'app/feature.js'), "document.querySelector('#feature').textContent = 'U4 WORKTREE WEB B — selected checkout only'\n")
      if (command === 'crash-renderer') {
        assert.ok(faults && currentKind === 'electron')
        const native = runner.owners.get(sessionId), members = (await native.processes()).processes
        const evidence = JSON.parse(fs.readFileSync(path.join(store.runtime(sessionId), 'electron-evidence.json')))
        const member = members.find(member => member.pid === evidence.rendererPid); assert.ok(member)
        await native.request('crash-member', member)
        save('controlled-owned-renderer-crash', { success: true, sessionId })
      }
      if (command === 'wrong-source') {
        assert.equal(currentKind, 'electron')
        const file = path.join(store.runtime(sessionId), 'electron-evidence.json'), original = fs.readFileSync(file)
        const wrong = JSON.parse(original); wrong.sessionId = randomUUID(); fs.writeFileSync(file, JSON.stringify(wrong))
        try { await mcp('inspect_runtime_preview', { sessionId }); const observed = await service.pendingResult(); save('wrong-source-complete', observed); assert.notEqual(observed.data.session.readiness, 'READY') }
        finally { fs.writeFileSync(file, original) }
      }
      if (command === 'bind') {
        const executionId = 'u4-' + randomUUID(), service = continuum.getActiveService()
        const source = service.publish('---\n' + JSON.stringify({ name: 'U4 isolated acceptance fixture', description: 'Private integration fixture, not canonical V5', kind: 'EXECUTABLE_PLAN', executionId }) + '\n---\n\nControlled acceptance criterion: u4-web-text.')
        const bound = await service.bindExecutionBranch(executionId, source.artifactId, async () => {
          const context = await repositories.open(selection.repositoryId, selection.worktreeId), inventory = await context.git.getBranchInventory(), branch = inventory.branches.find(branch => branch.worktrees.some(tree => tree.worktreeId === selection.worktreeId)), identity = await context.git.getCoordinationIdentity(selection.worktreeId)
          return { repositoryId: selection.repositoryId, branchRef: branch.ref, branchGeneration: branch.generation, branchRevision: branch.revision, head: branch.head, worktreeId: selection.worktreeId, worktreeGeneration: selection.generation, fingerprint: hash(JSON.stringify(identity.record)) }
        })
        bindingId = bound.artifactId; save('binding', { success: true, ...bound }); await mcp('list_runtime_preview_bindings', { sessionId })
      }
      if (command.startsWith('proof ')) {
        assert.ok(bindingId); const summary = command.slice(6), record = store.read(sessionId), executionId = continuum.getActiveService().get(bindingId).metadata.executionId
        const { captureValidationSource, validationSourceFingerprint } = get('validation-execution/validation-source'), source = await captureValidationSource(target, webRepository.id), now = new Date().toISOString()
        const proof = ledger.recordProof({ kind: 'MANUAL_ACCEPTANCE', producer: 'TESTER', status: 'PASSED', startedAt: record.startedAt, finishedAt: now, durationMs: Date.parse(now) - Date.parse(record.startedAt), scope: ['app/feature.js'], summary, sourceFingerprint: validationSourceFingerprint(source), commandProfile: { command: 'runtime-preview:manual-observation', cwd: source.cwd, source }, evidenceFor: ['u4-web-text', 'runtime-preview:' + sessionId, 'execution:' + executionId] })
        proofId = proof.proofId; save('behavior-proof', { success: true, proofId, summary })
      }
      if (command === 'qualify') { await mcp('qualify_runtime_preview', { sessionId, bindingId, proofId, criterionId: 'u4-web-text' }); const completed = await service.pendingResult(); if (completed) save('qualify-complete', completed) }
      if (command === 'negative-qualification') {
        await mcp('qualify_runtime_preview', { sessionId, bindingId, proofId, criterionId: 'unproved-criterion' }); const completed = await service.pendingResult(); save('wrong-criterion-complete', completed); assert.equal(completed.success, false)
      }
      if (command === 'recover-endpoint') {
        const owner = runner.owners.get(sessionId); assert.ok(owner)
        await owner.stop(0, 10000, false); await owner.shutdown(); runner.owners.delete(sessionId)
        const sibling = net.createServer(), port = profiles.find(profile => profile.profileId === selection.profileId).adapter.port
        await new Promise((resolve, reject) => { sibling.once('error', reject); sibling.listen(port, '127.0.0.1', resolve) })
        await mcp('inspect_runtime_preview', { sessionId }); const incomplete = await service.pendingResult(); save('recovery-collision-complete', incomplete)
        assert.equal(incomplete.data.session.state, 'CLEANUP_INCOMPLETE'); assert.equal(sibling.listening, true)
        await new Promise(resolve => sibling.close(resolve))
        await mcp('inspect_runtime_preview', { sessionId }); const recovered = await service.pendingResult(); save('recovery-released-complete', recovered); assert.equal(recovered.data.session.state, 'STOPPED')
      }
      if (command === 'history') await mcp('list_runtime_previews', { repositoryId: selection.repositoryId, limit: 10 })
      if (command === 'stop') { await mcp('stop_runtime_preview', { sessionId }); const completed = await service.pendingResult() ?? (await mcp('list_runtime_previews', { repositoryId: selection.repositoryId })).data?.lastOperation?.result; save('stop-complete', completed); assert.equal(completed?.data?.session?.state, 'STOPPED') }
      if (command === 'quit') { assert.ok(store.list().every(record => ['STOPPED', 'FAILED'].includes(record.state))); if (diagnosticTimer) clearInterval(diagnosticTimer); for (const item of diagnosticWatchers.values()) item.close(); watcher.close(); await ui.close(); await new Promise(resolve => server.close(resolve)); continuum.dispose(); catalogStore.close(); uiWindow?.destroy(); window.destroy(); app.exit(0); break }
    } catch (error) { save('command-error', { success: false, code: error.message }); console.error(error.stack) }
  }
}
