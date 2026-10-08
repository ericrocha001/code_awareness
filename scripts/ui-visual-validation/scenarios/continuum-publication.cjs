const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')

exports.run = async ctx => {
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export { registerContinuumHandlers } from './src/main/ipc/continuum-handler'; export { RepositoryContinuumSession } from './src/main/continuum/project-continuum-session'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] })
  const { registerContinuumHandlers, RepositoryContinuumSession } = require(backend)
  const repositoryPath = path.join(ctx.temporary, 'repository-A')
  const otherPath = path.join(ctx.temporary, 'repository-B')
  fs.mkdirSync(repositoryPath); fs.mkdirSync(otherPath)
  const session = new RepositoryContinuumSession(path.join(ctx.temporary, 'storage'), { findByPath: candidate => ({ id: candidate === repositoryPath ? 'acceptance-A' : 'acceptance-B', localCheckout: { path: candidate } }) })
  session.activate(repositoryPath)
  const unsubscribe = registerContinuumHandlers(session)
  const preload = path.join(ctx.temporary, 'preload.cjs')
  buildSync({ entryPoints: [path.join(ctx.projectRoot, 'src/main/preload.ts')], bundle: true, outfile: preload, platform: 'node', format: 'cjs', external: ['electron'] })
  ctx.window.webContents.session.setPreloads([preload])
  buildSync({ entryPoints: [path.join(__dirname, 'continuum-publication-fixture.tsx')], bundle: true, outfile: path.join(ctx.temporary, 'fixture.js'), platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } })
  const page = path.join(ctx.temporary, 'index.html')
  fs.writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}body{background:var(--bg-primary);color:var(--text-primary)}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  const text = '\uFEFF---\r\nname: Publication acceptance\r\ndescription: Isolated exact text proof\r\nkind: VALIDATION_PROOF\r\n---\r\n# Literal publication\r\n\r\nç 日本語 🚀 `${literal}` $(command)\r\n'
  const validFile = path.join(ctx.temporary, 'valid.md')
  const invalidFile = path.join(ctx.temporary, 'invalid.md')
  const obsidianFile = path.join(ctx.temporary, 'Obsidian — ç 日本語.md')
  const obsidianText = '\uFEFF\r\n# Obsidian note\r\n\r\n  ç 日本語 🚀 [[Link]] `${literal}` $(command)  \r\n\r\n'
  fs.writeFileSync(validFile, text, 'utf8'); fs.writeFileSync(invalidFile, '---\nname: Incomplete\n---\n# Missing required fields', 'utf8')
  fs.writeFileSync(obsidianFile, obsidianText, 'utf8')
  try {
    await ctx.window.loadFile(page, { query: { repositoryPath } })
    await ctx.waitFor(() => !document.querySelector('.continuum-publish').disabled)
    await ctx.viewport(1440, 900)
    await ctx.capture('before-publication')
    ctx.window.webContents.debugger.attach('1.3')
    await ctx.window.webContents.debugger.sendCommand('Page.enable')
    const chooseFile = async file => {
      await ctx.window.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
      const opened = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ctx.window.webContents.debugger.removeListener('message', listener); reject(new Error('File chooser did not open')) }, 5000)
        const listener = (_event, method, params) => {
          if (method === 'Page.fileChooserOpened') { clearTimeout(timer); ctx.window.webContents.debugger.removeListener('message', listener); resolve(params) }
        }
        ctx.window.webContents.debugger.on('message', listener)
      })
      await ctx.click('.continuum-publish')
      const chooser = await opened
      await ctx.window.webContents.debugger.sendCommand('DOM.setFileInputFiles', { files: [file], backendNodeId: chooser.backendNodeId })
    }
    await chooseFile(validFile)
    await ctx.waitFor(() => document.querySelector('[role="status"]')?.textContent.includes('Artifact publicado'))
    await ctx.waitFor(() => document.querySelectorAll('.continuum-item').length === 1)
    const service = session.getActiveService()
    const created = service.list().artifacts
    ctx.check('Exactly one persisted Artifact with exact UTF-8/BOM/CRLF text and revision 1', created.length === 1 && service.get(created[0].artifactId).rawMarkdown === text && service.get(created[0].artifactId).revision === 1)
    await ctx.click('.continuum-item')
    await ctx.waitFor(() => document.querySelector('.continuum-markdown h1')?.textContent === 'Literal publication')
    ctx.check('Inspector displays the persisted body', await ctx.evaluate(() => document.querySelector('.continuum-markdown').textContent.includes('日本語 🚀')))
    const after = await ctx.capture('published-dark')
    const beforeBytes = fs.readFileSync(path.join(ctx.evidenceDir, 'before-publication.png'))
    ctx.check('Publication changes rendered pixels', !beforeBytes.equals(after.toPNG()))
    await ctx.evaluate(() => { document.body.dataset.theme = 'light' })
    await ctx.viewport(1000, 760)
    await ctx.overflow()
    await ctx.capture('published-light')
    await chooseFile(obsidianFile)
    await ctx.waitFor(() => document.querySelectorAll('.continuum-item').length === 2)
    const imported = service.list().artifacts.find(item => item.kind === 'DOCUMENT')
    const importedArtifact = service.get(imported.artifactId)
    ctx.check('Body-only Obsidian file gets only default metadata with current ISO timestamp', imported.name === 'Obsidian — ç 日本語' &&
      importedArtifact.metadata.description === 'Documento Markdown publicado manualmente pela interface do Continuum. Abra para consultar seu conteúdo.' &&
      Object.keys(importedArtifact.metadata).sort().join(',') === 'date,description,kind,name' &&
      /Z$/.test(importedArtifact.metadata.date) && Math.abs(Date.now() - Date.parse(importedArtifact.metadata.date)) < 5000)
    ctx.check('Original Obsidian text remains exact after generated frontmatter and local file is unchanged', importedArtifact.rawMarkdown.startsWith('\uFEFF---\n') &&
      importedArtifact.rawMarkdown.slice(importedArtifact.rawMarkdown.indexOf('\n---\n') + 5) === obsidianText.slice(1) &&
      fs.readFileSync(obsidianFile, 'utf8') === obsidianText && fs.readFileSync(validFile, 'utf8') === text)
    await ctx.evaluate(id => document.querySelectorAll('.continuum-item').forEach(button => {
      if (button.textContent.includes('Obsidian —')) button.click()
    }), imported.artifactId)
    await ctx.waitFor(() => document.querySelector('.continuum-markdown h1')?.textContent === 'Obsidian note')
    await ctx.capture('obsidian-auto-frontmatter')
    await chooseFile(invalidFile)
    await ctx.waitFor(() => !!document.querySelector('[role="alert"]'))
    ctx.check('Explicit incomplete YAML error leaves persistence unchanged', service.list().artifacts.length === 2)
    await ctx.capture('invalid-markdown')
    session.activate(otherPath)
    await ctx.waitFor(() => document.querySelector('.continuum-publish').disabled)
    const staleRejected = await ctx.evaluate(async (rawMarkdown) => {
      try { await window.codeAwareness.publishContinuumArtifact({ repositoryId: 'acceptance-A', fileName: 'stale.md', rawMarkdown }); return false }
      catch (error) { return String(error).includes('REPOSITORY_UNAVAILABLE') }
    }, text)
    ctx.check('Stale renderer identity cannot publish in switched repository', staleRejected && session.getActiveService().list().artifacts.length === 0)
    session.activate(repositoryPath)
    ctx.check('Both publications remain unchanged across restart', session.getActiveService().list().artifacts.length === 2 && session.getActiveService().get(created[0].artifactId).rawMarkdown === text && session.getActiveService().get(imported.artifactId).rawMarkdown === importedArtifact.rawMarkdown)
  } finally {
    if (ctx.window.webContents.debugger.isAttached()) ctx.window.webContents.debugger.detach()
    unsubscribe(); session.dispose()
    ctx.window.webContents.session.setPreloads([])
  }
}
