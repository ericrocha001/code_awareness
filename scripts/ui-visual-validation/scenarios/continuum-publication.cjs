const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')

exports.run = async ctx => {
  const backend = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({ stdin: { contents: "export { registerContinuumHandlers } from './src/main/ipc/continuum-handler'; export { RepositoryContinuumSession } from './src/main/continuum/project-continuum-session'; export { ArtifactStore } from './src/main/continuum/artifact-store'", resolveDir: ctx.projectRoot }, bundle: true, outfile: backend, platform: 'node', format: 'cjs', alias: { sharp: require.resolve('sharp') }, external: ['electron', 'better-sqlite3', require.resolve('sharp')] })
  const { registerContinuumHandlers, RepositoryContinuumSession, ArtifactStore } = require(backend)
  const repositoryPath = path.join(ctx.temporary, 'repository-A')
  const otherPath = path.join(ctx.temporary, 'repository-B')
  fs.mkdirSync(repositoryPath); fs.mkdirSync(otherPath)
  const session = new RepositoryContinuumSession(path.join(ctx.temporary, 'storage'), { findByPath: candidate => ({ id: candidate === repositoryPath ? 'acceptance-A' : 'acceptance-B', localCheckout: { path: candidate } }) })
  session.activate(repositoryPath)
  const { ipcMain } = require('electron')
  const originalHandle = ipcMain.handle
  const reads = { thumbnail: [], original: [], active: 0, peak: 0 }
  ipcMain.handle = function(channel, handler) {
    return originalHandle.call(this, channel, async (...args) => {
      const thumbnail = channel === 'continuum:get-visual-thumbnail'
      if (thumbnail) { reads.thumbnail.push(args[2]); reads.active++; reads.peak = Math.max(reads.peak, reads.active) }
      if (channel === 'continuum:get-visual') reads.original.push(args[2])
      try {
        const result = await handler(...args)
        if (thumbnail) ctx.check('Thumbnail delivery stays below 128 KiB', result.data.byteLength <= 128 * 1024)
        return result
      } finally { if (thumbnail) reads.active-- }
    })
  }
  const unsubscribe = registerContinuumHandlers(session)
  ipcMain.handle = originalHandle
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
    const chooseFile = async (file, selector = '.continuum-publish') => {
      await ctx.window.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
      const opened = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ctx.window.webContents.debugger.removeListener('message', listener); reject(new Error('File chooser did not open')) }, 5000)
        const listener = (_event, method, params) => {
          if (method === 'Page.fileChooserOpened') { clearTimeout(timer); ctx.window.webContents.debugger.removeListener('message', listener); resolve(params) }
        }
        ctx.window.webContents.debugger.on('message', listener)
      })
      await ctx.click(selector)
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
    const sharp = require('sharp')
    const source = fs.readFileSync(path.join(ctx.projectRoot, 'docs/design-system/examples/channel-runtime-v1.png'))
    const sourceMetadata = await sharp(source).metadata()
    ctx.check('Explicit curated PNG preparation is static 8-bit RGB', sourceMetadata.depth === 'uchar' && (sourceMetadata.pages || 1) === 1 && ['srgb', 'rgb'].includes(sourceMetadata.space) && !sourceMetadata.icc)
    const canonical = await sharp(source).webp({ lossless: true, effort: 6 }).toBuffer()
    ctx.check('Prepared WebP preserves source pixels and alpha exactly', (await sharp(source).ensureAlpha().raw().toBuffer()).equals(await sharp(canonical).ensureAlpha().raw().toBuffer()))
    const canonicalPath = path.join(ctx.evidenceDir, 'channel-reference.webp')
    fs.writeFileSync(canonicalPath, canonical)
    await ctx.waitFor(() => !document.querySelector('.continuum-publish').disabled)
    await ctx.input('.continuum-header input[type=search], .continuum-header .sb-input', 'Obsidian')
    await chooseFile(canonicalPath, '.continuum-header button:last-of-type')
    await ctx.waitFor(() => !!document.querySelector('.continuum-visual-publication'))
    await ctx.input('.continuum-visual-publication label:nth-of-type(2) input', 'Exemplar visual canônico do Channel')
    await ctx.input('.continuum-visual-publication textarea', 'Exemplar derivado do Design System, preparado explicitamente em WebP lossless.')
    await ctx.evaluate(id => {
      const select = document.querySelector('.continuum-visual-publication select')
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(select, id); select.dispatchEvent(new Event('change', { bubbles: true }))
    }, imported.artifactId)
    await ctx.capture('visual-publication-light')
    await ctx.click('.continuum-visual-publication button[type=submit]')
    await ctx.waitFor(() => document.querySelector('.continuum-visual-preview')?.complete && document.querySelector('.continuum-visual-preview').naturalWidth > 0)
    ctx.check('Publication preserves the active search', await ctx.evaluate(() => document.querySelector('.continuum-header .sb-root input').value === 'Obsidian'))
    await ctx.waitFor(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Exibir na timeline'))
    await ctx.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Exibir na timeline').click())
    await ctx.waitFor(() => document.querySelector('.continuum-thumbnail img')?.naturalWidth > 0)
    ctx.check('Explicit reveal clears hiding search and selects the published Artifact', await ctx.evaluate(() => document.querySelector('.continuum-header .sb-root input').value === '' && !!document.querySelector('.continuum-item.selected .continuum-thumbnail img')))
    const visual = session.getActiveService().list({ kind: 'VISUAL_REFERENCE' }).artifacts[0]
    ctx.check('UI publication persists exact bytes and semantic relation', !!visual && session.getActiveService().getVisual(visual.artifactId).data.equals(canonical) && session.getActiveService().get(visual.artifactId).metadata.relations[0].artifactId === imported.artifactId)
    ctx.check('Timeline IPC remains pixel-free', !(await ctx.evaluate(async () => JSON.stringify(await window.codeAwareness.listContinuumArtifacts({ repositoryId: 'acceptance-A' })))).includes(canonical.toString('base64')))
    await ctx.viewport(1440, 900)
    await ctx.evaluate(() => { document.body.dataset.theme = 'dark' })
    await ctx.overflow()
    await ctx.capture('visual-preview-dark')
    await ctx.evaluate(() => { document.body.dataset.theme = 'light' })
    await ctx.viewport(1000, 760)
    await ctx.overflow()
    await ctx.capture('visual-preview-light-medium')
    await ctx.evaluate(() => {
      document.querySelectorAll('.continuum-item').forEach(item => { if (item.textContent.includes('Publication acceptance')) item.click() })
    })
    await ctx.waitFor(() => !document.querySelector('.continuum-visual-preview'))
    ctx.check('Selecting textual Artifact releases visual preview', await ctx.evaluate(() => !document.querySelector('.continuum-visual-preview')))
    session.activate(otherPath); session.activate(repositoryPath)
    ctx.check('Visual bytes survive repository session restart', session.getActiveService().getVisual(visual.artifactId).data.equals(canonical))
    const canonicalId = 'artifact-651c1160-e149-43c6-ba65-e5f1703c2258'
    const recordPath = path.join(ctx.projectRoot, '.code-awareness/visual-validation/canonical-artifact.json')
    const record = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8').replace(/^\uFEFF/, '')) : {
      artifactId: canonicalId, rawMarkdown: '---\nname: Design System — Channel Runtime V1 — Referência Visual WebP\ndescription: Canonical Channel reference\nkind: VISUAL_REFERENCE\n---\nExplicit curated reference.',
      metadata: { name: 'Design System — Channel Runtime V1 — Referência Visual WebP', description: 'Canonical Channel reference', kind: 'VISUAL_REFERENCE' }
    }
    const metadata = { ...record.metadata }; delete metadata.media
    const fixtureStore = new ArtifactStore(session.getActiveSession().dbPath, 'acceptance-A')
    try {
      for (const relation of metadata.relations || []) fixtureStore.create({ artifactId: relation.artifactId, rawMarkdown: 'Design System fixture target', metadata: { name: 'Design System', description: 'Isolated relationship target', kind: 'DOCUMENT' } })
      fixtureStore.createVisual({ artifactId: canonicalId, rawMarkdown: record.rawMarkdown, metadata }, canonical, session.getActiveService().getVisual(visual.artifactId).media)
    } finally { fixtureStore.close() }
    ctx.check('Isolated canonical reference preserves active Artifact identity and SHA-256', (!record.metadata.media || record.metadata.media.sha256 === session.getActiveService().getVisual(canonicalId).media.sha256) && session.getActiveService().getVisual(canonicalId).data.equals(canonical))
    for (let index = 0; index < 35; index++) session.getActiveService().publish(`---\nname: Timeline document ${index}\ndescription: Textual pagination fixture\nkind: DOCUMENT\n---\nText only.`)
    reads.thumbnail.length = 0; reads.original.length = 0
    await ctx.waitFor(() => document.querySelectorAll('.continuum-item').length === 30)
    ctx.check('Unloaded visual pages and textual rows do not request pixels', reads.thumbnail.length === 0 && reads.original.length === 0)
    await ctx.evaluate(() => { const pane = document.querySelector('.continuum-timeline .continuum-pane-scroll'); pane.scrollTop = pane.scrollHeight })
    await ctx.click('.continuum-load-more')
    await ctx.waitFor(() => !!document.querySelector(`[data-artifact-id="artifact-651c1160-e149-43c6-ba65-e5f1703c2258"]`))
    ctx.check('Loaded but offscreen canonical row has not requested a thumbnail', !reads.thumbnail.includes(canonicalId))
    await ctx.evaluate(id => document.querySelector(`[data-artifact-id="${id}"]`).scrollIntoView({ block: 'center' }), canonicalId)
    await ctx.waitFor(() => document.querySelector('[data-artifact-id="artifact-651c1160-e149-43c6-ba65-e5f1703c2258"] img')?.naturalWidth > 0)
    ctx.check('Scrolling retrieves a real reduced thumbnail without reading the original', reads.thumbnail.includes(canonicalId) && !reads.original.length && reads.peak <= 2)
    await ctx.evaluate(id => document.querySelector(`[data-artifact-id="${id}"]`).focus(), canonicalId)
    await ctx.window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await ctx.window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await ctx.waitFor(() => document.querySelector('.continuum-identity')?.textContent === 'artifact-651c1160-e149-43c6-ba65-e5f1703c2258' && document.querySelector('.continuum-visual-preview')?.naturalWidth === 2048)
    ctx.check('Keyboard selection retrieves the original through the existing Inspector', reads.original.includes(canonicalId))
    await ctx.viewport(1440, 900); await ctx.evaluate(() => { document.body.dataset.theme = 'dark' }); await ctx.capture('canonical-timeline-dark')
    await ctx.viewport(1000, 760); await ctx.evaluate(() => { document.body.dataset.theme = 'light' }); await ctx.capture('canonical-timeline-light')
  } finally {
    if (ctx.window.webContents.debugger.isAttached()) ctx.window.webContents.debugger.detach()
    unsubscribe(); session.dispose()
    ctx.window.webContents.session.setPreloads([])
  }
}
