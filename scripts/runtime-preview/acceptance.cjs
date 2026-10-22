const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const { randomUUID, createHash } = require('node:crypto')
const { createInterface } = require('node:readline')
const { execFileSync } = require('node:child_process')
const { build } = require('./build.cjs')
const root = process.cwd(), kind = process.argv[2]
if (!['web', 'node-web', 'electron'].includes(kind)) throw new Error('INVALID_ACCEPTANCE_KIND')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-preview-u3-'))
const bundle = path.join(root, '.code-awareness/u3/bundle')
const entries = ['work-orchestration/runtime-preview/runner', 'work-orchestration/runtime-preview/session-store', 'work-orchestration/preview-profile-store', 'work-orchestration/preview-preflight', 'work-orchestration/preview-repositories', 'core/git-service', 'git-operations/git-operations-service', 'github/github-git-transport', 'repository-catalog/repository-catalog-service']
require('esbuild').buildSync({ entryPoints: entries.map(p => 'src/main/' + p + '.ts'), outdir: bundle, platform: 'node', format: 'cjs', bundle: true, packages: 'external', logLevel: 'silent' })
const get = name => require(path.join(bundle, name + '.js'))
async function main() {
  let target = root, repositoryRoot = root, repositoryId = 'e1c8a999-6d73-4f56-83a3-fbcd78c9c19d'
  const nodeWeb = kind === 'node-web'
  if (nodeWeb) {
    repositoryRoot = path.join(directory, 'managed-web-base'); target = path.join(directory, 'managed-web-feature'); repositoryId = randomUUID()
    fs.mkdirSync(path.join(repositoryRoot, 'runtime'), { recursive: true }); fs.mkdirSync(path.join(repositoryRoot, 'app'))
    for (const file of ['launch.cjs', 'cooperation.cjs']) fs.copyFileSync(path.join(root, 'scripts/runtime-preview', file), path.join(repositoryRoot, 'runtime', file))
    for (const file of ['index.html', 'feature.js']) fs.copyFileSync(path.join(root, 'scripts/runtime-preview/fixtures/web', file), path.join(repositoryRoot, 'app', file))
    fs.writeFileSync(path.join(repositoryRoot, 'package.json'), JSON.stringify({ name: 'managed-runtime-preview-web', version: '1.0.0', private: true }))
    fs.writeFileSync(path.join(repositoryRoot, 'package-lock.json'), JSON.stringify({ name: 'managed-runtime-preview-web', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'managed-runtime-preview-web', version: '1.0.0' } } }))
    const git = args => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: repositoryRoot, stdio: 'pipe', windowsHide: true })
    git(['init', '-b', 'main']); git(['config', 'core.autocrlf', 'false']); git(['add', '.']); git(['-c', 'user.name=Runtime Preview Acceptance', '-c', 'user.email=runtime-preview@example.invalid', 'commit', '-m', 'Controlled managed Web application'])
    git(['worktree', 'add', '-b', 'feature/runtime-preview', target])
  }
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)) }) })
  const { GitService } = get('core/git-service'), { GitOperationsService } = get('git-operations/git-operations-service'), { GitHubGitTransport } = get('github/github-git-transport')
  const git = new GitService()
  const record = { id: repositoryId, name: nodeWeb ? 'Managed Web acceptance' : 'Code Awareness acceptance', status: 'ACTIVE', updatedAt: 'u3', localCheckout: { path: repositoryRoot, availability: 'AVAILABLE', gitState: 'GIT' } }
  const { RepositoryCatalogService } = get('repository-catalog/repository-catalog-service')
  const catalog = new RepositoryCatalogService({ get(id) { if (id !== repositoryId) throw new Error('REPOSITORY_NOT_FOUND'); return record } }, {})
  const { PreviewRepositories } = get('work-orchestration/preview-repositories')
  const repositories = new PreviewRepositories(catalog, (p, identity) => new GitOperationsService(p, git, new GitHubGitTransport(null, git), identity, true))
  const context = await repositories.open(repositoryId)
  const selected = context.worktrees.find(w => path.resolve(w.path).toLowerCase() === target.toLowerCase())
  if (!selected) throw new Error('WORKTREE_UNAVAILABLE')
  const isElectron = kind === 'electron'
  const sdkRelative = nodeWeb ? 'runtime/' : 'scripts/runtime-preview/'
  const configFile = isElectron ? 'electron.vite.config.ts' : nodeWeb ? 'package.json' : 'scripts/runtime-preview/web.config.cjs'
  const fixed = [sdkRelative + 'launch.cjs', sdkRelative + 'cooperation.cjs', configFile]
  if (isElectron) fixed.push('scripts/runtime-preview/build-identity.cjs')
  const profile = { schemaVersion: 1, profileId: 'u3-' + kind, revision: 1, repositoryId,
    runtime: isElectron ? 'ELECTRON_DEV' : 'WEB_DEV_SERVER', runtimeVersion: isElectron ? '32.0.0' : process.versions.node,
    command: { executable: process.execPath, executableHash: hash(fs.readFileSync(process.execPath)), args: [sdkRelative + 'launch.cjs'], cwd: '.', inputs: fixed.map(file => ({ path: file, fingerprint: hash(fs.readFileSync(path.join(target, file))) })) }, env: {},
    resources: [{ name: 'runtime', strategy: 'SESSION_DIRECTORY' }, { name: 'http-hmr', strategy: 'SESSION_ENDPOINT' }],
    dependencies: { packageManager: 'npm', packageManagerVersion: '10.9.4', manifest: 'package.json', lockfile: 'package-lock.json', manifestHash: hash(fs.readFileSync(path.join(target, 'package.json'))), lockfileHash: hash(fs.readFileSync(path.join(target, 'package-lock.json'))), abi: isElectron ? '128' : process.versions.modules, materialization: '.code-awareness/u3/materialization-unverified.json' },
    cooperation: { manifest: sdkRelative + 'cooperation.cjs', fingerprint: hash(fs.readFileSync(path.join(target, sdkRelative, 'cooperation.cjs'))) },
    adapter: { version: 1, kind: isElectron ? 'ELECTRON' : nodeWeb ? 'NODE_WEB' : 'VITE_WEB', port, configFile,
      ...(isElectron ? { runtimeExecutable: 'node_modules/electron/dist/electron.exe', runtimeExecutableHash: hash(fs.readFileSync('node_modules/electron/dist/electron.exe')) } : {}),
      nativeModules: isElectron ? ['better-sqlite3', 'electron', 'esbuild', 'tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript'] : nodeWeb ? [] : ['esbuild'],
      artifacts: isElectron ? [{ component: 'ELECTRON_MAIN', path: 'src/main/main.ts' }, { component: 'ELECTRON_PRELOAD', path: 'src/main/preload.ts' }, { component: 'ELECTRON_RENDERER', path: 'src/renderer/src/App.tsx' }] : [{ component: 'WEB', path: nodeWeb ? 'app/feature.js' : 'scripts/runtime-preview/fixtures/web/feature.js' }] },
    security: { mode: 'profile_only', requirements: [] }, network: { destinations: [`http://127.0.0.1:${port}`], openNetworkConsent: false, credentials: 'TARGET_OWN_TEST_PROFILE' },
    probes: { readiness: { kind: 'HTTP', address: `http://127.0.0.1:${port}/`, timeoutMs: 120000 }, liveness: 'READINESS', attestation: 'COOPERATIVE_LOADED_ARTIFACT' },
    shutdown: { spawn: 'JOB_LIST_AT_CREATE', breakaway: false, killOnJobClose: true, graceMs: 0, forceMs: 10000 } }
  if (process.argv.includes('--wrong-abi')) profile.dependencies.abi = '999'
  let collision
  if (process.argv.includes('--port-collision')) {
    collision = net.createServer(connection => connection.end('external-sibling'))
    await new Promise((accept, reject) => { collision.once('error', reject); collision.listen(port, '127.0.0.1', accept) })
  }
  const profileDirectory = path.join(directory, 'profiles'); fs.mkdirSync(profileDirectory)
  fs.writeFileSync(path.join(profileDirectory, 'profiles.json'), JSON.stringify([profile]))
  const { PreviewProfileStore } = get('work-orchestration/preview-profile-store'), { PreviewPreflightService } = get('work-orchestration/preview-preflight')
  const profiles = new PreviewProfileStore(profileDirectory)
  const canonical = (await profiles.profiles(repositoryId))[0]
  await profiles.approve(canonical, async () => true)
  const selection = { repositoryId, worktreeId: selected.worktreeId, generation: selected.generation, profileId: profile.profileId, fingerprint: hash(JSON.stringify(canonical)) }
  const { RuntimePreviewRunner, CatalogPreviewLaunchAuthority } = get('work-orchestration/runtime-preview/runner')
  const { PreviewSessionStore } = get('work-orchestration/runtime-preview/session-store')
  const nativeBuild = build(process.argv.includes('--faults')), binary = nativeBuild.owner, store = new PreviewSessionStore(path.join(directory, 'sessions'))
  const runner = new RuntimePreviewRunner(store, new CatalogPreviewLaunchAuthority(repositories, profiles, new PreviewPreflightService(profiles)), { executable: binary, fingerprint: nativeBuild.fingerprint, sdkDirectory: path.join(root, 'scripts/runtime-preview') })
  const session = await runner.start({ operationId: randomUUID(), selection })
  const output = path.join(root, '.code-awareness/u3/' + kind + '-latest.json')
  const save = result => { fs.writeFileSync(output, JSON.stringify({ directory, target, repositoryRoot, port, ...result }, null, 2)); console.log(JSON.stringify({ directory, target, port, state: result.session.state, readiness: result.session.readiness, failure: result.session.failure, attestation: result.session.attestation })) }
  save({ session })
  if (collision) { console.log(JSON.stringify({ externalListenerPreserved: collision.listening })); await new Promise(resolve => collision.close(resolve)) }
  if (session.state !== 'RUNNING') { process.exitCode = 1; return }
  const commands = createInterface({ input: process.stdin })
  for await (const command of commands) {
    if (command === 'wrong-source' && isElectron) {
      const file = path.join(store.runtime(session.sessionId), 'electron-evidence.json'), original = fs.readFileSync(file)
      const wrong = JSON.parse(original); wrong.sessionId = randomUUID(); fs.writeFileSync(file, JSON.stringify(wrong))
      save({ session: await runner.inspect(session.sessionId) }); fs.writeFileSync(file, original)
    }
    if (command === 'crash-renderer' && process.argv.includes('--faults')) {
      const native = runner.owners.get(session.sessionId), members = (await native.processes()).processes
      const e = JSON.parse(fs.readFileSync(path.join(store.runtime(session.sessionId), 'electron-evidence.json')))
      const target = members.find(m => m.pid === e.rendererPid)
      if (!target) throw new Error('RENDERER_OWNERSHIP_UNVERIFIED')
      await native.request('crash-member', target)
      console.log('OWNED_RENDERER_CRASH_INJECTED')
    }
    if (command === 'inspect') save({ session: await runner.inspect(session.sessionId) })
    if (command === 'exhaust-receipts') {
      let record = store.read(session.sessionId)
      while (record.revision < 224) { record = { ...record, revision: record.revision + 1 }; store.append(record) }
      const exhausted = await runner.inspect(session.sessionId)
      save({ session: exhausted })
      if (exhausted.readiness === 'READY' || exhausted.attestation.loadedCode === 'VERIFIED') throw new Error('STALE_ATTESTATION_REUSED')
      commands.close(); break
    }
    if (command === 'recovery-collision') {
      const native = runner.owners.get(session.sessionId)
      await native.stop(0, 10000, false); await native.shutdown()
      const listener = net.createServer()
      await new Promise((accept, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', accept) })
      const recovered = new RuntimePreviewRunner(new PreviewSessionStore(store.root), {}, { executable: binary, fingerprint: hash(fs.readFileSync(binary)) })
      const blocked = await recovered.inspect(session.sessionId)
      fs.writeFileSync(path.join(root, '.code-awareness/u3/recovery-endpoint-blocked.json'), JSON.stringify({ port, externalListenerPreserved: listener.listening, session: blocked }, null, 2))
      if (blocked.state !== 'CLEANUP_INCOMPLETE' || !listener.listening) throw new Error('RECOVERY_FALSE_STOPPED')
      await new Promise(resolve => listener.close(resolve))
      const finished = await recovered.inspect(session.sessionId)
      save({ session: finished })
      if (finished.state !== 'STOPPED') throw new Error('RECOVERY_NOT_COMPLETED')
      commands.close(); break
    }
    if (command === 'stop') { save({ session: await runner.stop(session.sessionId) }); commands.close(); break }
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
