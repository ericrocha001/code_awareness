const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
exports.run = async ctx => {
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export { GitService } from './src/main/core/git-service'; export { GitOperationsService } from './src/main/git-operations/git-operations-service'; export { GitHubGitTransport } from './src/main/github/github-git-transport'; export { WorkOrchestrationController, registerWorkOrchestrationHandlers } from './src/main/ipc/work-orchestration-handler'; export { GitManagementController, registerGitManagementHandlers } from './src/main/ipc/git-management-handler'; export { RuntimeIdentityProvider } from './src/main/runtime-identity/runtime-identity-provider'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] })
  const { GitService, GitOperationsService, GitHubGitTransport, WorkOrchestrationController, registerWorkOrchestrationHandlers, GitManagementController, registerGitManagementHandlers, RuntimeIdentityProvider } = require(backend)
  const identity = new RuntimeIdentityProvider({ rootDir: ctx.projectRoot, includedDirectories: ['src/main', 'src/shared', 'src/renderer/src'] })
  await identity.sourceOriginReady
  const runtime = identity.getIdentityPayload()
  fs.writeFileSync(path.join(ctx.evidenceDir, 'runtime-identity.json'), JSON.stringify(runtime, null, 2))
  ctx.check('Correct worktree and baseline HEAD', runtime.sourceOrigin.worktree.rootPath.toLowerCase() === ctx.projectRoot.toLowerCase() && runtime.sourceOrigin.worktree.branch === 'codex/work-orchestration-mvp' && runtime.sourceOrigin.worktree.head === 'dcdd7a12e923eaa941795075bb2220b7685745ed')
  ctx.check('Runtime freshness MATCH', runtime.freshness.state === 'MATCH')
  const git = (root, args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  const root = path.join(ctx.temporary, 'repository'), other = path.join(ctx.temporary, 'other')
  for (const dir of [root, other]) {
    fs.mkdirSync(dir); git(dir, ['init']); git(dir, ['config', 'user.name', 'Acceptance']); git(dir, ['config', 'user.email', 'acceptance@example.test'])
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'base\n'); git(dir, ['add', '.']); git(dir, ['commit', '-m', 'base'])
  }
  git(root, ['branch', '-m', 'zzz-reference'])
  const a = path.join(ctx.temporary, 'feature-with-a-long-path'), b = path.join(ctx.temporary, 'detached-work')
  git(root, ['worktree', 'add', '-b', 'feature/long-branch-name-for-panorama-and-layout-validation', a]); git(root, ['worktree', 'add', '--detach', b])
  for (const [dir, text] of [[a, 'feature'], [b, 'detached']]) { fs.writeFileSync(path.join(dir, 'shared.txt'), text + '\n'); git(dir, ['add', '.']); git(dir, ['commit', '-m', text]) }
  for (let i = 0; i < 18; i++) git(root, ['worktree', 'add', '-b', `work-${String(i).padStart(3, '0')}`, path.join(ctx.temporary, `work-${i}`)])
  let state = { revision: 1, project: { id: 'acceptance-a', path: root, name: 'Orchestration acceptance' } }
  const projects = { getState: () => state }, serviceGit = new GitService()
  const reader = new GitOperationsService(root, serviceGit, new GitHubGitTransport(null, serviceGit), { repositoryId: 'acceptance-repository', isActive: () => state.project?.id === 'acceptance-a' })
  let snapshots = 0, commits = 0, mutations = 0
  const snapshot = reader.getCoordinationSnapshot.bind(reader), interval = reader.getCoordinationCommitPaths.bind(reader)
  reader.getCoordinationSnapshot = async (...args) => { snapshots++; return snapshot(...args) }
  reader.getCoordinationCommitPaths = async (...args) => { commits++; return interval(...args) }
  const controller = new WorkOrchestrationController(projects), management = new GitManagementController(projects)
  controller.bind(reader); management.bind(reader)
  const { ipcMain } = require('electron'), original = ipcMain.handle, reads = []
  let mode = 'normal', releaseInventory
  ipcMain.handle = function(channel, handler) {
    original.call(this, channel, async (...args) => {
      if (channel === 'git-management:mutate') mutations++
      if (channel !== 'work-orchestration:read') return handler(...args)
      const request = args[1], currentMode = mode, inventory = !request.pair && !request.worktree
      reads.push(request)
      if (inventory && currentMode === 'error') return { success: false, code: 'GIT_READ_UNAVAILABLE' }
      if (inventory && currentMode === 'delay') await new Promise(resolve => { releaseInventory = resolve })
      const result = await handler(...args)
      if (inventory && currentMode === 'large' && result.success) {
        const template = result.data.worktrees.find(w => !w.reference)
        for (let i = 0; i < 100; i++) result.data.worktrees.push({ ...template, worktreeId: (50000 + i).toString(16).padStart(64, '0'), generation: `synthetic-${i}`, branch: `synthetic-work-${String(i).padStart(3, '0')}`, path: `C:/fixture/synthetic-work-${i}`, reference: false })
      }
      return result
    })
  }
  registerWorkOrchestrationHandlers(controller); registerGitManagementHandlers(management); ipcMain.handle = original
  const stats = () => ({ inventory: reads.filter(r => !r.worktree && !r.pair).length, inspect: reads.filter(r => r.worktree).length, pair: reads.filter(r => r.pair).length, snapshots, commits })
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
  const filter = async text => { await ctx.evaluate(text => { const input = document.querySelector('[aria-label="Filter worktrees"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) }, text) }
  const select = async text => {
    await ctx.evaluate(text => { document.querySelector('[data-tree-target]')?.removeAttribute('data-tree-target'); [...document.querySelectorAll('.wo-tree')].find(button => button.textContent.includes(text)).setAttribute('data-tree-target', '') }, text)
    await ctx.click('[data-tree-target]'); await wait(() => document.querySelector('.wo-inspector')?.textContent.includes('Last status observation') && !document.querySelector('.wo-inspector').textContent.includes('Reading selected'))
  }
  const compare = async text => {
    await ctx.evaluate(text => { const select = document.querySelector('[aria-label="Compare with worktree"]'); select.value = [...select.options].find(option => option.textContent.includes(text)).value; select.dispatchEvent(new Event('change', { bubbles: true })) }, text)
    await ctx.click('.wo-context-compare button'); await wait(() => !!document.querySelector('.wo-inspector .wo-paths') && !document.querySelector('.wo-inspector').textContent.includes('Reading selected'))
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
    const before = await Promise.all([root, a, b].map(async dir => ({ refs: git(dir, ['show-ref']), snapshot: await serviceGit.captureWorktreeReadSnapshot(dir), index: fs.readFileSync(path.join(await serviceGit.getWorktreeDirectory(dir), 'index')).toString('hex'), content: fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8') })))
    await ctx.window.loadFile(page, { query: { repositoryPath: root } }); await ctx.viewport(1440, 900)
    ctx.check('No discovery before first visit', reads.length === 0)
    await navigate('Work Orchestration'); await wait(() => document.querySelectorAll('.wo-tree').length === 21)
    await wait(() => !document.querySelector('.wo-header button').disabled && document.querySelector('.wo-toolbar').textContent.includes('21 discovered'))
    ctx.check('Complete immediate inventory with zero status/pair reads', stats().inventory === 1 && snapshots === 0 && commits === 0)
    ctx.check('Reference first by checkout identity, statuses unobserved', await ctx.evaluate(() => document.querySelector('.wo-tree').textContent.includes('zzz-reference') && !document.querySelector('.wo-view').textContent.includes('Locally clean') && document.querySelector('.wo-relations').textContent.includes('not evaluated')))
    ctx.check('No fixed pair form or Git Management links', await ctx.evaluate(() => !document.querySelector('.wo-compare') && !document.querySelector('.wo-view').textContent.includes('Git Management')))
    await ctx.capture('inventory-21-dark'); await ctx.overflow()
    await ctx.input('[aria-label="Filter worktrees"]', 'feature/'); await select('feature/'); await compare('Detached HEAD')
    ctx.check('Contextual committed overlap', await ctx.evaluate(() => document.querySelector('.wo-paths').textContent.includes('shared.txt')))
    await ctx.capture('contextual-overlap-dark')
    const tabStats = stats()
    await navigate('Home'); ctx.check('Inactive view hidden from focus', await ctx.evaluate(() => document.querySelector('.wo-tab').hidden && !document.querySelector('.wo-tab').contains(document.activeElement)))
    await navigate('Work Orchestration'); await navigate('Home'); await navigate('Work Orchestration')
    ctx.check('Zero new reads on tab returns; filter and pair restored', JSON.stringify(stats()) === JSON.stringify(tabStats) && await ctx.evaluate(() => document.querySelector('[aria-label="Filter worktrees"]').value === 'feature/' && !!document.querySelector('.wo-inspector .wo-paths')))
    await ctx.capture('tab-return-dark')
    mode = 'delay'; await startRefresh(); ctx.check('Refresh retains previous list and selection', await ctx.evaluate(() => !!document.querySelector('.wo-tree') && !!document.querySelector('.wo-inspector') && document.querySelector('.wo-freshness').textContent.includes('previous observation'))); await ctx.capture('refresh-pending-dark'); mode = 'normal'; releaseInventory(); await wait(() => !document.querySelector('.wo-header button').disabled)
    mode = 'error'; await refresh(); ctx.check('Failure retains inventory marked not revalidated', await ctx.evaluate(() => document.querySelector('.wo-freshness').textContent.includes('Not revalidated') && !!document.querySelector('.wo-tree'))); await ctx.capture('refresh-error-dark'); mode = 'normal'; await refresh()
    await ctx.viewport(1120, 800); await ctx.capture('medium-drawer-dark'); await ctx.overflow()
    await ctx.evaluate(() => document.querySelector('.wo-inspector').focus())
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] }); ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] }); await ctx.waitFor(() => document.activeElement.tagName === 'SUMMARY')
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await ctx.waitFor(() => !document.querySelector('.wo-inspector'))
    ctx.check('Keyboard closes drawer and restores row focus', await ctx.evaluate(() => document.activeElement.classList.contains('wo-tree')))
    await ctx.evaluate(() => { document.body.dataset.theme = 'light' }); await select('feature/'); await compare('zzz-reference'); ctx.check('Explicit comparison with reference available', reads.at(-1).pair && await ctx.evaluate(() => document.querySelector('.wo-inspector').textContent.includes('No path overlap verified') && !document.querySelector('.wo-pair')?.textContent.includes('No path overlap'))); await ctx.capture('reference-comparison-light'); await ctx.click('[aria-label="Close inspector"]')
    await filter(''); await select('Detached HEAD'); await ctx.capture('detached-inspector-light'); await ctx.click('[aria-label="Close inspector"]')
    mode = 'large'; await refresh(); await wait(() => document.querySelectorAll('.wo-tree').length === 121)
    await ctx.capture('inventory-121-light'); await ctx.evaluate(() => { const pane = document.querySelector('.wo-content'); pane.scrollTop = pane.scrollHeight }); await ctx.capture('inventory-121-scrolled-light')
    const scroll = await ctx.evaluate(() => document.querySelector('.wo-content').scrollTop), largeStats = stats()
    await navigate('Home'); await navigate('Work Orchestration')
    ctx.check('Large list scroll restored with zero reads', await ctx.evaluate(scroll => document.querySelector('.wo-content').scrollTop === scroll, scroll) && JSON.stringify(stats()) === JSON.stringify(largeStats))
    await filter('synthetic-work-099'); await ctx.waitFor(() => document.querySelectorAll('.wo-tree').length === 1); await ctx.capture('filter-beyond-100-light')
    await filter('feature/'); await select('feature/'); await compare('Detached HEAD'); await ctx.capture('large-contextual-compare-light'); await ctx.overflow()
    const after = await Promise.all([root, a, b].map(async dir => ({ refs: git(dir, ['show-ref']), snapshot: await serviceGit.captureWorktreeReadSnapshot(dir), index: fs.readFileSync(path.join(await serviceGit.getWorktreeDirectory(dir), 'index')).toString('hex'), content: fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8') })))
    ctx.check('Read-only HEAD/index/files/refs and no mutation IPC', JSON.stringify(before) === JSON.stringify(after) && mutations === 0)
    await ctx.viewport(1440, 900)
    mode = 'delay'; await startRefresh(); await navigate('Home'); controller.deactivate(); await management.deactivate()
    state = { revision: 2, project: { id: 'acceptance-b', path: other, name: 'Other project' } }
    const otherReader = new GitOperationsService(other, serviceGit, new GitHubGitTransport(null, serviceGit), { repositoryId: 'other-repository', isActive: () => true }); controller.bind(otherReader); management.bind(otherReader)
    await ctx.evaluate(state => window.dispatchEvent(new CustomEvent('fixture-project', { detail: state })), state); mode = 'normal'; releaseInventory()
    await ctx.waitFor(() => !document.querySelector('.wo-view'))
    ctx.check('New context remains lazy while inactive', await ctx.evaluate(() => document.querySelector('.wo-tab').hidden))
    await navigate('Work Orchestration'); await wait(() => document.querySelectorAll('.wo-tree').length === 1)
    ctx.check('New project ignores delayed old response and cached selection/filter', await ctx.evaluate(() => !document.querySelector('.wo-inspector') && document.querySelector('[aria-label="Filter worktrees"]').value === '' && document.querySelector('.wo-header').textContent.includes('Other project')))
    await ctx.capture('project-switch-light')
    state = { revision: 3, project: null }; controller.deactivate(); await ctx.evaluate(state => window.dispatchEvent(new CustomEvent('fixture-project', { detail: state })), state); await ctx.waitFor(() => document.querySelector('.wo-empty').textContent.includes('Select a project')); await ctx.capture('empty-project-light')
    ctx.check('Final runtime freshness MATCH', identity.getIdentityPayload().freshness.state === 'MATCH')
    fs.writeFileSync(path.join(ctx.evidenceDir, 'reads.json'), JSON.stringify({ reads, tabStats, largeStats, finalStats: stats() }, null, 2))
  } finally { controller.deactivate(); await management.deactivate(); for (const channel of ['work-orchestration:read', 'git-management:mutate', 'git-management:history', 'git-management:overview', 'git-management:commit-detail', 'git-management:patch']) ipcMain.removeHandler(channel) }
}
