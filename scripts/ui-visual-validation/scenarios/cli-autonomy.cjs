const fs = require('node:fs'), path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { buildSync } = require('esbuild')

exports.run = async ctx => {
  const { ipcMain } = require('electron')
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export {SettingsService} from './src/main/core/settings-service'; export {CliTrustPolicy} from './src/main/cli-execution/cli-trust-policy'; export {confirmCliAutonomy,confirmCliExecution} from './src/main/cli-execution/cli-authorization'; export {registerCliPolicyHandlers} from './src/main/ipc/cli-policy-handler'; export {CliExecutionService} from './src/main/cli-execution/cli-execution-service'; export {executeCliTool} from './src/main/cli-execution/cli-execution-mcp'; export {GitService} from './src/main/core/git-service'; export {createCliProjectAuthority} from './src/main/cli-execution/cli-project-authority'", resolveDir: ctx.projectRoot }, outfile: backend, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
  const api = require(backend)
  const root = path.join(ctx.temporary, 'repository'); fs.mkdirSync(root)
  execFileSync('git', ['-c', 'core.fsmonitor=false', 'init', '-q', root], { windowsHide: true, timeout: 10000 })
  execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), '-c', 'user.name=CLI Fixture', '-c', 'user.email=cli@example.test', 'commit', '--allow-empty', '-qm', 'fixture'], { windowsHide: true, timeout: 10000 })
  const settings = new api.SettingsService(), git = new api.GitService()
  const selection = { revision: 1, project: { id: 'cli-fixture', path: root } }
  let initialDialogs = 0, commandDialogs = 0, stateRevision = 1
  const nativeDecision = async (decide, required, button) => {
    ctx.window.showInactive()
    const native = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'cli-autonomy-dialog.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const handle = ctx.window.getNativeWindowHandle()
    const owner = (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString()
    let output = '', errors = ''
    native.stdout.on('data', bytes => { output += bytes }); native.stderr.on('data', bytes => { errors += bytes })
    const done = new Promise((resolve, reject) => { native.once('error', reject); native.once('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error('Native consent: ' + output + errors))) })
    native.stdin.end(JSON.stringify({ processId: process.pid, owner, required, button }))
    try {
      const [accepted, proof] = await Promise.all([decide(), done])
      ctx.check('Native consent verifies exact owner and complete requested disclosure', proof.ownerVerified && proof.disclosureVerified && accepted)
      return accepted
    } finally { if (native.exitCode === null) native.kill() }
  }
  const policy = new api.CliTrustPolicy(settings, () => ({ repositoryId: 'cli-fixture', path: root, revision: selection.revision }), async (mode, context) => {
    initialDialogs++
    return nativeDecision(() => api.confirmCliAutonomy(ctx.window, mode, context), ['NÃO é sandbox', 'conta Windows', 'cliente autenticado', 'prompt injection', context.repositoryId], 'Autorizar este modo')
  })
  const service = new api.CliExecutionService({ repoRoot: root, repositoryId: 'cli-fixture', enabledByDefault: false,
    ownerPath: require(path.join(ctx.projectRoot, 'scripts/cli-execution/build.cjs')).ensureProduction(ctx.projectRoot).executable,
    getPolicy: () => policy.getPolicy({ repositoryId: 'cli-fixture', path: root }),
    getFingerprint: api.createCliProjectAuthority({ selection, getSelection: () => selection, findRepository: () => ({ id: 'cli-fixture', localCheckout: { path: root, availability: 'AVAILABLE', gitState: 'GIT' } }), captureGitIdentity: async selected => { const snapshot = await git.captureWorktreeReadSnapshot(selected); return { head: snapshot.head, branch: snapshot.branch } } }),
    approvalHandler: request => {
      commandDialogs++
      return nativeDecision(() => api.confirmCliExecution(ctx.window, request), [request.manifestHash, ...request.commands.map((_, index) => `Comando ${index + 1}`), JSON.stringify(['--version']), 'NÃO confina'], 'Autorizar e executar')
    }
  })
  const counters = { activeRequests: 0, peakConcurrentRequests: 0, totalRequests: 0, succeededRequests: 0, failedRequests: 0, timedOutRequests: 0, latency: { completedRequests: 0, totalDurationMs: 0, lastDurationMs: null, maxDurationMs: null } }
  const state = () => ({ revision: stateRevision, availability: 'READY', remoteAccessEnabled: true, cliExecutionEnabled: settings.loadSettings().cliExecutionEnabled, cliMode: policy.getPolicy().mode, transport: 'relay', connectionStatus: 'CONNECTED', mcpStatus: 'RUNNING', activeProject: { id: 'cli-fixture', name: 'CLI validation repository' }, installationConfigured: true, lastError: null, functionalHealth: { status: 'UNKNOWN' }, activity: { ...counters, byTool: {}, byCapability: {} } })
  settings.onChanged(() => { service.setEnabled(settings.loadSettings().cliExecutionEnabled); service.refreshPolicy(); stateRevision++; ctx.window.webContents.send('channel:changed', state()) })
  api.registerCliPolicyHandlers(policy, () => ctx.window, () => service)
  ipcMain.handle('channel:get-state', () => state())
  ipcMain.handle('load-settings', () => settings.loadSettings())
  ipcMain.handle('save-settings', (_event, value) => { settings.saveSettings(value); return { success: true } })
  ipcMain.handle('local-mcp:snapshot', () => ({ revision: 1, restoration: 'READY', installations: [] }))
  ipcMain.handle('cli-validation:call', (_event, name, args) => api.executeCliTool(service, name, args))
  const preload = path.join(ctx.temporary, 'preload.cjs'), page = path.join(ctx.temporary, 'index.html')
  buildSync({ stdin: { contents: "import './src/main/preload'; import {contextBridge,ipcRenderer} from 'electron'; contextBridge.exposeInMainWorld('cliValidation',{call:(name,args)=>ipcRenderer.invoke('cli-validation:call',name,args)});", resolveDir: ctx.projectRoot }, outfile: preload, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  ctx.window.webContents.session.setPreloads([preload])
  buildSync({ entryPoints: [path.join(__dirname, 'cli-autonomy-fixture.tsx')], outfile: path.join(ctx.temporary, 'fixture.js'), bundle: true, platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'silent' })
  fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  const call = async (name, args) => { const result = await ctx.evaluate((name, args) => window.cliValidation.call(name, args), name, args); if (result.isError) throw new Error(result.content[0].text); return JSON.parse(result.content[0].text) }
  const waitTerminal = async (tool, operationId) => { const deadline = Date.now() + 15000; while (Date.now() < deadline) { const result = await call(tool, { operationId }); if (result.phase === 'TERMINAL') return result; await new Promise(resolve => setTimeout(resolve, 50)) } throw new Error('Execution did not terminate') }
  try {
    await ctx.load(page)
    await ctx.waitFor(() => !!document.querySelector('#cli-mode'))
    ctx.check('Fresh profile is OFF and cannot choose autonomy', await ctx.evaluate(() => document.querySelector('#cli-mode').disabled))
    await ctx.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Ativar execução CLI').click())
    await ctx.waitFor(() => !document.querySelector('#cli-mode').disabled)
    await ctx.evaluate(() => { const select = document.querySelector('#cli-mode'); select.value = 'AUTONOMOUS_TRUSTED'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    const grantDeadline = Date.now() + 20000
    while (policy.getPolicy().mode !== 'AUTONOMOUS_TRUSTED' && Date.now() < grantDeadline) await new Promise(resolve => setTimeout(resolve, 80))
    ctx.check('Local native decision persists repository-specific trust', policy.getPolicy().mode === 'AUTONOMOUS_TRUSTED' && new api.CliTrustPolicy(new api.SettingsService(), () => ({ repositoryId: 'cli-fixture', path: root, revision: 1 }), async () => false).getPolicy().mode === 'AUTONOMOUS_TRUSTED')
    await ctx.waitFor(() => document.querySelector('#cli-mode').value === 'AUTONOMOUS_TRUSTED' && !document.querySelector('#cli-mode').disabled)
    await ctx.evaluate(() => document.querySelector('#cli-autonomy-title').closest('section').scrollIntoView({ block: 'start' }))
    await ctx.capture('cli-trusted-desktop')
    for (const [index, executable] of ['node.exe', 'hostname.exe', 'whoami.exe'].entries()) {
      const proposal = await call('prepare_cli_execution', { executable, args: index ? [] : ['--version'] })
      await call('start_cli_execution', { proposalId: proposal.proposalId, operationId: `query-${index}` })
      ctx.check(`Real query ${index + 1} succeeds under Windows supervision`, (await waitTerminal('get_cli_execution', `query-${index}`)).status === 'SUCCEEDED')
    }
    const manifest = await call('prepare_cli_investigation', { commands: [{ executable: 'node.exe', args: ['--version'] }, { executable: 'hostname.exe', args: [] }, { executable: 'whoami.exe', args: [] }] })
    await call('start_cli_investigation', { proposalId: manifest.proposalId, operationId: 'batch' })
    const batchDeadline = Date.now() + 15000
    while (service.getInvestigation({ operationId: 'batch' }).phase !== 'TERMINAL' && Date.now() < batchDeadline) await new Promise(resolve => setTimeout(resolve, 50))
    const aggregate = await call('get_cli_investigation', { operationId: 'batch' })
    ctx.check('Batch completes with prepare/start/get and no aggregate output', aggregate.status === 'SUCCEEDED' && aggregate.steps.length === 3 && aggregate.steps.every(step => step.status === 'SUCCEEDED') && !JSON.stringify(aggregate).match(/stdout|stderr/))
    ctx.check('Initial native decision replaces all per-command and per-batch dialogs', initialDialogs === 1 && commandDialogs === 0)
    const trustedCommandDialogs = commandDialogs
    const running = await call('prepare_cli_execution', { executable: 'node.exe', args: ['-e', 'setInterval(()=>{},1000)'] })
    await call('start_cli_execution', { proposalId: running.proposalId, operationId: 'interactive' })
    const runDeadline = Date.now() + 8000
    while (service.get({ operationId: 'interactive' }).status !== 'RUNNING' && Date.now() < runDeadline) await new Promise(resolve => setTimeout(resolve, 50))
    ctx.check('Long command is RUNNING during interaction proof', service.get({ operationId: 'interactive' }).status === 'RUNNING')
    let maxIpcMs = 0
    for (let index = 0; index < 5; index++) {
      const elapsed = await ctx.evaluate(async () => { const started = performance.now(); await window.codeAwareness.getChannelState(); return performance.now() - started })
      maxIpcMs = Math.max(maxIpcMs, elapsed)
      await ctx.input('#interaction-probe', String(index))
    }
    ctx.check('Renderer input and essential IPC remain interactive during real command', maxIpcMs < 750 && await ctx.evaluate(() => document.querySelector('#interaction-probe').value === '01234'))
    await ctx.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Desativar autonomia').click())
    ctx.check('Local revocation cancels the active tree', (await waitTerminal('get_cli_execution', 'interactive')).status === 'CANCELLED' && !service.getActiveOperationId())
    await ctx.waitFor(() => document.querySelector('#cli-mode').value === 'SUPERVISED')
    const supervised = await call('prepare_cli_investigation', { commands: [{ executable: 'node.exe', args: ['--version'] }, { executable: 'hostname.exe', args: [] }] })
    await call('start_cli_investigation', { proposalId: supervised.proposalId, operationId: 'supervised' })
    const supervisedResult = await waitTerminal('get_cli_investigation', 'supervised')
    ctx.check('Supervised batch receives one real complete native manifest consent', supervisedResult.status === 'SUCCEEDED' && commandDialogs === 1)
    await ctx.viewport(460, 900)
    await ctx.evaluate(() => document.querySelector('#cli-autonomy-title').closest('section').scrollIntoView({ block: 'start' }))
    await ctx.capture('cli-supervised-narrow')
    await ctx.overflow()
    fs.writeFileSync(path.join(ctx.evidenceDir, 'cli-autonomy-proof.json'), JSON.stringify({ initialDialogs, trustedCommandDialogs, supervisedManifestDialogs: commandDialogs, unitQueries: 3, batchCommands: 3, batchCalls: 3, maxIpcMs, latencyBudgetMs: 750, revoked: true, nativeSupervisor: true, scope: 'Isolated Electron profile, real preload/IPC/settings/CLI service and native consent; Channel state is a fixture, not full application bootstrap' }, null, 2))
  } finally { await service.shutdown() }
}
