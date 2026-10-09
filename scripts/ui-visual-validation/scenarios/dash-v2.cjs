const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')
const { clipboard, ipcMain } = require('electron')
exports.run = async (ctx) => {
  const backendFile = path.join(ctx.evidenceDir, 'backend.cjs')
  buildSync({
    entryPoints: [path.join(__dirname, 'dash-v2-backend.ts')],
    bundle: true,
    outfile: backendFile,
    platform: 'node',
    packages: 'external',
    external: ['electron']
  })
  const close = await require(backendFile).start(ctx.projectRoot)
  try {
    const preload = path.join(ctx.temporary, 'preload.cjs')
    fs.writeFileSync(
      preload,
      "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('codeAwareness',{dashExecute:(input,repo)=>ipcRenderer.invoke('dash:execute',input,repo)});"
    )
    ctx.window.webContents.session.setPreloads([preload])
    ctx.window.webContents.session.setPermissionCheckHandler(
      (_contents, permission) => permission === 'clipboard-sanitized-write'
    )
    ctx.window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission === 'clipboard-sanitized-write')
    )
    buildSync({
      entryPoints: [path.join(__dirname, 'dash-v2-fixture.tsx')],
      bundle: true,
      outfile: path.join(ctx.temporary, 'fixture.js'),
      platform: 'browser',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }
    })
    const page = path.join(ctx.temporary, 'index.html')
    fs.writeFileSync(
      page,
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}body{background:var(--bg-primary);color:var(--text-primary)}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>'
    )
    await ctx.window.loadFile(page, { query: { repo: ctx.projectRoot } })
    await ctx.waitFor(() => !!document.querySelector('.dash-textarea'))
    await ctx.viewport(1440, 900)
    await ctx.capture('wide-dark-idle')
    const request = {
      protocol: 'code-dash/v2',
      steps: [
        {
          id: 'target',
          find: 'element',
          where: {
            name: { exact: 'readCode' },
            kind: { exact: 'method' },
            path: { exact: 'src/main/core/context/context-engine.ts' }
          },
          expect: { min: 1, max: 1 }
        }
      ],
      emit: [{ from: 'target', include: ['path', 'signature', 'source'] }]
    }
    await ctx.input('.dash-textarea', JSON.stringify(request, null, 2))
    await ctx.click('.dash-request-pane .primary')
    await ctx.waitFor(() => !!document.querySelector('.dash-context-preview'))
    ctx.check(
      'Legacy controls absent',
      await ctx.evaluate(
        () =>
          !document.querySelector('.repo-discovery,.dash-optimization-bar,.dash-mode-switcher') &&
          !document.body.innerText.includes('XML')
      )
    )
    const context = await ctx.evaluate(
      () => document.querySelector('.dash-context-preview').textContent
    )
    const packet = JSON.parse(context)
    ctx.check(
      'Real map projection',
      packet.length === 1 &&
        packet[0].path === 'src/main/core/context/context-engine.ts' &&
        Object.keys(packet[0]).sort().join(',') === 'path,signature,source'
    )
    const previous = clipboard.readText()
    try {
      ctx.window.webContents.focus()
      await ctx.click('.dash-context-pane .primary')
      await ctx.capture('clipboard-attempt')
      await ctx.waitFor(() => document.body.innerText.includes('Contexto copiado'))
      ctx.check('Native clipboard equals Context Packet', clipboard.readText() === context)
    } finally {
      clipboard.writeText(previous)
    }
    await ctx.overflow()
    await ctx.capture('wide-dark-success')
    await ctx.evaluate(() => {
      document.body.dataset.theme = 'light'
    })
    await ctx.capture('wide-light-success')
    await ctx.viewport(780, 760)
    await ctx.overflow()
    await ctx.capture('narrow-light-success')
    await ctx.click('.dash-request-pane .app-ghost-btn')
    await ctx.input('.dash-textarea', JSON.stringify({ ...request, limits: { maxTokens: 1 } }))
    await ctx.click('.dash-request-pane .primary')
    await ctx.waitFor(() => document.body.innerText.includes('BUDGET_EXCEEDED'))
    ctx.check(
      'Failure has no copyable packet',
      await ctx.evaluate(
        () =>
          !document.querySelector('.dash-context-preview') &&
          !document.querySelector('.dash-context-pane button')
      )
    )
    await ctx.capture('narrow-light-error')
  } finally {
    ipcMain.removeHandler('dash:execute')
    close()
  }
}
