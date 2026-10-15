const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync, transformSync } = require('esbuild')
exports.run = async ctx => {
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export { GitService } from './src/main/core/git-service'; export { GitOperationsService } from './src/main/git-operations/git-operations-service'; export { GitHubGitTransport } from './src/main/github/github-git-transport'; export { WorkOrchestrationController, registerWorkOrchestrationHandlers } from './src/main/ipc/work-orchestration-handler'; export { GitManagementController, registerGitManagementHandlers } from './src/main/ipc/git-management-handler'; export { RuntimeIdentityProvider } from './src/main/runtime-identity/runtime-identity-provider'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] })
  const { GitService, GitOperationsService, GitHubGitTransport, WorkOrchestrationController, registerWorkOrchestrationHandlers, GitManagementController, registerGitManagementHandlers, RuntimeIdentityProvider } = require(backend)
  const identity = new RuntimeIdentityProvider({ rootDir: ctx.projectRoot, includedDirectories: ['src/main', 'src/shared', 'src/renderer/src'] })
  await identity.sourceOriginReady
  const runtime = identity.getIdentityPayload()
  fs.writeFileSync(path.join(ctx.evidenceDir, 'runtime-identity.json'), JSON.stringify(runtime, null, 2))
  ctx.check('Correct worktree and baseline HEAD', runtime.sourceOrigin.worktree.rootPath.toLowerCase() === ctx.projectRoot.toLowerCase() && runtime.sourceOrigin.worktree.branch === spawnSync('git', ['branch', '--show-current'], { cwd: ctx.projectRoot, encoding: 'utf8', windowsHide: true }).stdout.trim() && !!runtime.sourceOrigin.worktree.head)
  ctx.check('Runtime freshness MATCH', runtime.freshness.state === 'MATCH')
  const git = (root, args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  const root = path.join(ctx.temporary, 'repository'), other = path.join(ctx.temporary, 'other')
  for (const dir of [root, other]) {
    fs.mkdirSync(dir); git(dir, ['init']); git(dir, ['config', 'user.name', 'Acceptance']); git(dir, ['config', 'user.email', 'acceptance@example.test'])
    for (const file of ['shared.txt', 'modified.txt', 'deleted.txt', 'rename.txt']) fs.writeFileSync(path.join(dir, file), 'base\n')
    git(dir, ['add', '.']); git(dir, ['commit', '-m', 'base'])
  }
  git(root, ['branch', '-m', 'zzz-reference'])
  const a = path.join(ctx.temporary, 'feature-with-a-long-path'), b = path.join(ctx.temporary, 'detached-work')
  git(root, ['worktree', 'add', '-b', 'feature/long-branch-name-for-panorama-and-layout-validation', a]); git(root, ['worktree', 'add', '--detach', b])
  for (const [dir, text] of [[a, 'feature'], [b, 'detached']]) { fs.writeFileSync(path.join(dir, 'shared.txt'), text + '\n'); git(dir, ['add', '.']); git(dir, ['commit', '-m', text]) }
  for (let i = 0; i < 18; i++) git(root, ['worktree', 'add', '-b', `work-${String(i).padStart(3, '0')}`, path.join(ctx.temporary, `work-${i}`)])
  let state = { revision: 1, project: { id: 'acceptance-a', path: root, name: 'Orchestration acceptance' } }
  const projects = { getState: () => state }, serviceGit = new GitService()
  const reader = new GitOperationsService(root, serviceGit, new GitHubGitTransport(null, serviceGit), { repositoryId: 'acceptance-repository', isActive: () => state.project?.id === 'acceptance-a' })
  let gitCalls = 0
  const execute = serviceGit.runGitBytes.bind(serviceGit)
  serviceGit.runGitBytes = (...args) => { gitCalls++; return execute(...args) }
  let snapshots = 0, commits = 0, mutations = 0, running = 0, maximum = 0; const observations = []
  const snapshot = reader.getCoordinationSnapshot.bind(reader), interval = reader.getCoordinationCommitPaths.bind(reader)
  reader.getCoordinationSnapshot = async (...args) => { snapshots++; running++; maximum=Math.max(maximum,running); const start=performance.now(); try { return await snapshot(...args) } finally { observations.push({id:args[0],ms:performance.now()-start}); running-- } }
  reader.getCoordinationCommitPaths = async (...args) => { commits++; return interval(...args) }
  const details = [], changes = reader.getWorktreeChanges.bind(reader)
  reader.getWorktreeChanges = async request => { const start = performance.now(), before = gitCalls; try { return await changes(request) } finally { details.push({ request, ms: performance.now() - start, gitCalls: gitCalls - before }) } }
  const controller = new WorkOrchestrationController(projects), management = new GitManagementController(projects)
  controller.bind(reader); management.bind(reader)
  let baseline
  if (process.env.LOCAL_SIGNALS_BASELINE === '1') {
    const source = spawnSync('git', ['-c', 'core.fsmonitor=false', 'show', 'e1f3bed88ff888795d1200d1ff7d521e03c277ed:src/main/work-orchestration/work-orchestration-service.ts'], { cwd: ctx.projectRoot, encoding: 'utf8', windowsHide: true })
    if (source.status !== 0) throw new Error(source.stderr)
    const module = { exports: {} }
    new Function('require', 'module', transformSync(source.stdout, { loader: 'ts', format: 'cjs' }).code)(require, module)
    baseline = new module.exports.WorkOrchestrationService(reader)
  }
  const { ipcMain } = require('electron'), original = ipcMain.handle, reads = []
  ipcMain.handle = function(channel, handler) {
    original.call(this, channel, async (...args) => {
      if (channel === 'git-management:mutate') mutations++
      if (channel !== 'work-orchestration:read') return handler(...args)
      const request = args[1]
      reads.push(request)
      const result = baseline && !request.changes ? { success: true, context: request.context, data: request.worktree ? await baseline.observe(request.worktree.worktreeId) : await baseline.inventory() } : await handler(...args)
      return result
    })
  }
  registerWorkOrchestrationHandlers(controller); registerGitManagementHandlers(management); ipcMain.handle = original
  const stats = () => ({ inventory: reads.filter(r => !r.worktree && !r.pair && !r.changes).length, inspect: reads.filter(r => r.worktree).length, pair: reads.filter(r => r.pair).length, snapshots, commits })
  const wait = async fn => {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) { if (await ctx.evaluate(fn)) return; await new Promise(resolve => setTimeout(resolve, 60)) }
    throw new Error('Acceptance condition timed out')
  }
  const navigate = async name => {
    await ctx.evaluate(name => { document.querySelector('[data-nav-target]')?.removeAttribute('data-nav-target'); [...document.querySelectorAll('.global-sidebar-nav-item')].find(button => button.textContent.trim() === name).setAttribute('data-nav-target', '') }, name)
    await ctx.click('[data-nav-target]')
    await ctx.waitFor(name => name === 'Work Orchestration' ? !document.querySelector('.wo-tab').hidden : document.querySelector('.wo-tab').hidden, name)
  }
  const filter = async text => { await ctx.evaluate(text => { const input = document.querySelector('[aria-label="Filtrar worktrees"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) }, text) }
  const select = async text => {
    await ctx.evaluate(text => { document.querySelector('[data-tree-target]')?.removeAttribute('data-tree-target'); [...document.querySelectorAll('.wo-tree')].find(button => button.textContent.includes(text)).setAttribute('data-tree-target', '') }, text)
    await ctx.click('[data-tree-target]'); await wait(() => document.querySelector('.wo-inspector')?.textContent.includes('Última observação do estado') && !document.querySelector('.wo-inspector').textContent.includes('Lendo a worktree selecionada'))
    await ctx.evaluate(() => { const summary = [...document.querySelectorAll('.wo-inspector summary')].find(s => s.textContent === 'Arquivos alterados'); summary.scrollIntoView({block:'center'}); summary.setAttribute('data-files-disclosure','') })
    await ctx.click('[data-files-disclosure]')
  }
  const startRefresh = async () => { const count = reads.length; await ctx.click('.wo-header button'); const deadline = Date.now() + 5000; while (reads.length === count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50)); ctx.check('Explicit refresh issues new IPC', reads.length > count) }
  const refresh = async () => { await startRefresh(); await wait(() => !document.querySelector('.wo-header button').disabled) }
  try {
    const preload = path.join(ctx.temporary, 'preload.cjs')
    buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', format: 'cjs', external: ['electron'] }); ctx.window.webContents.session.setPreloads([preload])
    buildSync({ entryPoints: [path.join(__dirname, 'work-orchestration-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } })
    const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(fs.readFileSync(path.join(ctx.projectRoot, 'src/renderer/index.html'), 'utf8'))[1]
    const page = path.join(ctx.temporary, 'index.html')
    fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
    fs.writeFileSync(path.join(a, 'added.txt'), 'staged\n'); git(a, ['add', 'added.txt']); fs.writeFileSync(path.join(a, 'added.txt'), 'unstaged\n')
    fs.writeFileSync(path.join(a, 'modified.txt'), 'modified\n'); fs.unlinkSync(path.join(a, 'deleted.txt')); git(a, ['mv', 'rename.txt', 'renamed.txt'])
    for (let i = 0; i < 55; i++) fs.writeFileSync(path.join(a, `new-${i}.txt`), 'untracked\n')
    const detachedHead = git(b, ['rev-parse', 'HEAD'])
    git(b, ['checkout', '-b', 'conflict-side', git(root, ['rev-parse', 'HEAD'])])
    fs.writeFileSync(path.join(b, 'shared.txt'), 'conflicting side\n'); git(b, ['add', 'shared.txt']); git(b, ['commit', '-m', 'conflicting side'])
    git(b, ['checkout', '--detach', detachedHead])
    const merge = spawnSync('git', ['merge', 'conflict-side'], { cwd: b, encoding: 'utf8', windowsHide: true })
    if (merge.status !== 1) throw new Error('Expected an unresolved real Git conflict')
    const before = { refs: git(a, ['show-ref']), index: fs.readFileSync(path.join(await serviceGit.getWorktreeDirectory(a), 'index')).toString('hex') }
    const started = performance.now()
    await ctx.window.loadFile(page, { query: { repositoryPath: root } }); await ctx.viewport(1440, 900)
    ctx.check('Lazy before first visit', reads.length === 0)
    await navigate('Work Orchestration'); await wait(() => document.querySelectorAll('.wo-tree').length === 21)
    const inventoryMs = performance.now() - started
    const inventoryGitCalls = gitCalls
    ctx.check('Inventory precedes completed local observations and never evaluates pairs', observations.length === 0 && commits === 0)
    await wait(() => !document.querySelector('.wo-header button').disabled)
    await wait(() => [...document.querySelectorAll('.wo-tree')].filter(button => button.getBoundingClientRect().bottom > document.querySelector('.wo-content').getBoundingClientRect().top && button.getBoundingClientRect().top < document.querySelector('.wo-content').getBoundingClientRect().bottom).every(button => !/Revalidando|não observado/.test(button.textContent)))
    const visibleMs = performance.now() - started, visibleReads = snapshots
    const visibleGitCalls = gitCalls
    ctx.check('Only visible worktrees observed with bounded concurrency', snapshots > 0 && snapshots < 21 && maximum <= 2)
    await ctx.capture('visible-local-signals-dark'); await ctx.overflow()
    const idle = reads.length; await new Promise(resolve => setTimeout(resolve, 1200)); ctx.check('Idle has no polling', reads.length === idle)
    const navigationStart = performance.now()
    await navigate('Home'); await navigate('Work Orchestration')
    const navigationReads = reads.length - idle, navigationMs = performance.now() - navigationStart
    ctx.check('Return restores last-known summaries without reads', navigationReads === 0 && await ctx.evaluate(() => document.querySelector('.wo-view').textContent.includes('Último estado conhecido')))
    if (baseline) {
      await ctx.capture('baseline-visible-local-signals-dark')
      await filter('feature/'); const refreshStart = performance.now(), refreshCalls = gitCalls; await refresh(); await wait(() => !document.querySelector('.wo-view').textContent.includes('Revalidando…'))
      fs.writeFileSync(path.join(ctx.evidenceDir,'local-signals-measurements.json'),JSON.stringify({fixture:21,baseline:'existing reader with identical new UI projection',inventoryMs,inventoryGitCalls,visibleMs,visibleReads,visibleGitCalls,navigationMs,navigationReads,refreshMs:performance.now()-refreshStart,refreshGitCalls:gitCalls-refreshCalls,idleReads:0,maximum,observations,reads,stats:stats()},null,2))
      return
    }
    await filter('feature/'); await select('feature/')
    await wait(() => !!document.querySelector('[aria-label="Arquivos alterados"] .wo-paths'))
    ctx.check('Unique paths differ from stage counters', await ctx.evaluate(() => document.querySelector('.wo-inspector').textContent.includes('59 caminhos locais únicos') && document.querySelector('.wo-inspector').textContent.includes('2 staged · 3 unstaged · 55 não rastreados')))
    ctx.check('Technical filter removed and request has no prefix', await ctx.evaluate(() => !document.querySelector('.wo-local-filter') && !document.querySelector('[aria-label="Arquivos alterados"] input')) && reads.filter(request => request.changes).every(request => !Object.hasOwn(request.changes, 'pathPrefix')))
    ctx.check('First page stays within its Git budget and page bound', details.length === 1 && details[0].gitCalls > 0 && details[0].gitCalls <= 18 && details[0].request.pageSize === 50 && !details[0].request.pathPrefixes && await ctx.evaluate(() => document.querySelector('[aria-label="Arquivos alterados"] .wo-paths').children.length === 50))
    ctx.check('Human labels retain both Git states and local categories', await ctx.evaluate(() => {
      const rows = [...document.querySelectorAll('.wo-local-changes li')], row = path => rows.find(item => item.querySelector('strong').textContent === path)
      return row('added.txt').textContent.includes('Adicionado · Modificado') && row('added.txt').textContent.includes('Adicionado ao índice; Modificado no diretório de trabalho') && row('modified.txt').textContent.includes('Modificado') && row('deleted.txt').textContent.includes('Excluído') && row('new-0.txt').textContent.includes('Não rastreado')
    }))
    await ctx.evaluate(() => document.querySelector('[aria-label="Arquivos alterados"]').scrollIntoView({block:'start'})); await ctx.capture('local-paths-dark')
    const beforeEvidence = reads.length
    await ctx.evaluate(() => { const row = [...document.querySelectorAll('.wo-local-changes li')].find(item => item.querySelector('strong').textContent === 'added.txt'); row.querySelector('summary').setAttribute('data-evidence',''); row.querySelector('summary').scrollIntoView({block:'center'}) }); await ctx.click('[data-evidence]')
    ctx.check('Original Git evidence expands without reads', reads.length === beforeEvidence && await ctx.evaluate(() => document.querySelector('[data-evidence]').parentElement.open && document.querySelector('[data-evidence]').parentElement.textContent.includes('Staged: A · Unstaged: M')))
    await ctx.capture('original-git-evidence-dark')
    const clickText = async text => { await ctx.evaluate(text => { document.querySelector('[data-local-action]')?.removeAttribute('data-local-action'); const button = [...document.querySelectorAll('.wo-inspector button')].find(button => button.textContent === text); button.setAttribute('data-local-action',''); button.scrollIntoView({block:'center'}) }, text); await ctx.click('[data-local-action]') }
    await clickText('Próxima página'); await wait(() => document.querySelector('[aria-label="Arquivos alterados"] .wo-paths')?.children.length === 9)
    ctx.check('Rename keeps readable label and origin', await ctx.evaluate(() => [...document.querySelectorAll('.wo-local-changes li')].some(item => item.textContent.includes('renamed.txt') && item.textContent.includes('Renomeado') && item.textContent.includes('Origem: rename.txt'))))
    await ctx.evaluate(() => [...document.querySelectorAll('.wo-local-changes li')].find(item => item.querySelector('strong').textContent === 'renamed.txt').scrollIntoView({block:'center'}))
    await ctx.capture('local-page-two-dark')
    fs.writeFileSync(path.join(a, 'external.txt'), 'external\n')
    await clickText('Página anterior'); await wait(() => document.querySelector('[aria-label="Arquivos alterados"]').textContent.includes('O estado Git mudou'))
    ctx.check('External write rejects stale details', await ctx.evaluate(() => !document.querySelector('[aria-label="Arquivos alterados"] .wo-paths')))
    await ctx.capture('stale-local-page-dark')
    await clickText('Revalidar worktree'); await wait(() => document.querySelector('.wo-inspector').textContent.includes('60 caminhos locais únicos') && !!document.querySelector('[aria-label="Arquivos alterados"] .wo-paths'))
    await ctx.evaluate(() => document.querySelector('[aria-label="Arquivos alterados"]').scrollIntoView({block:'start'}))
    await ctx.evaluate(() => { document.body.dataset.theme = 'light' }); await ctx.viewport(1120, 800)
    await ctx.capture('local-files-medium-light'); await ctx.overflow()
    await ctx.evaluate(() => document.querySelector('.wo-inspector').focus()); ctx.window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']}); ctx.window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']})
    await ctx.waitFor(() => document.activeElement.textContent === 'Contexto documentado')
    ctx.window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); ctx.window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'}); await ctx.waitFor(() => !document.querySelector('.wo-inspector'))
    ctx.check('Focus restored after drawer closes', await ctx.evaluate(() => document.activeElement.classList.contains('wo-tree')))
    await ctx.capture('local-summary-medium-light')
    await filter('Detached HEAD'); await select('Detached HEAD'); await wait(() => document.querySelector('.wo-local-changes li')?.textContent.includes('Em conflito'))
    ctx.check('Conflict has priority over invented added or deleted states', await ctx.evaluate(() => document.querySelector('.wo-local-changes li .wo-change-classification').textContent === 'Em conflito'))
    await ctx.evaluate(() => document.querySelector('[aria-label="Arquivos alterados"]').scrollIntoView({block:'start'})); await ctx.capture('conflict-files-medium-light')
    await ctx.evaluate(() => { document.querySelector('.wo-inspector').scrollTop = 0 }); await ctx.click('[aria-label="Fechar inspetor"]'); await wait(() => !document.querySelector('.wo-inspector'))
    await filter('zzz-reference'); await select('zzz-reference'); await wait(() => document.querySelector('[aria-label="Arquivos alterados"]')?.textContent.includes('Nenhuma alteração local nesta observação.'))
    await ctx.evaluate(() => document.querySelector('[aria-label="Arquivos alterados"]').scrollIntoView({block:'start'})); await ctx.capture('empty-files-medium-light')
    await ctx.evaluate(() => { document.querySelector('.wo-inspector').scrollTop = 0 }); await ctx.click('[aria-label="Fechar inspetor"]'); await wait(() => !document.querySelector('.wo-inspector'))
    await ctx.viewport(1440, 900); const refreshStart = performance.now(), refreshCalls = gitCalls; await refresh(); await wait(() => !document.querySelector('.wo-view').textContent.includes('Revalidando…')); const refreshMs = performance.now() - refreshStart, refreshGitCalls = gitCalls - refreshCalls
    ctx.check('No read mutation', before.refs === git(a,['show-ref']) && before.index === fs.readFileSync(path.join(await serviceGit.getWorktreeDirectory(a),'index')).toString('hex') && mutations === 0)
    ctx.check('Final runtime freshness MATCH', identity.getIdentityPayload().freshness.state === 'MATCH')
    fs.writeFileSync(path.join(ctx.evidenceDir,'local-signals-measurements.json'),JSON.stringify({fixture:21,inventoryMs,inventoryGitCalls,visibleMs,visibleReads,visibleGitCalls,navigationMs,navigationReads,refreshMs,refreshGitCalls,idleReads:0,maximum,observations,details,reads,stats:stats()},null,2))
  } finally { fs.writeFileSync(path.join(ctx.evidenceDir,'local-signals-detail-receipt.json'),JSON.stringify({details,reads,running})); controller.deactivate(); await management.deactivate(); for (const channel of ['work-orchestration:read', 'git-management:mutate', 'git-management:history', 'git-management:overview', 'git-management:commit-detail', 'git-management:patch']) ipcMain.removeHandler(channel) }
}
