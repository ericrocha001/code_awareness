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
  ctx.check('Runtime source is this implementation worktree', runtime.sourceOrigin.worktree.rootPath.toLowerCase() === ctx.projectRoot.toLowerCase() && runtime.sourceOrigin.worktree.branch === 'codex/work-orchestration-mvp')
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
  let state = { revision: 1, project: { id: 'acceptance-a', path: root, name: 'Orchestration acceptance' } }
  const projects = { getState: () => state }
  const serviceGit = new GitService()
  const reader = new GitOperationsService(root, serviceGit, new GitHubGitTransport(null, serviceGit), { repositoryId: 'acceptance-repository', isActive: () => state.project?.id === 'acceptance-a' })
  const controller = new WorkOrchestrationController(projects), management = new GitManagementController(projects)
  controller.bind(reader); management.bind(reader)
  const { ipcMain } = require('electron')
  const original = ipcMain.handle
  const reads = []
  let mode = 'normal', mutateDuringRead = false, mutations = 0
  ipcMain.handle = function(channel, handler) {
    original.call(this, channel, async (...args) => {
      if (channel === 'git-management:mutate') mutations++
      if (channel === 'work-orchestration:read') {
        reads.push(args[1])
        if (mode === 'error') return { success: false, code: 'GIT_READ_UNAVAILABLE' }
        const value = await handler(...args)
        if (value.success && mode === 'partial' && 'coverage' in value.data) { value.data.coverage = 'PARTIAL'; value.data.reason = 'PAIR_BUDGET_EXCEEDED'; value.data.pairs = [] }
        return value
      }
      return handler(...args)
    })
  }
  registerWorkOrchestrationHandlers(controller); registerGitManagementHandlers(management); ipcMain.handle = original
  const a = path.join(ctx.temporary, 'feature-with-a-long-path'), b = path.join(ctx.temporary, 'detached-work')
  const interval = reader.getCoordinationCommitPaths.bind(reader)
  reader.getCoordinationCommitPaths = async (...args) => {
    const value = await interval(...args)
    if (mutateDuringRead) { mutateDuringRead = false; fs.writeFileSync(path.join(a, 'drift.txt'), 'changed\n') }
    return value
  }
  const wait = async fn => {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) { if (await ctx.evaluate(fn)) return; await new Promise(resolve => setTimeout(resolve, 100)) }
    throw new Error('Orchestration acceptance condition timed out')
  }
  const refresh = async () => {
    const count = reads.length
    await ctx.click('.wo-header button')
    const deadline = Date.now() + 45000
    while (reads.length === count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    ctx.check('Refresh invokes a new production IPC read', reads.length > count)
    await wait(() => !document.querySelector('.wo-header button').disabled)
  }
  try {
    const preload = path.join(ctx.temporary, 'preload.cjs')
    buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', format: 'cjs', external: ['electron'] })
    ctx.window.webContents.session.setPreloads([preload])
    buildSync({ entryPoints: [path.join(__dirname, 'work-orchestration-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } })
    const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(fs.readFileSync(path.join(ctx.projectRoot, 'src/renderer/index.html'), 'utf8'))[1]
    const page = path.join(ctx.temporary, 'index.html')
    fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
    await ctx.window.loadFile(page, { query: { repositoryPath: root } }); await ctx.viewport(1440, 900)
    await wait(() => document.querySelectorAll('.wo-tree').length === 1)
    await ctx.capture('one-worktree-dark')
    git(root, ['worktree', 'add', '-b', 'feature/long-branch-name-for-panorama-and-layout-validation', a])
    fs.writeFileSync(path.join(a, 'shared.txt'), 'feature committed\n'); git(a, ['add', '.']); git(a, ['commit', '-m', 'feature'])
    await refresh(); ctx.check('Two worktrees have no secondary pairs', await ctx.evaluate(() => document.querySelectorAll('.wo-tree').length === 2 && document.querySelectorAll('.wo-pair').length === 0))
    await ctx.capture('two-worktrees-dark')
    git(root, ['worktree', 'add', '--detach', b])
    fs.writeFileSync(path.join(b, 'shared.txt'), 'detached committed\n'); git(b, ['add', '.']); git(b, ['commit', '-m', 'detached'])
    const before = await Promise.all([root, a, b].map(async dir => ({ refs: git(dir, ['show-ref']), snapshot: await serviceGit.captureWorktreeReadSnapshot(dir), content: fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8') })))
    await refresh(); await wait(() => document.querySelector('.wo-pair')?.textContent.includes('Path overlap'))
    await ctx.click('.wo-pair'); await ctx.waitFor(() => document.querySelector('.wo-paths')?.textContent.includes('shared.txt'))
    ctx.check('Committed-only overlap through production preload/IPC', reads.length >= 3 && await ctx.evaluate(() => document.querySelector('.wo-inspector').textContent.includes('Pair merge-base')))
    await ctx.capture('three-worktrees-overlap-dark'); await ctx.overflow()
    await ctx.viewport(1120, 800); await ctx.capture('medium-drawer-dark'); await ctx.overflow()
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] }); ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] })
    await ctx.waitFor(() => document.activeElement.tagName === 'SUMMARY')
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await ctx.waitFor(() => document.activeElement.getAttribute('aria-label') === 'Close inspector')
    ctx.check('Drawer contains keyboard focus', true)
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await ctx.waitFor(() => !document.querySelector('.wo-inspector'))
    ctx.check('Escape restores selection focus', await ctx.evaluate(() => document.activeElement.classList.contains('wo-pair')))
    await ctx.evaluate(() => { document.body.dataset.theme = 'light' }); await ctx.capture('medium-light')
    await ctx.evaluate(() => [...document.querySelectorAll('.wo-tree')].find(tree => tree.textContent.includes('Detached HEAD')).setAttribute('data-detached', 'true'))
    await ctx.click('[data-detached]'); await ctx.capture('detached-inspector-light'); await ctx.click('[aria-label="Close inspector"]')
    const after = await Promise.all([root, a, b].map(async dir => ({ refs: git(dir, ['show-ref']), snapshot: await serviceGit.captureWorktreeReadSnapshot(dir), content: fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8') })))
    ctx.check('Read-only refs/index/contents and no mutation IPC', JSON.stringify(before) === JSON.stringify(after) && mutations === 0)
    git(b, ['reset', '--hard', git(root, ['rev-parse', 'HEAD'])]); fs.writeFileSync(path.join(b, 'distinct.txt'), 'different\n'); git(b, ['add', '.']); git(b, ['commit', '-m', 'distinct'])
    await refresh(); ctx.check('Verified absence rendered', await ctx.evaluate(() => document.querySelector('.wo-pair').textContent.includes('No path overlap verified')))
    await ctx.capture('verified-absence-light')
    mutateDuringRead = true; await refresh(); ctx.check('Drift rendered as stale with partial coverage', await ctx.evaluate(() => document.querySelector('.wo-pair').textContent.includes('Stale') && document.querySelector('.wo-warning').textContent.includes('Partial coverage'))); await ctx.capture('stale-light')
    mode = 'partial'; await refresh(); ctx.check('Budget notice does not claim global absence', await ctx.evaluate(() => document.querySelector('.wo-warning').textContent.includes('12 eligible') && !document.querySelector('.wo-pair'))); await ctx.capture('partial-light')
    await ctx.evaluate(() => {
      for (const [selector, text] of [['[aria-label="First worktree"]', 'feature/'], ['[aria-label="Second worktree"]', 'Detached']]) {
        const select = document.querySelector(selector)
        select.value = [...select.options].find(option => option.textContent.includes(text)).value
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    await ctx.click('.wo-compare button'); await wait(() => !!document.querySelector('.wo-inspector') && !document.querySelector('.wo-header button').disabled)
    ctx.check('Explicit pair bypasses automatic budget through production IPC', reads.at(-1).pair && await ctx.evaluate(() => document.querySelector('.wo-inspector').textContent.includes('No path overlap verified')))
    await ctx.capture('explicit-pair-light'); await ctx.click('[aria-label="Close inspector"]')
    mode = 'error'; await refresh(); await ctx.capture('error-light'); mode = 'normal'
    git(b, ['switch', '--orphan', 'orphan-without-head']); await refresh(); ctx.check('No HEAD is indeterminate', await ctx.evaluate(() => document.querySelector('.wo-pair').textContent.includes('Indeterminate'))); await ctx.click('.wo-pair'); await ctx.capture('indeterminate-light'); await ctx.click('[aria-label="Close inspector"]')
    await ctx.click('.wo-toolbar button'); await wait(() => !!document.querySelector('.gm-view'))
    ctx.check('Git Management still accessible through Shell navigation', await ctx.evaluate(() => !!document.querySelector('.gm-view')))
    controller.deactivate(); await management.deactivate(); state = { revision: 2, project: { id: 'acceptance-b', path: other, name: 'Other project' } }
    const otherReader = new GitOperationsService(other, serviceGit, new GitHubGitTransport(null, serviceGit), { repositoryId: 'other-repository', isActive: () => true })
    controller.bind(otherReader); management.bind(otherReader)
    await ctx.evaluate(state => { window.dispatchEvent(new CustomEvent('fixture-project', { detail: state })); document.querySelectorAll('.global-sidebar-nav-item')[10].click() }, state)
    await wait(() => document.querySelectorAll('.wo-tree').length === 1)
    ctx.check('Project switch clears old worktrees and selection', await ctx.evaluate(() => !document.querySelector('.wo-inspector') && !document.querySelector('.wo-view').textContent.includes('long-branch')))
    await ctx.capture('project-switch-light')
    state = { revision: 3, project: null }; controller.deactivate()
    await ctx.evaluate(state => window.dispatchEvent(new CustomEvent('fixture-project', { detail: state })), state)
    await ctx.waitFor(() => document.querySelector('.wo-empty').textContent.includes('Select a project'))
    await ctx.capture('empty-project-light')
    ctx.check('Final runtime freshness MATCH', identity.getIdentityPayload().freshness.state === 'MATCH')
    fs.writeFileSync(path.join(ctx.evidenceDir, 'reads.json'), JSON.stringify(reads, null, 2))
  } finally {
    controller.deactivate(); await management.deactivate()
    for (const channel of ['work-orchestration:read', 'git-management:mutate', 'git-management:history', 'git-management:overview', 'git-management:commit-detail', 'git-management:patch']) ipcMain.removeHandler(channel)
  }
}
