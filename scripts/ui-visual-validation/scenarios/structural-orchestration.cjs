const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync, build, transformSync } = require('esbuild')
exports.run = async ctx => {
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export {GitService} from './src/main/core/git-service'; export {GitOperationsService} from './src/main/git-operations/git-operations-service'; export {GitHubGitTransport} from './src/main/github/github-git-transport'; export {WorkOrchestrationController,registerWorkOrchestrationHandlers} from './src/main/ipc/work-orchestration-handler'; export {WorkOrchestrationService} from './src/main/work-orchestration/work-orchestration-service'; export {WorktreeContractNavigation} from './src/main/core/context/worktree-contract-navigation'; export {RuntimeIdentityProvider} from './src/main/runtime-identity/runtime-identity-provider'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', packages: 'external' })
  const api = require(backend), identity = new api.RuntimeIdentityProvider({ rootDir: ctx.projectRoot, includedDirectories: ['src/main', 'src/shared', 'src/renderer/src'] })
  await identity.sourceOriginReady
  const runtime = identity.getIdentityPayload()
  ctx.check('Implementation worktree and source freshness MATCH', runtime.sourceOrigin.worktree.rootPath.toLowerCase() === ctx.projectRoot.toLowerCase() && runtime.freshness.state === 'MATCH')
  const root = path.join(ctx.temporary, 'repository'); fs.mkdirSync(root)
  const git = (cwd, args) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); if (result.status) throw new Error(result.stderr); return result.stdout.trim() }
  git(root, ['init', '-b', 'reference']); git(root, ['config', 'user.name', 'Acceptance']); git(root, ['config', 'user.email', 'acceptance@example.test'])
  const initial = { 'service.ts': 'export function service(value: number): number { return value + 1 }\n', 'consumer.ts': 'import { service } from "./service"\nexport function consume(): number { return service(1) }\n', 'other.ts': 'export function service(value: number): number { return value - 1 }\n', 'control.ts': 'import { service } from "./other"\nexport function consume(): number { return service(1) }\n' }
  for (const [file, text] of Object.entries(initial)) fs.writeFileSync(path.join(root, file), text)
  git(root, ['add', '.']); git(root, ['commit', '-m', 'base']); const base = git(root, ['rev-parse', 'HEAD'])
  const a = path.join(ctx.temporary, 'provider'), b = path.join(ctx.temporary, 'old-consumer'), c = path.join(ctx.temporary, 'unknown-control')
  git(root, ['worktree', 'add', '-b', 'contract-provider', a]); git(root, ['worktree', 'add', '-b', 'older-consumer', b]); git(root, ['worktree', 'add', '--detach', c])
  fs.writeFileSync(path.join(a, 'service.ts'), 'export function service(value: string): string { return value + "!" }\n'); git(a, ['add', 'service.ts']); git(a, ['commit', '-m', 'contract signature'])
  fs.writeFileSync(path.join(b, 'consumer.ts'), initial['consumer.ts'].replace('service(1)', 'service(2) + 1')); git(b, ['add', 'consumer.ts']); fs.writeFileSync(path.join(b, 'consumer.ts'), initial['consumer.ts'].replace('service(1)', 'service(3) + 1'))
  fs.writeFileSync(path.join(c, 'control.ts'), initial['control.ts'].replace('service(1)', 'service(4) + 1'))
  const serviceGit = new api.GitService()
  const birth = (directory, instant) => {
    if (!path.resolve(directory).startsWith(path.resolve(ctx.temporary) + path.sep)) throw new Error('Birth fixture outside isolated root')
    const command = `[System.IO.Directory]::SetCreationTimeUtc('${directory.replaceAll("'", "''")}', [DateTime]::Parse('${instant}').ToUniversalTime())`
    const result = spawnSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true }); if (result.status) throw new Error(result.stderr)
  }
  birth(b, '2024-01-01T12:00:00Z'); birth(await serviceGit.getWorktreeDirectory(b), '2024-01-01T12:00:00Z'); birth(c, '2023-01-01T12:00:00Z')
  const state = { revision: 1, project: { id: 'structural-acceptance', path: root, name: 'Evolução 2 — Git real e datas de fixture' } }
  const reader = new api.GitOperationsService(root, serviceGit, new api.GitHubGitTransport(null, serviceGit), { repositoryId: 'structural-repository', isActive: () => state.project?.id === 'structural-acceptance' })
  const notifications = [], reads = [], counters = { git: 0, mutations: 0 }, originalGit = serviceGit.runGitBytes.bind(serviceGit)
  serviceGit.runGitBytes = (...args) => { counters.git++; if (['add', 'commit', 'checkout', 'reset', 'merge', 'rebase', 'push', 'update-ref'].includes(args[0][0])) counters.mutations++; return originalGit(...args) }
  const oldSource = spawnSync('git', ['show', 'ea88dff72bd4a1283ecc7557896b01aca12edc15:src/main/work-orchestration/work-orchestration-service.ts'], { cwd: ctx.projectRoot, encoding: 'utf8', windowsHide: true })
  if (oldSource.status) throw new Error(oldSource.stderr)
  const oldModule = { exports: {} }, baselineRequire = name => name === './worktree-document-context' ? { readWorktreeDocumentContext: () => { throw new Error('Document context is outside the inventory baseline') } } : require(name)
  new Function('require','module','exports',transformSync(oldSource.stdout,{loader:'ts',format:'cjs'}).code)(baselineRequire,oldModule,oldModule.exports)
  const baseline = new oldModule.exports.WorkOrchestrationService(reader), current = new api.WorkOrchestrationService(reader)
  let mark = performance.now(), callMark = counters.git; await baseline.inventory(); const beforeInventory = { ms: performance.now() - mark, gitCalls: counters.git - callMark }
  mark = performance.now(); callMark = counters.git; await current.inventory(); const afterInventory = { ms: performance.now() - mark, gitCalls: counters.git - callMark }
  const controller = new api.WorkOrchestrationController({ getState: () => state }, change => { notifications.push({ at: performance.now(), attention: change.attention }); ctx.window.webContents.send('work-orchestration:changed', change) })
  controller.bind(reader, undefined, new api.WorktreeContractNavigation(reader))
  const { ipcMain } = require('electron'), originalHandle = ipcMain.handle
  ipcMain.handle = function(channel, handler) { originalHandle.call(this, channel, (...args) => { if (channel === 'work-orchestration:read') reads.push(args[1]); return handler(...args) }) }
  api.registerWorkOrchestrationHandlers(controller); ipcMain.handle = originalHandle
  ipcMain.handle('project:get-active', () => state); ipcMain.handle('deeplink:get-pending', () => null); ipcMain.handle('load-settings', () => ({ projectPreferences: {} }))
  const wait = async (fn, ...args) => { const deadline = Date.now() + 150000; while (Date.now() < deadline) { if (await ctx.evaluate(fn, ...args)) return; await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error('Structural UI state deadline: ' + String(fn)) }
  const navigate = async label => { await ctx.evaluate(label => { document.querySelector('[data-nav-target]')?.removeAttribute('data-nav-target'); [...document.querySelectorAll('.global-sidebar-nav-item')].find(button => button.querySelector('.global-sidebar-nav-label')?.textContent === label).setAttribute('data-nav-target', '') }, label); await ctx.click('[data-nav-target]') }
  const order = () => [...document.querySelectorAll('.wo-tree')].map(row => row.dataset.worktreeId)
  const errors = []; ctx.window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message) })
  try {
    const preload = path.join(ctx.temporary, 'preload.cjs'); buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', format: 'cjs', external: ['electron'] }); ctx.window.webContents.session.setPreloads([preload])
    const plugin = { name: 'unrelated-views', setup(build) {
      build.onResolve({ filter: /components\// }, args => { if (!args.importer.endsWith(`${path.sep}App.tsx`) || /WorkOrchestrationView/.test(args.path)) return; return { path: args.path.split('/').pop(), namespace: 'fixture' } })
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => args.path === 'GlobalSidebar' ? { contents: `import React from 'react'; import {GlobalSidebarNav} from ${JSON.stringify(path.join(ctx.projectRoot, 'src/renderer/src/components/GlobalSidebar/GlobalSidebarNav'))}; import {NAV_ITEMS} from ${JSON.stringify(path.join(ctx.projectRoot, 'src/renderer/src/config/navigation'))}; export const GlobalSidebar = p => React.createElement('aside',{className:'global-sidebar sidebar-open'},React.createElement(GlobalSidebarNav,{items:NAV_ITEMS,activeTab:p.activeTab,onSelect:p.setActiveTab,isSidebarOpen:true,orchestrationAlerts:p.orchestrationAlerts}));`, resolveDir: ctx.projectRoot } : { contents: `import React from 'react'; export const ${args.path} = () => React.createElement('section',{'data-fixture-panel':${JSON.stringify(args.path)}},${JSON.stringify(args.path)});`, resolveDir: ctx.projectRoot })
    } }
    await build({ entryPoints: [path.join(__dirname, 'shell-navigation-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', plugins: [plugin], define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } })
    const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(fs.readFileSync(path.join(ctx.projectRoot, 'src/renderer/index.html'), 'utf8'))[1], page = path.join(ctx.temporary, 'index.html')
    fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
    const started = performance.now(), before = await Promise.all([root, a, b, c].map(p => serviceGit.captureWorktreeReadSnapshot(p)))
    await ctx.load(page); await ctx.viewport(1440, 900)
    await wait(() => document.querySelector('.orchestration-alert-badge')?.textContent === '1')
    const alertMs = performance.now() - started, line = controller.workline
    ctx.check('Alert discovered automatically while Home is active', await ctx.evaluate(() => !document.querySelector('.wo-view') && document.querySelector('[data-fixture-panel="HomeView"]')))
    ctx.check('No manual pair triggered discovery', reads.every(r => !r.pair))
    ctx.check('One direct alert, no homonym control alert', line.snapshot().alerts.length === 1 && line.snapshot().alerts[0].evidence[0].consumerPath === 'consumer.ts')
    await ctx.capture('proactive-badge-dark')
    const inventoryStarted = performance.now(); await navigate('Work Orchestration'); await wait(() => document.querySelectorAll('.wo-tree').length === 4 && !document.querySelector('.wo-header button').disabled)
    const inventoryMs = performance.now() - inventoryStarted, originalOrder = await ctx.evaluate(order), inventory = await controller.active.service.inventory(), aRecord = inventory.worktrees.find(w => w.path === a), bRecord = inventory.worktrees.find(w => w.path === b), cRecord = inventory.worktrees.find(w => w.path === c)
    ctx.check('Actual birthtime yields an old estimate and a separate unknown restored fixture', bRecord.creation?.at?.startsWith('2024-01-01') && cRecord.creation?.quality === 'UNKNOWN')
    ctx.check('Chronology keeps reference, recent, old and unknown positions', originalOrder[1] === aRecord.worktreeId && originalOrder[2] === bRecord.worktreeId && originalOrder[3] === cRecord.worktreeId)
    await wait(() => document.querySelector('.wo-toolbar')?.textContent.includes('Inventário completo · 4') && document.querySelectorAll('.wo-tree').length === 4 && !document.querySelector('.wo-header button').disabled)
    await new Promise(resolve => setTimeout(resolve, 300)); await ctx.capture('chronological-attention-dark'); await ctx.overflow()
    await ctx.evaluate(() => { const button = [...document.querySelectorAll('.wo-attention button')].find(b => b.textContent === 'Ver evidência'); button.setAttribute('data-evidence-target','') }); await ctx.click('[data-evidence-target]')
    await wait(() => !!document.querySelector('[aria-label="Evidência de interferência estrutural"]'))
    ctx.check('Evidence is already discovered, anchored to old consumer and exact common base', await ctx.evaluate((id, base) => document.querySelector(`[data-worktree-id="${id}"]`).getAttribute('aria-pressed') === 'true' && document.querySelector('.wo-structural-evidence').textContent.includes(base), bRecord.worktreeId, base))
    ctx.check('Evidence navigation preserves chronological order', JSON.stringify(await ctx.evaluate(order)) === JSON.stringify(originalOrder))
    await ctx.capture('direct-contract-evidence-dark')
    await navigate('Home'); controller.pause(true)
    while (line.running || controller.active.service.pendingSnapshots.size || controller.active.service.readers) await new Promise(resolve => setTimeout(resolve, 100))
    const pausedCalls = counters.git; await new Promise(resolve => setTimeout(resolve, 1200))
    ctx.check('Suspension finishes in-flight work and starts zero new Git reads', counters.git === pausedCalls)
    ctx.check('Suspension invalidates evidence without deleting it', line.snapshot().alerts[0].state === 'STALE')
    await navigate('Work Orchestration'); await wait(() => document.querySelector('.wo-attention').textContent.includes('reconciliação suspensa'))
    await ctx.evaluate(() => { document.body.dataset.theme = 'light'; document.querySelector('.wo-inspector').scrollTop = 0 }); await ctx.viewport(1120, 800)
    await ctx.capture('stale-evidence-medium-light'); await ctx.overflow()
    await ctx.evaluate(() => document.querySelector('[aria-label="Fechar inspetor"]').click())
    ctx.check('Read-only pipeline preserves real Git snapshots', JSON.stringify(before) === JSON.stringify(await Promise.all([root, a, b, c].map(p => serviceGit.captureWorktreeReadSnapshot(p)))) && counters.mutations === 0)
    git(a, ['checkout', '--detach', base]); const afterFixtureMutation = await Promise.all([root, a, b, c].map(p => serviceGit.captureWorktreeReadSnapshot(p)))
    controller.pause(false); await line.runOnce(); await navigate('Home'); await navigate('Work Orchestration')
    await wait(() => document.querySelector('.wo-attention').textContent.includes('obsoleta'))
    ctx.check('HEAD drift retains a stale alert and does not move worktrees', line.snapshot().alerts[0].state === 'STALE' && JSON.stringify(await ctx.evaluate(order)) === JSON.stringify(originalOrder))
    await ctx.capture('stable-timeline-medium-light')
    ctx.check('No read mutation after the explicit fixture HEAD change', JSON.stringify(afterFixtureMutation) === JSON.stringify(await Promise.all([root, a, b, c].map(p => serviceGit.captureWorktreeReadSnapshot(p)))) && counters.mutations === 0)
    ctx.check('Source freshness remains MATCH', identity.getIdentityPayload().freshness.state === 'MATCH')
    ctx.check('No renderer errors', errors.length === 0)
    fs.writeFileSync(path.join(ctx.evidenceDir, 'structural-measurements.json'), JSON.stringify({ scope: 'Actual App/hook/nav, production IPC/controller/Workline/extraction/resolution and real isolated Git; unrelated views stubbed; directory birthtimes controlled before registry discovery; inventory baseline/current services on the same current Git/registry port', runtime, beforeInventory, afterInventory, alertMs, inventoryMs, counters, beforeOrder: originalOrder, afterOrder: await ctx.evaluate(order), notifications, reads, state: line.snapshot() }, null, 2))
  } catch (error) {
    fs.writeFileSync(path.join(ctx.evidenceDir, 'failure-state.json'), JSON.stringify({ error: error.message, state: controller.workline?.snapshot(), notifications, reads, errors, dom: await ctx.evaluate(() => document.body.textContent.slice(0, 5000)) }, null, 2))
    await ctx.capture('failure-state'); throw error
  } finally { controller.deactivate(); for (const channel of ['work-orchestration:read','project:get-active','deeplink:get-pending','load-settings']) ipcMain.removeHandler(channel) }
}
