const fs = require('node:fs')
const path = require('node:path')
const { execFile, spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')

exports.run = async ctx => {
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export { ArtifactStore } from './src/main/continuum/artifact-store'; export { ContinuumService } from './src/main/continuum/continuum-service'; export { ContinuumLocalAdapter } from './src/main/continuum/local-adapter'; export { LocalChannelHost } from './src/main/local-agent-channel/local-channel-host'; export { registerContinuumHandlers } from './src/main/ipc/continuum-handler'; export { GitService } from './src/main/core/git-service'; export { GitOperationsService } from './src/main/git-operations/git-operations-service'; export { GitHubGitTransport } from './src/main/github/github-git-transport'; export { GitHubApiClient } from './src/main/github/github-api-client'; export { GitHubPullRequestCatalog } from './src/main/github/github-pull-request-catalog'; export { BranchOrchestrationController, registerBranchOrchestrationHandlers } from './src/main/ipc/branch-orchestration-handler'; export { WorkOrchestrationController, registerWorkOrchestrationHandlers } from './src/main/ipc/work-orchestration-handler'; export { RuntimeIdentityProvider } from './src/main/runtime-identity/runtime-identity-provider'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3', 'sharp', 'js-yaml'] })
  const { ArtifactStore, ContinuumService, ContinuumLocalAdapter, LocalChannelHost, registerContinuumHandlers, GitService, GitOperationsService, GitHubGitTransport, GitHubApiClient, GitHubPullRequestCatalog, BranchOrchestrationController, registerBranchOrchestrationHandlers, WorkOrchestrationController, registerWorkOrchestrationHandlers, RuntimeIdentityProvider } = require(backend)
  const runtime = new RuntimeIdentityProvider({ rootDir: ctx.projectRoot, includedDirectories: ['src/main', 'src/shared', 'src/renderer/src'] })
  await runtime.sourceOriginReady
  const identity = runtime.getIdentityPayload()
  fs.writeFileSync(path.join(ctx.evidenceDir, 'runtime-identity.json'), JSON.stringify(identity, null, 2))
  const git = (root, args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  ctx.check('Implementation source branch, root and HEAD', identity.sourceOrigin.worktree.branch === 'codex/branch-pr-worktree-manager' && identity.sourceOrigin.worktree.head === git(ctx.projectRoot, ['rev-parse', 'HEAD']) && identity.sourceOrigin.worktree.rootPath.toLowerCase() === ctx.projectRoot.toLowerCase())
  ctx.check('Runtime freshness MATCH', identity.freshness.state === 'MATCH')
  const root = path.join(ctx.temporary, 'repository')
  fs.mkdirSync(root); git(root, ['init', '-b', 'main']); git(root, ['config', 'user.name', 'Acceptance']); git(root, ['config', 'user.email', 'acceptance@example.test'])
  fs.writeFileSync(path.join(root, 'base.txt'), 'inherited\n'); git(root, ['add', '.']); git(root, ['commit', '-m', 'Inherited baseline'])
  git(root, ['switch', '-c', 'abandoned']); fs.writeFileSync(path.join(root, 'exclusive.txt'), 'recover me\n'); git(root, ['add', '.']); git(root, ['commit', '-m', 'Exclusive abandoned work'])
  const abandonedHead = git(root, ['rev-parse', 'HEAD']); git(root, ['switch', 'main'])
  git(root, ['worktree', 'add', '-b', 'topic', path.join(ctx.temporary, 'topic')])
  git(root, ['worktree', 'add', '--detach', path.join(ctx.temporary, 'detached')])
  for (let i = 0; i < 18; i++) git(root, ['worktree', 'add', '--no-checkout', '-b', `work-${String(i).padStart(3, '0')}`, path.join(ctx.temporary, `work-${i}`)])
  const serviceGit = new GitService(), raw = serviceGit.runGit.bind(serviceGit)
  let gitCalls = 0, httpCalls = 0, snapshots = 0, mode = 'fixtures', releaseConfirmations = 0
  serviceGit.runGit = (...args) => { gitCalls++; return raw(...args) }
  const service = new GitOperationsService(root, serviceGit, new GitHubGitTransport(null, serviceGit), { repositoryId: 'fixture', isActive: () => true })
  const observe = service.getCoordinationSnapshot.bind(service)
  service.getCoordinationSnapshot = (...args) => { snapshots++; return observe(...args) }
  const coldStart = Date.now(), first = await service.getBranchInventory(), cold = { milliseconds: Date.now() - coldStart, gitCalls, worktrees: first.worktrees.length }
  ctx.check('21 real registered Worktrees and branch without checkout', first.worktrees.length === 21 && first.branches.find(b => b.name === 'abandoned').worktrees.length === 0)
  const warmStart = Date.now(), warmCalls = gitCalls
  await service.getBranchInventory()
  const warm = { milliseconds: Date.now() - warmStart, gitCalls: gitCalls - warmCalls }
  ctx.check('Warm inventory has bounded Git calls and no snapshots', warm.gitCalls <= 8 && snapshots === 0)
  const pr = (number, fork = false) => ({ id: number, number, title: fork ? 'Fork with repeated branch name' : `Delivery ${number}`, html_url: `https://github.com/fixture/repo/pull/${number}`, state: 'open', draft: number === 2, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', merged_at: null,
    head: { repo: { id: fork ? 2 : 1, full_name: fork ? 'fork/repo' : 'fixture/repo' }, ref: 'topic', sha: first.branches.find(b => b.name === 'topic').head }, base: { repo: { id: 1, full_name: 'fixture/repo' }, ref: 'main', sha: first.branches.find(b => b.name === 'main').head } })
  const api = new GitHubApiClient(async () => 'fixture-only', async url => { httpCalls++; return new Response(JSON.stringify(String(url).includes('/pulls') ? [pr(1), pr(2), pr(3, true)] : { id: 1, full_name: 'fixture/repo', default_branch: 'main' })) })
  const catalog = new GitHubPullRequestCatalog(api)
  const remote = {
    branchPullRequests: async (_path, inventory) => {
      if (mode === 'offline') return { repositoryId: 'fixture', catalog: { repositoryId: 'fixture', repository: null, providerRepositoryId: null, defaultBranch: null, source: 'GITHUB_REST', coverage: 'UNAVAILABLE', observedAt: new Date().toISOString(), revision: 'offline', reason: 'NOT_CONNECTED', items: [] }, relations: [], orphaned: [] }
      return catalog.project(inventory, await catalog.read('fixture', 'fixture/repo'))
    },
    pullRequestCommits: async () => { throw new Error('NOT_REQUESTED') },
    assessBranchDiscard: async () => ({ repositoryId: 'fixture', coverage: 'COMPLETE', observedAt: new Date().toISOString(), revision: 'local-only', defaultBranch: 'main', protected: false, openPullRequests: [], knownPullRequests: [], reason: null })
  }
  let continuumReads = 0
  let store = new ArtifactStore(path.join(ctx.temporary, 'continuum.db'), 'fixture')
  let continuum = new ContinuumService(store)
  const activeSession = { repositoryId: 'fixture', repositoryPath: root }
  let continuumAvailable = true
  const session = { getActiveSession: () => continuumAvailable ? activeSession : null, getActiveService: () => continuumAvailable ? continuum : null, onChanged: () => () => {} }
  const countReads = () => { const list = continuum.list.bind(continuum); continuum.list = filter => { continuumReads++; return list(filter) } }
  countReads()
  const plan = continuum.publish('---\nname: Execution binding acceptance plan\ndescription: Real CLI selection\nkind: EXECUTABLE_PLAN\nexecutionId: acceptance-execution\n---\nCanonical plan body')
  continuum.publish('---\nname: Execution acceptance handoff\ndescription: Document membership\nkind: IMPLEMENTATION_HANDOFF\nstatus: VALIDATED\nexecutionId: acceptance-execution\n---\nHandoff body')
  const channel = new LocalChannelHost([new ContinuumLocalAdapter(session)], path.join(ctx.temporary, 'profile'))
  await channel.start()
  const cli = args => new Promise((resolve, reject) => execFile('node', [path.join(ctx.projectRoot, 'scripts/continuum/local.cjs'), ...args, '--repository', 'fixture', '--profile', path.join(ctx.temporary, 'profile')], { cwd: path.join(ctx.temporary, 'topic'), windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout))))
  const args = ['bind_execution', '--execution', 'acceptance-execution', '--id', plan.artifactId]
  const binding = await cli(args), replay = await cli(args)
  ctx.check('Real CLI receipt PERSISTED and replay identity', binding.state === 'PERSISTED' && binding.artifactId === replay.artifactId && binding.branchRef === 'refs/heads/topic')
  const unregisterContinuum = registerContinuumHandlers(session)
  const projects = { getState: () => ({ project: { id: 'fixture', name: 'Acceptance', path: root }, revision: 1 }) }
  const controller = new BranchOrchestrationController(projects, async () => { releaseConfirmations++; return true }, session), legacy = new WorkOrchestrationController(projects)
  controller.bind(service, remote, root); legacy.bind(service)
  let uiInventoryReads = 0
  const request = controller.request.bind(controller)
  controller.request = value => { if (value.operation?.action === 'INVENTORY') uiInventoryReads++; return request(value) }
  registerBranchOrchestrationHandlers(controller); registerWorkOrchestrationHandlers(legacy)
  const wait = async fn => {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) { if (await ctx.evaluate(fn)) return; await new Promise(resolve => setTimeout(resolve, 40)) }
    throw new Error('Branch renderer condition timed out')
  }
  const clickText = async (text, scope = 'body') => {
    await ctx.evaluate((text, scope) => { document.querySelector('[data-click-target]')?.removeAttribute('data-click-target'); const element = [...document.querySelector(scope).querySelectorAll('button')].find(b => b.textContent.trim() === text); if (!element) throw new Error(`Missing button ${text}`); element.scrollIntoView({ block: 'nearest' }); element.setAttribute('data-click-target', '') }, text, scope)
    await ctx.click('[data-click-target]')
  }
  const select = async name => {
    await ctx.evaluate(name => { document.querySelector('[data-branch-target]')?.removeAttribute('data-branch-target'); const button = [...document.querySelectorAll('.bm-card')].find(b => b.querySelector('strong').textContent === name); button.scrollIntoView({ block: 'nearest' }); button.setAttribute('data-branch-target', '') }, name)
    await ctx.click('[data-branch-target]'); await wait(() => !!document.querySelector('.bm-detail'))
  }
  const refresh = async () => {
    const before = uiInventoryReads
    await clickText('Atualizar')
    const deadline = Date.now() + 5000
    while (uiInventoryReads === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    ctx.check('Refresh reaches the real controller', uiInventoryReads > before)
    await wait(() => !document.querySelector('.wo-header button').disabled && !document.querySelector('.bm-remote').textContent.includes('Consultando'))
  }
  const preload = path.join(ctx.temporary, 'preload.cjs')
  buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', format: 'cjs', external: ['electron'] })
  ctx.window.webContents.session.setPreloads([preload])
  buildSync({ entryPoints: [path.join(__dirname, 'branch-manager-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } })
  const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(fs.readFileSync(path.join(ctx.projectRoot, 'src/renderer/index.html'), 'utf8'))[1]
  const page = path.join(ctx.temporary, 'index.html')
  fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}.fixture-nav{height:32px;display:flex;gap:20px;padding:4px 24px;box-sizing:border-box;font:12px system-ui}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
  try {
    await ctx.window.loadFile(page, { query: { repositoryPath: root } }); await ctx.viewport(1440, 900)
    await wait(() => document.querySelectorAll('.bm-card').length > 0 && !document.querySelector('.bm-remote').textContent.includes('Consultando'))
    ctx.check('Renderer shows branch-first inventory and detached section', await ctx.evaluate(() => document.querySelector('.bm-toolbar').textContent.includes('21 Worktrees') && document.body.textContent.includes('Worktrees sem branch confirmada')))
    await select('topic')
    ctx.check('Multiple current PRs retained and fork unconfirmed', await ctx.evaluate(() => document.querySelector('.bm-detail').textContent.includes('#1') && document.querySelector('.bm-detail').textContent.includes('#2') && document.querySelectorAll('.bm-pr-list small').length > 0 && document.querySelector('.bm-detail').textContent.includes('Associação ambígua')))
    ctx.check('No Continuum reads while mounting inventory or selecting branch', continuumReads === 0)
    const bindingStart = Date.now(), bindingCalls = gitCalls
    await ctx.click('.bm-executions summary'); await wait(() => document.querySelector('.bm-executions').textContent.includes('Vínculo corrente verificado'))
    const binding21 = { milliseconds: Date.now() - bindingStart, gitCalls: gitCalls - bindingCalls, continuumReads }
    await clickText('Ver Artifacts desta execução', '.bm-executions'); await wait(() => document.querySelector('.bm-executions').textContent.includes('Execution acceptance handoff'))
    ctx.check('Branch to execution to canonical document membership', continuumReads === 2 && await ctx.evaluate(() => document.querySelector('.bm-executions').textContent.includes('EXECUTABLE_PLAN') && document.querySelector('.bm-executions').textContent.includes('VALIDATED')))
    await ctx.capture('execution-documents-dark')
    await clickText('Abrir no Continuum', '.bm-executions'); await wait(() => !!document.querySelector('.continuum-markdown'))
    ctx.check('Artifact opens existing Continuum inspector', await ctx.evaluate(() => document.querySelector('.continuum-markdown').textContent.length > 0))
    await clickText('Voltar ao gestor', '.fixture-nav'); await wait(() => !document.querySelector('.wo-header button').disabled)
    await select('topic')
    git(path.join(ctx.temporary, 'topic'), ['commit', '--allow-empty', '-m', 'Normal HEAD advance'])
    const advancedReplay = await cli(args)
    ctx.check('CLI HEAD advance preserves binding identity', advancedReplay.artifactId === binding.artifactId)
    store.close(); store = new ArtifactStore(path.join(ctx.temporary, 'continuum.db'), 'fixture'); continuum = new ContinuumService(store); countReads()
    ctx.check('Canonical SQLite association survives service restart', continuum.get(binding.artifactId).artifactId === binding.artifactId)
    await refresh(); await select('topic'); await ctx.click('.bm-executions summary'); await wait(() => document.querySelector('.bm-executions').textContent.includes('Vínculo corrente verificado'))
    await ctx.capture('branches-21-dark'); await ctx.overflow()
    const idleBefore = { gitCalls, httpCalls, snapshots }
    await new Promise(resolve => setTimeout(resolve, 1000))
    ctx.check('No idle polling, structural scanner or per-card snapshots', JSON.stringify(idleBefore) === JSON.stringify({ gitCalls, httpCalls, snapshots }) && snapshots === 0 && httpCalls >= 2)
    await clickText('Commits exclusivos', '.bm-detail'); await wait(() => document.querySelector('.bm-detail').textContent.includes('Normal HEAD advance'))
    await select('abandoned'); await clickText('História alcançável', '.bm-detail')
    await wait(() => document.querySelector('.bm-detail').textContent.includes('Exclusive abandoned work'))
    await clickText('Exclusive abandoned work · ' + abandonedHead.slice(0, 8), '.bm-detail')
    await wait(() => document.querySelector('output').textContent.length === 40)
    ctx.check('Commit navigation carries exact SHA', await ctx.evaluate(sha => document.querySelector('output').textContent === sha, abandonedHead))
    await clickText('Preparar descarte da branch…', '.bm-detail'); await wait(() => !!document.querySelector('[role=dialog]'))
    ctx.check('Discard requires explicit preservation consent', await ctx.evaluate(() => [...document.querySelector('[role=dialog]').querySelectorAll('button')].find(b => b.textContent === 'Confirmar descarte').disabled))
    await ctx.capture('discard-preview-dark'); await ctx.click('[role=dialog] input[type=checkbox]'); await clickText('Confirmar descarte', '[role=dialog]')
    await wait(() => document.body.textContent.includes('Branch descartada. Recuperação:'))
    const receipt = await ctx.evaluate(() => document.querySelector('.bm-receipt').textContent)
    const recovery = /refs\/code-awareness\/recovery\/[a-f0-9-]+/.exec(receipt)[0]
    ctx.check('Recovery ref retains abandoned SHA and exact bytes', git(root, ['rev-parse', recovery]) === abandonedHead && git(root, ['show', `${recovery}:exclusive.txt`]) === 'recover me')
    await wait(() => !document.querySelector('.wo-header button').disabled); await select('topic'); await clickText('Preparar descarte da branch…', '.bm-detail'); await wait(() => !!document.querySelector('[role=dialog]'))
    ctx.check('Occupied branch cannot be confirmed', await ctx.evaluate(() => document.querySelector('[role=dialog]').textContent.includes('Branch em checkout') && !document.querySelector('[role=dialog] input')))
    await clickText('Cancelar', '[role=dialog]')
    const topicBefore = git(root, ['rev-parse', 'refs/heads/topic'])
    await clickText('Remover Worktree…', '.bm-detail'); await wait(() => !!document.querySelector('[role=dialog]'))
    await ctx.click('[role=dialog] input[type=checkbox]'); await clickText('Confirmar liberação e remoção…', '[role=dialog]')
    await wait(() => document.body.textContent.includes('Worktree removida.'))
    ctx.check('Separate removal handshake preserves branch', releaseConfirmations === 1 && git(root, ['rev-parse', 'refs/heads/topic']) === topicBefore && !fs.existsSync(path.join(ctx.temporary, 'topic')))
    await wait(() => !document.querySelector('.wo-header button').disabled && !document.querySelector('.bm-remote').textContent.includes('Consultando'))
    await select('topic'); await ctx.click('.bm-executions summary'); await wait(() => document.querySelector('.bm-executions').textContent.includes('Vínculo corrente verificado'))
    ctx.check('Association remains after authorized fixture Worktree removal', await ctx.evaluate(() => document.querySelector('.bm-executions').textContent.includes('checkout histórico')))
    for (let i = 18; i < 99; i++) git(root, ['worktree', 'add', '--no-checkout', '-b', `work-${String(i).padStart(3, '0')}`, path.join(ctx.temporary, `work-${i}`)])
    const largeStart = Date.now(), largeCalls = gitCalls, large = await service.getBranchInventory()
    const largeCold = { milliseconds: Date.now() - largeStart, gitCalls: gitCalls - largeCalls, worktrees: large.worktrees.length }
    const largeWarmStart = Date.now(), largeWarmCalls = gitCalls
    await service.getBranchInventory()
    const largeWarm = { milliseconds: Date.now() - largeWarmStart, gitCalls: gitCalls - largeWarmCalls }
    fs.writeFileSync(path.join(ctx.evidenceDir, 'costs.json'), JSON.stringify({ cold, warm, largeCold, largeWarm, gitCalls, httpCalls, snapshots, continuumReads }, null, 2))
    ctx.check('101 real Worktrees, bounded warm cost', large.worktrees.length === 101 && largeWarm.gitCalls <= 8)
    mode = 'offline'; await refresh()
    await ctx.evaluate(() => { const close = document.querySelector('[aria-label="Fechar detalhes"]'); close?.click() })
    await clickText('Mostrar mais branches'); await wait(() => document.querySelectorAll('.bm-card').length === 100)
    await clickText('Mostrar mais branches'); await wait(() => document.querySelectorAll('.bm-card').length >= 101)
    ctx.check('Offline preserves complete local inventory beyond 100', await ctx.evaluate(() => document.querySelectorAll('.bm-card').length >= 101 && document.querySelector('.bm-remote').textContent.includes('indisponível')))
    await ctx.evaluate(() => { document.querySelector('.bm-list').scrollTop = 500 })
    const scroll = await ctx.evaluate(() => document.querySelector('.bm-list').scrollTop)
    await refresh()
    ctx.check('Explicit refresh preserves list scroll', await ctx.evaluate(top => document.querySelector('.bm-list').scrollTop === top, scroll))
    await select('topic')
    const largeBindingStart = Date.now(), largeBindingCalls = gitCalls, largeBindingReads = continuumReads
    await ctx.click('.bm-executions summary'); await wait(() => document.querySelector('.bm-executions').textContent.includes('Vínculo corrente verificado'))
    const binding101 = { milliseconds: Date.now() - largeBindingStart, gitCalls: gitCalls - largeBindingCalls, continuumReads: continuumReads - largeBindingReads }
    ctx.check('101 branches: one demanded metadata query per selection', binding101.continuumReads === 1)
    continuumAvailable = false; await clickText('Atualizar execuções', '.bm-executions'); await wait(() => document.querySelector('.bm-executions').textContent.includes('Consulta indisponível'))
    ctx.check('Unavailable Continuum does not claim no documents', await ctx.evaluate(() => !document.querySelector('.bm-executions').textContent.includes('Sem vínculo explícito')))
    continuumAvailable = true
    await ctx.capture('branches-101-offline-dark'); await ctx.overflow()
    await ctx.viewport(820, 760); await ctx.evaluate(() => { document.body.dataset.theme = 'light' }); await select('work-098')
    await ctx.capture('branch-detail-narrow-light'); await ctx.overflow()
    await clickText('Ocultar gestor', '.fixture-nav')
    const hidden = { gitCalls, httpCalls }
    await new Promise(resolve => setTimeout(resolve, 500))
    ctx.check('Hidden manager performs zero reads', JSON.stringify(hidden) === JSON.stringify({ gitCalls, httpCalls }))
    fs.writeFileSync(path.join(ctx.evidenceDir, 'costs.json'), JSON.stringify({ cold, warm, largeCold, largeWarm, gitCalls, httpCalls, snapshots, continuumReads }, null, 2))
    fs.writeFileSync(path.join(ctx.evidenceDir, 'execution-costs.json'), JSON.stringify({ binding21, binding101, continuumReads }, null, 2))
  } finally { channel.dispose(); unregisterContinuum(); store.close(); await controller.deactivate(); legacy.deactivate() }
}
