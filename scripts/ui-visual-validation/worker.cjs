const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
app.setPath('appData', config.temporary)
app.setPath('userData', path.join(config.temporary, 'profile'))
app.setPath('sessionData', path.join(config.temporary, 'session'))
app.setPath('logs', path.join(config.temporary, 'logs'))
app.setPath('crashDumps', path.join(config.temporary, 'crashes'))
app.disableHardwareAcceleration()
const receipt = { status: 'PASS', runtime: { electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform }, checks: [], captures: [] }
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true)
  const check = (name, passed) => { receipt.checks.push({ name, passed: !!passed }); if (!passed) throw Object.assign(new Error(name), { code: 'CHECK_FAILED' }) }
  check('Profile and session isolated', ['userData', 'sessionData', 'logs', 'crashDumps'].every(key => app.getPath(key).startsWith(config.temporary + path.sep)))
  const waitFor = async (fn, ...args) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) { if (await evaluate(fn, ...args)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
    throw Object.assign(new Error('Renderer condition timed out'), { code: 'WAIT_TIMEOUT' })
  }
  const context = {
    ...config, window, evaluate, waitFor, check,
    load: file => window.loadFile(file),
    viewport: async (width, height) => { window.setContentSize(width, height); await waitFor((w, h) => innerWidth === w && innerHeight === h, width, height) },
    click: async selector => {
      await waitFor(s => !!document.querySelector(s), selector)
      const point = await evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }, selector)
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    },
    input: async (selector, text) => { await context.click(selector); window.webContents.insertText(text) },
    overflow: async () => check('No global horizontal overflow', await evaluate(() => document.documentElement.scrollWidth <= innerWidth)),
    capture: async name => {
      if (!/^[a-z0-9-]+$/i.test(name)) throw new Error('Invalid capture name')
      window.webContents.invalidate()
      await evaluate(async () => {
        await document.fonts.ready
        await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      await new Promise(resolve => setTimeout(resolve, 150))
      const image = await window.webContents.capturePage()
      check(`${name}: usable capture`, !image.isEmpty() && image.getSize().width > 0)
      const target = path.join(config.evidenceDir, `${name}.png`)
      fs.writeFileSync(target, image.toPNG())
      receipt.captures.push({ name, path: target, viewport: await evaluate(() => ({ width: innerWidth, height: innerHeight })), dimensions: image.getSize() })
      return image
    }
  }
  try { await require(config.scenario).run(context) }
  catch (error) { receipt.status = 'FAIL'; receipt.reason = error.code || 'SCENARIO_FAILED'; receipt.message = error.stack }
  finally { window.destroy(); if (process.send) process.send(receipt, () => app.quit()); else app.quit() }
}).catch(error => { if (process.send) process.send({ status: 'FAIL', reason: 'WINDOW_START_FAILED', message: error.message }, () => app.quit()); else app.quit() })
