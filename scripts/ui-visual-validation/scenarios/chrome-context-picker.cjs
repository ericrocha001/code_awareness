const { mkdirSync, readFileSync } = require('node:fs')
const { app } = require('electron')
const esbuild = require('esbuild')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

const fixture = {
  scope: { repositoryId: 'demo', binding: 'fixture' },
  projectName: 'Engineering Demo',
  tags: [{ slug: 'architecture', name: 'Architecture' }],
  facets: [
    { key: 'kind', values: [{ value: 'DOCUMENT', count: 19 }, { value: 'VISUAL_REFERENCE', count: 1 }] },
    { key: 'status', values: [{ value: 'PENDING', count: 8 }, { value: 'VALIDATED', count: 12 }] }
  ],
  artifacts: [
    { artifactId: 'a', revision: 1, name: 'Service boundaries', kind: 'DOCUMENT' },
    { artifactId: 'b', revision: 2, name: 'Navigation overview', kind: 'VISUAL_REFERENCE' },
    ...Array.from({ length: 18 }, (_, i) => ({
      artifactId: 'doc-' + i, revision: 1, kind: 'DOCUMENT',
      name: i === 1 ? 'Orientações para integrações entre serviços e recuperação após falhas de rede' : 'Documento de referência ' + (i + 1)
    }))
  ]
}

