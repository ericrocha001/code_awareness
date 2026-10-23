const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawn } = require('node:child_process'), { randomUUID } = require('node:crypto'), assert = require('node:assert/strict')
const root = process.cwd(), output = path.join(root, '.code-awareness/active-context-b')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.on('exit', code => { process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-context-ipc-'))
  for (const key of ['userData', 'appData', 'sessionData', 'temp', 'home']) { const file = path.join(directory, key); fs.mkdirSync(file); app.setPath(key, file) }
  app.setName('Preview Context IPC Acceptance Fixture'); app.enableSandbox()
  app.whenReady().then(async () => {
    const entries = ['core/active-project-service', 'core/git-service', 'git-operations/git-worktree-registry', 'repository-catalog/repository-catalog-store', 'repository-catalog/repository-catalog-service', 'repository-catalog/repository-runtime-service', 'ipc/active-project-handler', 'ipc/code-map-handler', 'ipc/workspace-handler']
    const pkg = require(path.join(root, 'package.json')), external = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(name => !['mdast-util-from-markdown', 'micromark-extension-gfm', 'mdast-util-gfm', 'mdast-util-to-string'].includes(name))
    const bundle = path.join(output, 'ipc-bundle')
    require('esbuild').buildSync({ entryPoints: entries.map(file => 'src/main/' + file + '.ts'), outdir: bundle, platform: 'node', format: 'cjs', bundle: true, external, logLevel: 'silent' })
    const get = name => require(path.join(bundle, name + '.js'))
    const repositoryId = 'e1c8a999-6d73-4f56-83a3-fbcd78c9c19d'
    const git = new (get('core/git-service').GitService)()
    const tree = await new (get('git-operations/git-worktree-registry').GitWorktreeRegistry)(root, git, { repositoryId, isActive: () => true }).current()
    const store = new (get('repository-catalog/repository-catalog-store').RepositoryCatalogStore)(path.join(directory, 'catalog.db'))
    const { RepositoryCatalogService, normalizeRepositoryPath } = get('repository-catalog/repository-catalog-service')
    const record = store.provisionPreviewIdentity(repositoryId, { path: root, normalizedPath: normalizeRepositoryPath(root), name: 'IPC fixture checkout', status: 'ACTIVE', availability: 'AVAILABLE', gitState: 'GIT' })
    const catalog = new RepositoryCatalogService(store, {})
    const codeMap = { getOpenProjects: () => [], closeRepository: () => { throw Error('UNEXPECTED_CODEMAP_CALL') }, openRepository: async () => { throw Error('UNEXPECTED_CODEMAP_CALL') } }
    const active = new (get('core/active-project-service').ActiveProjectService)(codeMap, () => record, { mode: 'PREVIEW', sessionId: randomUUID(), target: { repositoryId, path: root, worktreeId: tree.worktreeId, generation: tree.generation }, dataPolicy: 'EMPTY' })
    await active.bind(record)
    const runtime = new (get('repository-catalog/repository-runtime-service').RepositoryRuntimeService)(catalog, codeMap, active)
    get('ipc/active-project-handler').registerActiveProjectHandlers(active)
    get('ipc/code-map-handler').registerCodeMapHandlers(codeMap, active)
    get('ipc/workspace-handler').registerWorkspaceHandlers({}, catalog, runtime, target => active.assertContextSelection(target))
    const preload = path.join(directory, 'probe.cjs')
    fs.writeFileSync(preload, `const {ipcRenderer}=require('electron');ipcRenderer.on('context:probe',async()=>{const result={before:await ipcRenderer.invoke('project:get-active'),project:await ipcRenderer.invoke('project:activate',null),repository:await ipcRenderer.invoke('repositories:activate','other-repository'),checkout:await ipcRenderer.invoke('code-map:open-repository','C:/not-the-selected-checkout'),close:await ipcRenderer.invoke('code-map:close-repository',${JSON.stringify(root)}),after:await ipcRenderer.invoke('project:get-active')};try{await ipcRenderer.invoke('repositories:refresh');result.refresh='UNEXPECTED_SUCCESS'}catch(error){result.refresh=error.message}ipcRenderer.send('context:result',result)})`)
    const window = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    const completed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('IPC_PROBE_TIMEOUT')), 15000)
      ipcMain.once('context:result', (event, result) => {
        if (event.sender !== window.webContents) return reject(Error('WRONG_SENDER'))
        clearTimeout(timeout); resolve(result)
      })
    })
    await window.loadURL('about:blank'); window.webContents.send('context:probe')
    const result = await completed
    for (const key of ['project', 'repository', 'checkout', 'close']) assert.deepEqual(result[key], { success: false, code: 'PREVIEW_CONTEXT_LOCKED', error: 'PREVIEW_CONTEXT_LOCKED' })
    assert.match(result.refresh, /PREVIEW_CONTEXT_LOCKED/); assert.deepEqual(result.after, result.before)
    fs.writeFileSync(path.join(output, 'context-ipc-real.json'), JSON.stringify({ scope: 'ISOLATED_TRANSPORT_FIXTURE_WITH_PRODUCTION_HANDLERS', platform: process.platform, electron: process.versions.electron, tree, result }, null, 2))
    await active.dispose(); store.close(); window.destroy(); console.log('Windows Electron IPC context lock PASS'); app.exit(0)
  }).catch(error => { console.error(error.stack); app.exit(1) })
}
