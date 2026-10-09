const fs = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')
const { clipboard, ipcMain } = require('electron')
exports.run = async (ctx) => {
  const capture = async (name) => {
    await ctx.evaluate(async () => {
      document.body.getBoundingClientRect()
      await document.fonts.ready
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const image = await ctx.capture(name)
    const pixels = image.toBitmap()
    const colors = new Set()
    for (let i = 0; i < pixels.length && colors.size < 20; i += 4) {
      colors.add(pixels.readUInt32LE(i))
    }
    ctx.check(`${name}: painted content`, colors.size >= 20)
    return image
  }
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
    await ctx.window.loadFile(page, { query: { repo: ctx.projectRoot, empty: '1' } })
    ctx.window.showInactive()
    await ctx.waitFor(() => !!document.querySelector('.dash-no-project'))
    ctx.check(
      'No project exposes no execution controls',
      await ctx.evaluate(() => !document.querySelector('.dash-textarea,.dash-actions-bar button'))
    )
    await capture('wide-dark-no-project')
    await ctx.window.loadFile(page, { query: { repo: ctx.projectRoot } })
    await ctx.waitFor(() => !!document.querySelector('.dash-textarea'))
    await ctx.viewport(1440, 900)
    await capture('wide-dark-idle')
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
    await ctx.evaluate(() => {
      const input = document.querySelector('.dash-textarea')
      input.scrollTop = 0
      input.scrollLeft = 0
      input.dispatchEvent(new Event('scroll'))
    })
    await ctx.click('.dash-request-pane .primary')
    await ctx.waitFor(
      () =>
        !!document.querySelector('.dash-context-preview') &&
        !!document.querySelector('.dash-report-success')
    )
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
    ctx.check(
      'Wide constrained viewport and independent code scrolling',
      await ctx.evaluate(
        () =>
          document.documentElement.scrollHeight <= innerHeight &&
          getComputedStyle(document.querySelector('.dash-context-preview')).overflowY === 'auto'
      )
    )
    const packet = JSON.parse(context)
    ctx.check(
      'One target and exactly three requested fields',
      packet.length === 1 && Object.keys(packet[0]).length === 3
    )
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
      await capture('clipboard-attempt')
      await ctx.waitFor(() => !!document.querySelector('.dash-copy-success'))
      ctx.check('Native clipboard equals Context Packet', clipboard.readText() === context)
    } finally {
      clipboard.writeText(previous)
    }
    await ctx.overflow()
    await capture('wide-dark-success')
    await ctx.evaluate(() => {
      document.body.dataset.theme = 'light'
    })
    await capture('wide-light-success')
    ctx.window.webContents.focus()
    await ctx.evaluate(() => {
      document.querySelector('.dash-context-preview').focus()
    })
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await ctx.waitFor(() => document.activeElement.matches('.dash-context-pane button'))
    ctx.check(
      'Keyboard focus is visible',
      await ctx.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none')
    )
    await capture('wide-light-focus')
    ctx.window.webContents.session.setPermissionCheckHandler(() => false)
    ctx.window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false)
    )
    await ctx.click('.dash-context-pane .primary')
    await ctx.waitFor(() => !!document.querySelector('.dash-copy-error'))
    ctx.check(
      'Clipboard failure never claims success',
      await ctx.evaluate(() => !document.querySelector('.dash-copy-success'))
    )
    await capture('wide-light-copy-error')
    await ctx.viewport(1000, 800)
    await ctx.overflow()
    await capture('medium-light-success')
    await ctx.viewport(780, 760)
    ctx.check(
      'Narrow workspace scrolls without competing global vertical overflow',
      await ctx.evaluate(() => document.documentElement.scrollHeight <= innerHeight)
    )
    await ctx.overflow()
    await capture('narrow-light-success')
    await ctx.evaluate(() => {
      document.querySelector('.dash-workspace').scrollTop =
        document.querySelector('.dash-workspace').scrollHeight
    })
    await capture('narrow-light-context')
    await ctx.evaluate(() => {
      document.body.dataset.theme = 'dark'
    })
    await capture('narrow-dark-context')
    await ctx.evaluate(() => {
      document.body.dataset.theme = 'light'
      document.querySelector('.dash-workspace').scrollTop = 0
    })
    await ctx.click('.dash-request-pane .app-ghost-btn')
    await ctx.input('.dash-textarea', JSON.stringify({ ...request, limits: { maxTokens: 1 } }))
    await ctx.click('.dash-request-pane .primary')
    await ctx.waitFor(
      () =>
        !!document.querySelector('.dash-report-error') &&
        document.querySelector('.dash-report-error').textContent.includes('BUDGET_EXCEEDED')
    )
    ctx.check(
      'Failure has no copyable packet',
      await ctx.evaluate(
        () =>
          !document.querySelector('.dash-context-preview') &&
          !document.querySelector('.dash-context-pane button')
      )
    )
    await capture('narrow-light-error')
    await ctx.viewport(1440, 900)
    await ctx.click('.dash-request-pane .app-ghost-btn')
    const largeRequest = JSON.stringify({
      ...request,
      intent: 'Long Unicode literal <> 🚀 '.repeat(6000)
    })
    const start = Date.now()
    await ctx.input('.dash-textarea', largeRequest)
    await ctx.waitFor(() => !!document.querySelector('.dash-code-editor.dash-code-plain'))
    ctx.check(
      'Large editable input uses bounded highlight fallback',
      await ctx.evaluate(
        (size) =>
          document.querySelector('.dash-textarea').value.length === size &&
          !document.querySelector('.dash-code-overlay'),
        largeRequest.length
      )
    )
    await ctx.click('.dash-request-pane .primary')
    await ctx.waitFor(() => !!document.querySelector('.dash-report-success'))
    ctx.check(
      'Presentation preserves Pure Signal for a large request',
      await ctx.evaluate(
        (expected) => document.querySelector('.dash-context-preview').textContent === expected,
        context
      )
    )
    ctx.check('Large input remains responsive within five seconds', Date.now() - start < 5000)
    await ctx.overflow()
    await capture('wide-light-large-input')
    await ctx.evaluate(() => {
      document.body.dataset.theme = 'system'
    })
    await capture('wide-system-success')
    const largeContext = JSON.stringify([{ source: 'Literal <> 🚀\r\n'.repeat(12_000) }])
    const largeStart = Date.now()
    ctx.window.showInactive()
    await ctx.window.loadFile(page, { query: { largeOutput: '1' } })
    await ctx.waitFor(() => !!document.querySelector('.dash-code-output.dash-code-plain'))
    ctx.check(
      'Large output presentation is literal and uses plain fallback',
      await ctx.evaluate(
        (expected) =>
          document.querySelector('.dash-context-preview').textContent === expected &&
          !document.querySelector('.dash-token-string'),
        largeContext
      )
    )
    ctx.check(
      'Large output presentation remains responsive within five seconds',
      Date.now() - largeStart < 5000
    )
    await ctx.overflow()
    await capture('wide-dark-large-output')
    await ctx.evaluate(() => {
      document.body.dataset.theme = 'light'
    })
    await capture('wide-light-large-output')
  } finally {
    ctx.window.hide()
    ipcMain.removeHandler('dash:execute')
    close()
  }
}
