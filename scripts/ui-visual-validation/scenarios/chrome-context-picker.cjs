const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

const fixture = {
  scope: { repositoryId: 'demo', binding: 'fixture' },
  projectName: 'Engineering Demo',
  tags: [{ slug: 'architecture', name: 'Architecture' }],
  facets: [
    { key: 'kind', values: [{ value: 'DOCUMENT', count: 1 }, { value: 'VISUAL_REFERENCE', count: 1 }] }
  ],
  artifacts: [
    { artifactId: 'a', revision: 1, name: 'Service boundaries', kind: 'DOCUMENT' },
    { artifactId: 'b', revision: 2, name: 'Navigation overview', kind: 'VISUAL_REFERENCE' }
  ]
}

exports.run = async ctx => {
  const extension = join(ctx.projectRoot, 'dist', 'web-extension')
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
    globalThis.chrome = {
      runtime: {
        id: 'fixture',
        getURL: path => '${pickerOrigin}/' + path,
        sendMessage: (message, reply) => {
          if (message.type === 'PICKER_BIND') reply?.({ok:true});
          if (message.type === 'PICKER_REQUEST') {
            const result = message.request.action === 'catalog' ? ${JSON.stringify(fixture)}
              : {tokenCount: 412, markdownBytes: 1320, hasVisuals: true, members: []};
            reply?.({ ok: true, result });
          }
        }
      }
    };
  `
  await protocol.handle('https', request => {
    const { origin, pathname } = new URL(request.url)
    if (origin === 'https://chatgpt.com' && pathname === '/') return new Response(
      '<!doctype html><html lang="en"><title>Chat draft fixture</title>' +
      '<body style="margin:0;padding:24px;background:#202123;color:#f1f5f9;font:15px system-ui" data-theme="dark">' +
      '<h1 style="font-size:20px">Chat draft fixture</h1><p>Synthetic conversation</p>' +
      '<div id="prompt-textarea" contenteditable="true" style="margin-top:48px;padding:14px;border:1px solid #63666a;border-radius:10px">Existing draft</div>' +
      `<script>${runtime}</script><script src="/content-script.js"></script></body></html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    )
    if (origin === 'https://chatgpt.com' && pathname === '/content-script.js') return new Response(read('content-script.js'), { headers: { 'Content-Type': 'text/javascript' } })
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
    await until("document.querySelectorAll('#results input').length === 2")
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
    await until("document.querySelector('#count').textContent === '1 selected'")
    await activatePanelControl('#results input[value="b"]')
    await until("document.querySelector('#count').textContent === '2 selected'")
    await activatePanelControl('#preview-button')
    await until("document.querySelector('#preview').textContent.includes('412 tokens')")
    ctx.check('Picker preview and text action rendered', await evaluation("!document.querySelector('#insert').disabled && document.querySelector('#preview').textContent.includes('WebP')"))
    await ctx.capture('context-picker-wide')

    await ctx.viewport(390, 640)
    ctx.check('Picker stays inside narrow viewport', await ctx.evaluate(() => {
      const { left, right, top, bottom } = document.querySelector('#code-awareness-activation-pill').shadowRoot.querySelector('iframe').getBoundingClientRect()
      return left >= 0 && top >= 0 && right <= innerWidth && bottom <= innerHeight
    }))
    await ctx.capture('context-picker-split')
    await evaluation("document.querySelector('#copy').focus()")
    ctx.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    ctx.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await ctx.waitFor(() => {
      const host = document.querySelector('#code-awareness-activation-pill')
      return !host.shadowRoot.querySelector('iframe') && host.shadowRoot.activeElement === host.shadowRoot.querySelector('button')
    })
    ctx.check('Escape closes picker and restores trigger focus', true)
    ctx.check('Source unchanged during capture', runGit('rev-parse', 'HEAD') === head &&
      runGit('status', '--porcelain') === dirty && fingerprint() === metadata.inputsFingerprint)
    require('node:fs').writeFileSync(join(ctx.evidenceDir, 'source.json'), JSON.stringify({
      head, branch, dirty, worktree: ctx.projectRoot, build: metadata.buildId, fingerprint: metadata.inputsFingerprint
    }, null, 2))
  } finally {
    await protocol.unhandle('https')
  }
}