exports.run = async ctx => {
  const extension = join(ctx.projectRoot, 'dist', 'web-extension')
  const modulePath = join(ctx.temporary, 'picker-downloader.cjs')
  await esbuild.build({
    entryPoints: [join(ctx.projectRoot, 'src/main/web-activation/context-picker-files.ts')],
    outfile: modulePath, bundle: true, platform: 'node',
    nodePaths: [join(ctx.projectRoot, 'node_modules')],
    external: ['electron']
  })
  const { downloadPickerFiles } = require(modulePath)
  const downloads = join(ctx.temporary, 'downloads')
  mkdirSync(downloads)
  app.setPath('downloads', downloads)
  const originals = [
    { name: 'Service boundaries.md', type: 'text/markdown', bytes: Buffer.from('# Service boundaries\r\n') },
    { name: 'Navigation overview.md', type: 'text/markdown', bytes: Buffer.from('# Navigation overview\n') },
    { name: 'Navigation overview.webp', type: 'image/webp', bytes: Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQ/Y/+ByKi/wEA', 'base64') }
  ]
  let downloadReceipt

  const read = name => readFileSync(join(extension, name), 'utf8')
  const runGit = (...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: ctx.projectRoot, encoding: 'utf8' }).trim()
  const head = runGit('rev-parse', 'HEAD')
  const branch = runGit('rev-parse', '--abbrev-ref', 'HEAD')
  const dirty = runGit('status', '--porcelain')
  const metadata = JSON.parse(readFileSync(join(ctx.projectRoot, 'dist', 'web-activation', 'build-metadata.json'), 'utf8'))
  const { computeWebActivationInputsFingerprint } = require('../../web-activation/build.cjs')
  const fingerprint = () => computeWebActivationInputsFingerprint(ctx.projectRoot)
  ctx.check('Candidate build matches source fingerprint', metadata.inputsFingerprint === fingerprint())
  const protocol = ctx.window.webContents.session.protocol
  const pickerOrigin = 'https://chatgpt.com'
  const runtime = `
    let storageListener;
    globalThis.setPickerPosition = position => {
      globalThis.pickerPosition = position;
      storageListener?.({ floatingBarPosition: { newValue: position } }, 'local');
    };
    globalThis.setPickerBarVisible = visible => {
      globalThis.pickerBarVisible = visible;
      storageListener?.({ floatingBarVisible: { newValue: visible } }, 'local');
    };
    globalThis.chrome = {
      storage: {
        local: { get: (_keys, reply) => reply({ floatingBarPosition: globalThis.pickerPosition, floatingBarVisible: globalThis.pickerBarVisible }) },
        onChanged: { addListener: listener => { storageListener = listener }, removeListener() {} }
      },
      runtime: {
        id: 'fixture',
        getURL: path => '${pickerOrigin}/' + path,
        sendMessage: (message, reply) => {
          if (message.type === 'PICKER_CLOSE') globalThis.closedPicker = true;
          if (message.type === 'PICKER_BIND') reply?.({ok:true});
          if (message.type === 'PICKER_REQUEST') {
            if (message.request.action === 'download') {
              fetch('/fixture-download', { method: 'POST' }).then(response => response.json()).then(reply);
              return;
            }

            const result = message.request.action === 'catalog' ? ${JSON.stringify(fixture)}
              : {tokenCount: 412, markdownBytes: 1320, hasVisuals: true, artifactTokens: message.request.selected.map(item => ({artifactId:item.artifactId,rawMarkdownTokenCount:32})), members: []};
            reply?.({ ok: true, result });
          }
        }
      }
    };
  `
  await protocol.handle('https', request => {
    const { origin, pathname } = new URL(request.url)
    if (origin === pickerOrigin && pathname === '/fixture-download' && request.method === 'POST') {
      downloadReceipt = downloadPickerFiles(originals, () => {})
      return Response.json({ ok: true, result: downloadReceipt })
    }
    if (origin === 'https://chat.deepseek.com' && pathname === '/') return new Response(
      '<!doctype html><body data-theme="light" style="margin:0;background:#f5f7fc;color:#273149;font:15px system-ui">' +
      '<textarea aria-label="Rascunho sintético" style="position:fixed;bottom:12px;right:12px;width:calc(100% - 24px);max-width:550px;height:90px;border:1px solid #bac4d5;border-radius:12px;padding:8px;box-sizing:border-box">Rascunho sintético</textarea>' +
      `<script>${runtime}</script><script src="/content-script.js"></script>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    )
    if (origin === 'https://chatgpt.com' && pathname === '/') return new Response(
      '<!doctype html><html lang="en"><title>Chat draft fixture</title>' +
      '<body style="margin:0;padding:24px;background:#202123;color:#f1f5f9;font:15px system-ui" data-theme="dark">' +
      '<h1 style="font-size:20px">Chat draft fixture</h1><p>Synthetic conversation</p>' +
      '<div id="prompt-textarea" contenteditable="true" style="margin-top:48px;padding:14px;border:1px solid #63666a;border-radius:10px">Existing draft</div>' +
      `<script>${runtime}</script><script src="/content-script.js"></script></body></html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    )
    if ((origin === pickerOrigin || origin === 'https://chat.deepseek.com') && pathname === '/content-script.js') return new Response(read('content-script.js'), { headers: { 'Content-Type': 'text/javascript' } })
    if (origin === pickerOrigin && pathname === '/context-picker.html') return new Response(
      read('context-picker.html').replace('<script src="context-picker.js">', `<script>${runtime}</script><script src="context-picker.js">`),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    )
    if (origin === pickerOrigin && pathname === '/context-picker.js') return new Response(read('context-picker.js'), { headers: { 'Content-Type': 'text/javascript' } })
    return new Response('', { status: 404 })
  })

  try {
    await ctx.window.loadURL('https://chatgpt.com/')
    await ctx.waitFor(() => document.querySelector('#code-awareness-activation-pill')?.shadowRoot.querySelector('button'))
    const click = ({ x, y, width, height }) => {
      const point = { x: Math.round(x + width / 2), y: Math.round(y + height / 2) }
      ctx.window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      ctx.window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    }
    const trigger = await ctx.evaluate(() => document.querySelector('#code-awareness-activation-pill').shadowRoot
      .querySelector('button').getBoundingClientRect().toJSON())
    click(trigger)
    await ctx.waitFor(() => Boolean(document.querySelector('#code-awareness-activation-pill').shadowRoot.querySelector('iframe')))
    const evaluation = async expression => {
      const frame = ctx.window.webContents.mainFrame.frames.find(frame => frame.url === pickerOrigin + '/context-picker.html')
      return frame ? frame.executeJavaScript(expression) : undefined
    }
    async function until(expression) {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        if (await evaluation(expression)) return
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error('Picker condition timed out')
    }
    await until("document.querySelectorAll('#results input').length === 20")
    const activatePanelControl = async selector => {
      const frame = await ctx.evaluate(() => {
        const iframe = document.querySelector('#code-awareness-activation-pill').shadowRoot.querySelector('iframe')
        const rect = iframe.getBoundingClientRect()
        return { x: rect.x + iframe.clientLeft, y: rect.y + iframe.clientTop }
      })
      const control = await evaluation(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`)
      click({ ...control, x: control.x + frame.x, y: control.y + frame.y })
    }
    await activatePanelControl('#results input[value="a"]')
    await until("document.querySelector('#count').textContent === '1 selecionado'")
    await activatePanelControl('#results input[value="b"]')
    for (let i = 0; i < 6; i++) await activatePanelControl(`#results input[value="doc-${i}"]`)
    await until("document.querySelector('#count').textContent === '8 selecionados'")
    ctx.check('Selecting leaves the selection panel collapsed', await evaluation("document.querySelector('#selected').hidden"))
    await until("document.querySelector('#preview').textContent.includes('412 tokens')")
    ctx.check('Picker preview and text action rendered', await evaluation("!document.querySelector('#insert').disabled && document.querySelector('#preview').textContent.includes('WebP')"))
    await ctx.capture('context-picker-wide')
    await activatePanelControl('#selection-toggle')
    ctx.check('Expanded catalog and selection each scroll independently', await evaluation(
      "['#catalog','#selected'].every(s => { const el=document.querySelector(s); return el.clientHeight >= 65 && el.scrollHeight > el.clientHeight })"
    ))
    await ctx.capture('context-picker-wide-expanded')

    await ctx.viewport(390, 640)
    ctx.check('Picker stays inside narrow viewport', await ctx.evaluate(() => {
      const { left, right, top, bottom } = document.querySelector('#code-awareness-activation-pill').shadowRoot.querySelector('iframe').getBoundingClientRect()
      return left >= 0 && top >= 0 && right <= innerWidth && bottom <= innerHeight
    }))
    ctx.check('Split viewport leaves both lists usable and keeps actions visible', await evaluation(
      "['#catalog','#selected'].every(s => document.querySelector(s).clientHeight >= 66) && document.querySelector('#attach').getBoundingClientRect().bottom <= innerHeight"
    ))
    await ctx.capture('context-picker-split-expanded')
    await evaluation("document.querySelector('#selection-toggle').focus()")
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await until("document.querySelector('#selected').hidden")
    ctx.check('Keyboard collapses the list and keeps selection, total, and action', await evaluation(
      "document.activeElement.id === 'selection-toggle' && document.querySelector('#selected').children.length === 8 && document.querySelector('#preview').textContent.includes('412 tokens') && !document.querySelector('#copy').disabled"
    ))
    await ctx.capture('context-picker-split')
    for (const position of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      await ctx.evaluate(position => window.setPickerPosition(position), position)
      ctx.check(`Picker fits the ${position} corner`, await ctx.evaluate(position => {
        const host = document.querySelector('#code-awareness-activation-pill')
        const bar = host.getBoundingClientRect()
        const rect = host.shadowRoot.querySelector('iframe').getBoundingClientRect()
        const close = (actual, expected) => Math.abs(actual - expected) < 2
        const vertical = position.startsWith('top')
          ? close(rect.top, bar.bottom + 8) && close(rect.bottom, innerHeight - 16)
          : close(rect.bottom, bar.top - 8) && close(rect.top, 16)
        const horizontal = position.endsWith('left') ? close(rect.left, 16) : close(rect.right, innerWidth - 16)
        return vertical && horizontal
      }, position))
    }
    await evaluation("document.querySelector('#attach').scrollIntoView({ block: 'nearest' })")
    await activatePanelControl('#attach')
    await until("document.querySelector('#action-status').textContent.includes('Arquivos salvos em')")
    ctx.check('Download saves individual Markdown and WebP and reports the result in the picker',
      downloadReceipt?.names.length === originals.length && originals.every(file =>
        readFileSync(join(downloadReceipt.directory, file.name)).equals(file.bytes)
      )
    )

    await evaluation("document.querySelector('#copy').focus()")
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await ctx.waitFor(() => {
      const host = document.querySelector('#code-awareness-activation-pill')
      return !host.shadowRoot.querySelector('iframe') && host.shadowRoot.activeElement === host.shadowRoot.querySelector('button')
    })
    ctx.check('Escape closes picker and restores trigger focus', true)
    await ctx.window.loadURL('https://chat.deepseek.com/')
    await ctx.waitFor(() => document.querySelector('#code-awareness-activation-pill')?.shadowRoot.querySelectorAll('button').length === 2)
    ctx.check('Floating bar fits split viewport with both actions', await ctx.evaluate(() => {
      const bar = document.querySelector('#code-awareness-activation-pill')
      const bounds = bar.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= innerWidth
    }))
    await ctx.capture('floating-bar-split')
    const contextButton = await ctx.evaluate(() => document.querySelector('#code-awareness-activation-pill').shadowRoot
      .querySelector('.context-trigger').getBoundingClientRect().toJSON())
    click(contextButton)
    await until("document.querySelectorAll('#results input').length === 20")
    await ctx.evaluate(() => window.setPickerBarVisible(false))
    await ctx.waitFor(() => {
      const bar = document.querySelector('#code-awareness-activation-pill')
      return window.closedPicker && bar.hidden && !bar.shadowRoot.querySelector('iframe') && bar.dataset.caState === 'INACTIVE'
    })
    await ctx.evaluate(() => window.setPickerBarVisible(true))
    ctx.check('Visibility preference closes the binding without changing activation state', await ctx.evaluate(() => {
      const bar = document.querySelector('#code-awareness-activation-pill')
      return !bar.hidden && bar.dataset.caState === 'INACTIVE' && bar.shadowRoot.querySelectorAll('.context-trigger').length === 1 &&
        document.querySelector('textarea').value === 'Rascunho sintético'
    }))

    const loaded = await ctx.window.webContents.session.extensions.loadExtension(extension)
    try {
      await ctx.viewport(360, 560)
      await ctx.window.loadURL(`chrome-extension://${loaded.id}/popup.html`)
      await ctx.waitFor(() => document.querySelector('#open-picker')?.textContent.includes('Continuum'))
      await ctx.evaluate((catalog) => {
        chrome.runtime.sendMessage = (message, reply) => {
          const result = message.request?.action === 'preview'
            ? { tokenCount: 412, hasVisuals: true, artifactTokens: message.request.selected.map(item => ({ artifactId: item.artifactId, rawMarkdownTokenCount: 32 })) }
            : catalog
          reply({ ok: true, result })
        }
      }, fixture)
      await ctx.capture('context-picker-popup-settings')
      await ctx.click('#open-picker')
      await ctx.waitFor(() => document.querySelector('iframe')?.contentDocument?.querySelectorAll('#results input').length === 20)
      await ctx.evaluate(() => {
        const view = document.querySelector('iframe').contentDocument
        for (const checkbox of [...view.querySelectorAll('#results input')].slice(0, 8)) checkbox.click()
        view.querySelector('#selection-toggle').click()
      })
      await ctx.waitFor(() => document.querySelector('iframe')?.contentDocument?.querySelector('#preview')?.textContent.includes('412'))
      ctx.check('Shared picker has manual actions in the popup', await ctx.evaluate(() => {
        const view = document.querySelector('iframe').contentDocument
        return view.querySelector('#destination').textContent === 'Uso manual' &&
          view.querySelector('#insert').hidden && !view.querySelector('#attach').disabled &&
          view.querySelector('#attach').textContent.includes('Baixar arquivos')
      }))
      await ctx.capture('context-picker-popup')
      await ctx.click('#back-to-settings')
      ctx.check('Back discards popup selection instance', await ctx.evaluate(() =>
        !document.querySelector('#picker-view iframe') && !document.querySelector('#settings-view').hidden
      ))
    } finally {
      ctx.window.webContents.session.extensions.removeExtension(loaded.id)
    }

    ctx.check('Source unchanged during capture', runGit('rev-parse', 'HEAD') === head &&
      runGit('status', '--porcelain') === dirty && fingerprint() === metadata.inputsFingerprint)
    require('node:fs').writeFileSync(join(ctx.evidenceDir, 'source.json'), JSON.stringify({
      head, branch, dirty, worktree: ctx.projectRoot, build: metadata.buildId, fingerprint: metadata.inputsFingerprint
    }, null, 2))
  } finally {
    await protocol.unhandle('https')
  }
}
