const fs = require('node:fs')
const path = require('node:path')
const { execFile, spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
exports.run = async ctx => {
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export { RepositoryCatalogStore } from './src/main/repository-catalog/repository-catalog-store'; export { RepositoryContinuumSession } from './src/main/continuum/project-continuum-session'; export { ContinuumLocalAdapter } from './src/main/continuum/local-adapter'; export { LocalChannelHost } from './src/main/local-agent-channel/local-channel-host'; export { registerContinuumHandlers } from './src/main/ipc/continuum-handler'; export { GitService } from './src/main/core/git-service'; export { GitOperationsService } from './src/main/git-operations/git-operations-service'; export { GitHubGitTransport } from './src/main/github/github-git-transport'; export { BranchOrchestrationController, registerBranchOrchestrationHandlers } from './src/main/ipc/branch-orchestration-handler'; export { RuntimeIdentityProvider } from './src/main/runtime-identity/runtime-identity-provider'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3', 'sharp', 'js-yaml'] })
  const { RepositoryCatalogStore, RepositoryContinuumSession, ContinuumLocalAdapter, LocalChannelHost, registerContinuumHandlers, GitService, GitOperationsService, GitHubGitTransport, BranchOrchestrationController, registerBranchOrchestrationHandlers, RuntimeIdentityProvider } = require(backend)
  const runtime = new RuntimeIdentityProvider({ rootDir: ctx.projectRoot, includedDirectories: ['src/main', 'src/shared', 'src/renderer/src'] }); await runtime.sourceOriginReady
  const identity = runtime.getIdentityPayload()
  fs.writeFileSync(path.join(ctx.evidenceDir, 'runtime-identity.json'), JSON.stringify(identity, null, 2))
  const git = (root, args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }); if (r.status) throw new Error(r.stderr); return r.stdout.trim() }
  ctx.check('Source worktree branch and runtime MATCH', identity.sourceOrigin.worktree.branch === 'codex/branch-pr-worktree-manager' && identity.sourceOrigin.worktree.head === git(ctx.projectRoot, ['rev-parse', 'HEAD']) && identity.sourceOrigin.worktree.rootPath.toLowerCase() === ctx.projectRoot.toLowerCase() && identity.freshness.state === 'MATCH')
  const root = path.join(ctx.temporary, 'repository'), topic = path.join(ctx.temporary, 'topic')
  fs.mkdirSync(root); git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Acceptance']); git(root, ['config', 'user.email', 'acceptance@example.invalid']); git(root, ['commit', '--allow-empty', '-m', 'base'])
  git(root, ['worktree', 'add', '-b', 'topic', topic])
  for (let i = 0; i < 19; i++) git(root, ['branch', `work-${String(i).padStart(3, '0')}`])
  const catalog = new RepositoryCatalogStore(path.join(ctx.temporary, 'catalog.db'))
  const { record } = catalog.upsertLocalCheckout({ path: root, normalizedPath: root.toLowerCase(), name: 'Reactive fixture', status: 'ACTIVE', availability: 'AVAILABLE', gitState: 'GIT' })
  const session = new RepositoryContinuumSession(path.join(ctx.temporary, 'continuum'), { findByPath: p => catalog.findByNormalizedPath(p.toLowerCase()) })
  session.activate(root)
  const continuum = session.getActiveService(), metadata = (name, kind, executionId = 'reactive-run') => `---\n${JSON.stringify({ name, description: 'Reactive execution acceptance', kind, ...(executionId ? { executionId } : {}) })}\n---\nCanonical fixture body`
  const plan = continuum.publish(metadata('Reactive canonical plan', 'EXECUTABLE_PLAN'))
  let listReads = 0, gitCalls = 0, requests = [], blocked = false, gateRequested = false, release
  const list = continuum.list.bind(continuum); continuum.list = filter => { listReads++; return list(filter) }
  const serviceGit = new GitService(), rawGit = serviceGit.runGit.bind(serviceGit)
  serviceGit.runGit = (...args) => { gitCalls++; return rawGit(...args) }
  const service = new GitOperationsService(root, serviceGit, new GitHubGitTransport(null, serviceGit), { repositoryId: record.id, isActive: () => true })
  const projects = { getState: () => ({ project: { id: 'fixture', path: root, name: 'Reactive fixture' }, revision: 1 }) }
  const remote = { branchPullRequests: async (_path, inventory) => ({ repositoryId: record.id, catalog: { repositoryId: record.id, coverage: 'UNAVAILABLE', observedAt: new Date().toISOString(), revision: 'offline', reason: 'NOT_CONNECTED', items: [] }, relations: [], orphaned: [] }) }
  const controller = new BranchOrchestrationController(projects, async () => false, session)
  controller.bind(service, remote, root)
  const request = controller.request.bind(controller)
  controller.request = async value => {
    requests.push(value.operation)
    const result = await request(value)
    if (gateRequested && value.operation.action === 'EXECUTIONS') { gateRequested = false; blocked = true; await new Promise(resolve => { release = resolve }); blocked = false }
    return result
  }
  registerBranchOrchestrationHandlers(controller)
  const unregister = registerContinuumHandlers(session)
  const channel = new LocalChannelHost([new ContinuumLocalAdapter(session)], path.join(ctx.temporary, 'profile')); await channel.start()
  const cli = args => new Promise((resolve, reject) => execFile('node', [path.join(ctx.projectRoot, 'scripts/continuum/local.cjs'), ...args, '--repository', record.id, '--profile', path.join(ctx.temporary, 'profile')], { cwd: topic, windowsHide: true, timeout: 60000 }, (error, out, err) => error ? reject(new Error(err || error.message)) : resolve(JSON.parse(out))))
  const publish = async (name, kind = 'IMPLEMENTATION_HANDOFF', executionId = 'reactive-run') => { const file = path.join(ctx.temporary, name.replace(/\W/g, '-') + '.md'); fs.writeFileSync(file, metadata(name, kind, executionId)); return cli(['publish', '--file', file]) }
  const wait = async (fn, ...args) => { const end = Date.now() + 45000; while (Date.now() < end) { if (await ctx.evaluate(fn, ...args)) return; await new Promise(r => setTimeout(r, 40)) } throw new Error('Reactive renderer condition timed out') }
  const clickText = async text => { await ctx.evaluate(text => { document.querySelector('[data-target]')?.removeAttribute('data-target'); const node = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text); if (!node) throw new Error('Missing button ' + text); node.scrollIntoView({ block: 'nearest' }); node.setAttribute('data-target', '') }, text); await ctx.click('[data-target]') }
  const select = async name => { await ctx.evaluate(name => { document.querySelector('[data-branch]')?.removeAttribute('data-branch'); const node = [...document.querySelectorAll('.bm-card')].find(b => b.querySelector('strong').textContent === name); node.scrollIntoView({ block: 'nearest' }); node.setAttribute('data-branch', '') }, name); await ctx.click('[data-branch]'); await wait(name => document.querySelector('.bm-card.selected strong')?.textContent === name && !!document.querySelector('.bm-executions') && document.querySelector('.bm-executions').getAttribute('aria-busy') === 'false', name) }
  const preload = path.join(ctx.temporary, 'preload.cjs')
  buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], outfile: preload, bundle: true, platform: 'node', external: ['electron'] }); ctx.window.webContents.session.setPreloads([preload])
  buildSync({ entryPoints: [path.join(__dirname, 'branch-manager-fixture.tsx')], outfile: path.join(ctx.temporary, 'fixture.js'), bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } })
  const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(fs.readFileSync(path.join(ctx.projectRoot, 'src/renderer/index.html'), 'utf8'))[1]
  const page = path.join(ctx.temporary, 'index.html'); fs.writeFileSync(page, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}.fixture-nav{height:32px;display:flex;gap:16px;padding:4px 24px;box-sizing:border-box}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
  try {
    await ctx.window.loadFile(page, { query: { repositoryPath: root } }); await ctx.viewport(1440, 900)
    await wait(() => document.querySelectorAll('.bm-card').length === 21)
    ctx.check('21 records: inventory mount makes zero Continuum reads', listReads === 0)
    const start = Date.now(), before = gitCalls; await select('topic')
    const selection21 = { milliseconds: Date.now() - start, gitCalls: gitCalls - before, listReads }
    ctx.check('Selection automatically shows conclusive absence with no disclosure or refresh button', await ctx.evaluate(() => document.querySelector('.bm-executions').textContent.includes('Sem vínculo explícito') && !document.querySelector('.bm-executions summary') && !document.body.textContent.includes('Atualizar execuções')))
    const binding = await cli(['bind_execution', '--id', plan.artifactId, '--execution', 'reactive-run'])
    await wait(() => document.querySelector('.bm-executions').textContent.includes('Vínculo corrente verificado'))
    ctx.check('CLI binding PERSISTED appears through real service/session/IPC event', binding.state === 'PERSISTED')
    await clickText('Ver Artifacts desta execução'); await wait(() => document.querySelector('.bm-executions').textContent.includes('Reactive canonical plan'))
    await publish('Published live handoff'); await wait(() => document.querySelector('.bm-executions').textContent.includes('Published live handoff'))
    ctx.check('Open execution receives new CLI publication without a click', true)
    await publish('Unbound document', 'DOCUMENT', '')
    await wait(() => document.querySelector('.bm-executions').getAttribute('aria-busy') === 'false')
    ctx.check('Unbound documents are never inferred into selected execution', await ctx.evaluate(() => !document.querySelector('.bm-executions').textContent.includes('Unbound document')))
    gateRequested = true; await publish('Slow request trigger')
    const deadline = Date.now() + 45000; while (!blocked && Date.now() < deadline) await new Promise(r => setTimeout(r, 40))
    ctx.check('Real selected-branch request held in flight', blocked)
    await publish('Latest update one'); await publish('Latest update two'); release()
    await wait(() => document.querySelector('.bm-executions').textContent.includes('Latest update two'))
    ctx.check('Notifications during in-flight read eventually display latest membership', await ctx.evaluate(() => document.querySelector('.bm-executions').textContent.includes('Latest update one')))
    await ctx.capture('reactive-documents-dark'); await ctx.overflow()
    await clickText('Ocultar gestor'); const hidden = requests.length
    await publish('While hidden'); await new Promise(r => setTimeout(r, 300))
    ctx.check('Hidden consumer issues zero IPC reads on real publication', requests.length === hidden)
    await clickText('Mostrar gestor'); await wait(() => document.querySelector('.bm-executions').textContent.includes('Vínculo corrente verificado'))
    await wait(() => document.querySelector('.bm-executions').textContent.includes('While hidden'))
    ctx.check('Reactivation refreshes open execution documents without another click', true)
    await select('main'); ctx.check('Equal SHA on main does not infer an execution', await ctx.evaluate(() => document.querySelector('.bm-executions').textContent.includes('Sem vínculo explícito')))
    await ctx.click('[aria-label="Fechar detalhes"]')
    for (let i = 19; i < 99; i++) git(root, ['branch', `work-${String(i).padStart(3, '0')}`])
    const mountReads = listReads; await clickText('Atualizar'); await wait(() => document.querySelector('.bm-toolbar').textContent.includes('101 branches'))
    ctx.check('101 records: inventory refresh makes zero Continuum reads', listReads === mountReads)
    await ctx.input('.bm-toolbar input', 'topic'); await wait(() => document.querySelectorAll('.bm-card').length === 1)
    const largeStart = Date.now(), largeGit = gitCalls, largeReads = listReads; await select('topic')
    const selection101 = { milliseconds: Date.now() - largeStart, gitCalls: gitCalls - largeGit, listReads: listReads - largeReads }
    ctx.check('101 records: exactly one metadata read for the selected branch', selection101.listReads === 1)
    const idle = { requests: requests.length, gitCalls, listReads }; await new Promise(r => setTimeout(r, 500))
    ctx.check('No idle polling or extra provider reads', JSON.stringify(idle) === JSON.stringify({ requests: requests.length, gitCalls, listReads }))
    await ctx.viewport(820, 760); await ctx.evaluate(() => { document.body.dataset.theme = 'light' }); await ctx.capture('reactive-selection-narrow-light'); await ctx.overflow()
    ctx.check('All execution reads target only the active selected reference', requests.filter(op => ['EXECUTIONS', 'EXECUTION_DOCUMENTS'].includes(op.action)).every(op => ['refs/heads/topic', 'refs/heads/main'].includes(op.ref)))
    fs.writeFileSync(path.join(ctx.evidenceDir, 'costs.json'), JSON.stringify({ selection21, selection101, gitCalls, listReads, requests }, null, 2))
  } finally { release?.(); await controller.deactivate(); unregister(); channel.dispose(); session.dispose(); catalog.close() }
}
