const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync, build } = require('esbuild')
exports.run = async ctx => {
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export { GitService } from './src/main/core/git-service'; export { GitOperationsService } from './src/main/git-operations/git-operations-service'; export { GitHubGitTransport } from './src/main/github/github-git-transport'; export { WorkOrchestrationController, registerWorkOrchestrationHandlers } from './src/main/ipc/work-orchestration-handler'; export { GitManagementController, registerGitManagementHandlers } from './src/main/ipc/git-management-handler'; export { RuntimeIdentityProvider } from './src/main/runtime-identity/runtime-identity-provider'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] })
  const api = require(backend), identity = new api.RuntimeIdentityProvider({ rootDir: ctx.projectRoot, includedDirectories: ['src/main', 'src/shared', 'src/renderer/src'] })
  await identity.sourceOriginReady
  const runtime = identity.getIdentityPayload()
  ctx.check('Correct runtime source and freshness', runtime.sourceOrigin.worktree.rootPath.toLowerCase() === ctx.projectRoot.toLowerCase() && runtime.freshness.state === 'MATCH')
  fs.writeFileSync(path.join(ctx.evidenceDir, 'runtime-identity.json'), JSON.stringify(runtime, null, 2))
  const root = path.join(ctx.temporary, 'repository'); fs.mkdirSync(root)
  const git = args => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }); if (r.status) throw new Error(r.stderr) }
  git(['init']); git(['config', 'user.name', 'Acceptance']); git(['config', 'user.email', 'acceptance@example.test'])
  fs.writeFileSync(path.join(root, 'file.txt'), 'fixture\n'); git(['add', '.']); git(['commit', '-m', 'base'])
  const state = { revision: 1, project: { id: 'shell', path: root, name: 'Shell navigation acceptance' } }, projects = { getState: () => state }
  const serviceGit = new api.GitService(), reader = new api.GitOperationsService(root, serviceGit, new api.GitHubGitTransport(null, serviceGit), { repositoryId: 'shell-repository', isActive: () => true })
  const orchestration = new api.WorkOrchestrationController(projects), management = new api.GitManagementController(projects)
  orchestration.bind(reader); management.bind(reader)
  const { ipcMain } = require('electron'), original = ipcMain.handle
  let reads = 0
  ipcMain.handle = function(channel, handler) { original.call(this, channel, (...args) => { if (channel === 'work-orchestration:read') reads++; return handler(...args) }) }
  api.registerWorkOrchestrationHandlers(orchestration); api.registerGitManagementHandlers(management); ipcMain.handle = original
  ipcMain.handle('project:get-active', () => state); ipcMain.handle('deeplink:get-pending', () => null); ipcMain.handle('load-settings', () => ({ projectPreferences: {} }))
  const errors = []
  ctx.window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message) })
  try {
    const preload = path.join(ctx.temporary, 'preload.cjs')
    buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', format: 'cjs', external: ['electron'] }); ctx.window.webContents.session.setPreloads([preload])
    const plugin = { name: 'unrelated-feature-fixtures', setup(build) {
      build.onResolve({ filter: /components\// }, args => {
        if (!args.importer.endsWith(`${path.sep}App.tsx`) || /GitManagementView|WorkOrchestrationTab/.test(args.path)) return
        return { path: args.path.split('/').pop(), namespace: 'shell-fixture' }
      })
      build.onLoad({ filter: /.*/, namespace: 'shell-fixture' }, args => {
        if (args.path === 'GlobalSidebar') return { contents: `import React from 'react'; import {GlobalSidebarNav} from ${JSON.stringify(path.join(ctx.projectRoot, 'src/renderer/src/components/GlobalSidebar/GlobalSidebarNav'))}; import {NAV_ITEMS} from ${JSON.stringify(path.join(ctx.projectRoot, 'src/renderer/src/config/navigation'))}; export const GlobalSidebar = p => React.createElement('aside',{className:'global-sidebar sidebar-open'},React.createElement(GlobalSidebarNav,{items:NAV_ITEMS,activeTab:p.activeTab,onSelect:p.setActiveTab,isSidebarOpen:true}));`, resolveDir: ctx.projectRoot }
        return { contents: `import React from 'react'; export const ${args.path} = () => React.createElement('section',{'data-shell-panel':${JSON.stringify(args.path)}},${JSON.stringify(args.path)});`, resolveDir: ctx.projectRoot }
      })
    } }
    await build({ entryPoints: [path.join(__dirname, 'shell-navigation-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [plugin], loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } })
    const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(fs.readFileSync(path.join(ctx.projectRoot, 'src/renderer/index.html'), 'utf8'))[1]
    const page = path.join(ctx.temporary, 'index.html')
    fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
    await ctx.load(page); await ctx.viewport(1440, 900)
    const navigate = async label => { await ctx.evaluate(label => { document.querySelector('[data-nav-target]')?.removeAttribute('data-nav-target'); [...document.querySelectorAll('.global-sidebar-nav-item')].find(button => button.textContent.trim() === label).setAttribute('data-nav-target', '') }, label); await ctx.click('[data-nav-target]'); await ctx.waitFor(label => document.querySelector('[aria-current="page"]')?.textContent.trim() === label, label) }
    await navigate('Work Orchestration'); await ctx.waitFor(() => document.querySelector('.wo-toolbar').textContent.includes('1 descoberta'))
    await ctx.waitFor(() => document.querySelector('.wo-tree')?.textContent.includes('Observação verificada'))
    const retainedReads = reads
    for (let cycle = 0; cycle < 3; cycle++) for (const label of ['Git Management', 'Work Orchestration', 'Code Source', 'Channel', 'Home']) {
      await navigate(label)
      ctx.check(`${cycle}:${label}: only the active panel visible`, await ctx.evaluate(label => {
        const main = document.querySelector('.app-main'), panels = [...main.children].filter(child => getComputedStyle(child).display !== 'none')
        return panels.length === 1 && document.querySelectorAll('.wo-tab').length === 1 && document.querySelectorAll('.wo-view').length === 1 && document.querySelectorAll('.gm-view').length === (label === 'Git Management' ? 1 : 0)
      }, label))
    }
    ctx.check('Retained Orchestration performs no extra reads', reads === retainedReads)
    ctx.check('No duplicate-key runtime warnings', !errors.some(message => /same key/.test(message)))
    await navigate('Git Management'); await ctx.waitFor(() => document.querySelector('.gm-view')?.textContent.includes('1 commits')); await ctx.capture('single-git-management-dark'); await ctx.overflow()
    await navigate('Work Orchestration'); await ctx.capture('single-work-orchestration-dark')
    await ctx.evaluate(() => { document.body.dataset.theme = 'light' }); await ctx.viewport(1120, 800); await navigate('Git Management'); await ctx.capture('single-git-management-light'); await navigate('Work Orchestration'); await ctx.capture('single-work-orchestration-light')
    ctx.check('Final freshness MATCH', identity.getIdentityPayload().freshness.state === 'MATCH')
  } finally { orchestration.deactivate(); await management.deactivate(); for (const channel of ['work-orchestration:read', 'git-management:mutate', 'git-management:history', 'git-management:overview', 'git-management:commit-detail', 'git-management:patch', 'project:get-active', 'deeplink:get-pending', 'load-settings']) ipcMain.removeHandler(channel) }
}
