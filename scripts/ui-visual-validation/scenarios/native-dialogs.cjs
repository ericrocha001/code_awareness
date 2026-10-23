const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { dialog, BrowserWindow } = require('electron')
const { createController, startHelper } = require('../native-dialogs.cjs')

exports.nativeDialogs = { fixtures: [
  { name: 'entrada-ação-漢字.md', type: 'OPEN' },
  { name: 'saída-漢字.md', type: 'SAVE' },
  { name: 'cancelado.md', type: 'SAVE' },
  { name: 'timeout.md', type: 'SAVE' },
  { name: 'abandono.md', type: 'SAVE' }
] }

exports.run = async ctx => {
  const controller = ctx.nativeDialogs
  const bytes = Buffer.from('\uFEFF# Ação 漢字\r\n\r\n```ts\r\nconst ação = "安全"\r\n```\r\n')
  const input = controller.fixture('entrada-ação-漢字.md')
  fs.writeFileSync(input, bytes, { flag: 'wx' })
  await ctx.window.loadURL('data:text/html,<html><body style="background:%2318181b;color:white"><h1>Native Windows dialog acceptance</h1><p id="result">Running isolated fixtures</p></body></html>')
  const opened = await controller.run({ type: 'OPEN', fixture: 'entrada-ação-漢字.md' }, () => dialog.showOpenDialog(ctx.window, { title: 'Abrir — 漢字', properties: ['openFile'] }))
  ctx.check('Native Open returns exact Unicode fixture bytes', fs.readFileSync(opened.filePaths[0]).equals(bytes))
  const saved = await controller.run({ type: 'SAVE', fixture: 'saída-漢字.md' }, () => dialog.showSaveDialog(ctx.window, { title: 'Salvar — ação', filters: [{ name: 'Markdown', extensions: ['md'] }] }))
  fs.writeFileSync(saved.filePath, bytes, { flag: 'wx' })
  ctx.check('Native Save destination writes exact bytes inside sandbox', fs.readFileSync(saved.filePath).equals(bytes))
  const cancelled = await controller.run({ type: 'SAVE', action: 'CANCEL', fixture: 'cancelado.md' }, () => dialog.showSaveDialog(ctx.window, { title: 'Cancel — 安全' }))
  ctx.check('Native cancellation returns canceled and writes nothing', cancelled.canceled && !fs.existsSync(controller.fixture('cancelado.md')))

  const handle = ctx.window.getNativeWindowHandle()
  const owner = (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString()
  let resolved = false
  const pending = dialog.showOpenDialog(ctx.window, { properties: ['openFile'] }).then(result => { resolved = true; return result })
  const wrongOwner = startHelper({ pid: process.pid + 1000000, owner, type: 'OPEN', action: 'CANCEL', root: path.dirname(input), target: input, timeout: 1000 })
  await assert.rejects(wrongOwner.done, { code: 'OWNER_MISMATCH' })
  await wrongOwner.exited
  ctx.check('Mismatched PID is refused without dismissing the real dialog', !resolved && !ctx.window.isEnabled())
  await controller.run({ type: 'OPEN', action: 'CANCEL', fixture: 'entrada-ação-漢字.md' }, () => pending)
  ctx.check('Authorized owner can still cancel the untouched dialog', resolved)

  await assert.rejects(controller.run({ type: 'OPEN', fixture: 'entrada-ação-漢字.md', timeout: 750 }, () => Promise.resolve({ canceled: false, filePaths: [input] })), { code: 'DIALOG_NOT_FOUND' })
  ctx.check('A response without a real dialog cannot pass', true)
  await assert.rejects(controller.run({ type: 'OPEN', fixture: 'entrada-ação-漢字.md', timeout: 750 }, () => new Promise(() => {})), { code: 'DIALOG_NOT_FOUND' })
  ctx.check('Missing dialog and pending trigger terminate with a stable reason', true)
  await assert.rejects(controller.run({ type: 'SAVE', fixture: 'timeout.md', timeout: 3000 }, () => dialog.showSaveDialog(ctx.window).then(() => new Promise(() => {}))), { code: 'DIALOG_TIMEOUT' })
  ctx.check('A closed dialog without an Electron response times out without writing', !fs.existsSync(controller.fixture('timeout.md')))

  const auxiliary = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const controlRecords = []
  const controls = createController({ window: auxiliary, temporary: fs.mkdtempSync(path.join(ctx.temporary, 'controls-')), definitions: [{ name: 'missing.md', type: 'SAVE' }], records: controlRecords })
  try {
    await assert.rejects(controls.run({ type: 'SAVE', fixture: 'missing.md' }, () => dialog.showMessageBox(auxiliary, { message: 'Synthetic missing filename control', buttons: ['OK', 'Cancel'] })), { code: 'CONTROL_UNAVAILABLE' })
    ctx.check('Missing native filename control is classified without clicking', true)
  } finally { await controls.dispose(); auxiliary.destroy(); fs.writeFileSync(path.join(ctx.evidenceDir, 'native-controls.json'), JSON.stringify(controlRecords, null, 2)) }

  await ctx.evaluate(() => { document.querySelector('#result').textContent = 'Open, Save, cancel, Unicode bytes and ownership verified' })
  await ctx.capture('native-dialogs-verified')
  fs.writeFileSync(path.join(ctx.evidenceDir, 'native-files.json'), JSON.stringify({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), openMatches: true, saveMatches: true, cancelCreatedFile: false, negativeOwnership: 'OWNER_MISMATCH', missingControls: 'CONTROL_UNAVAILABLE' }, null, 2))

  const abandoned = controller.run({ type: 'SAVE', fixture: 'abandono.md' }, () => dialog.showSaveDialog(ctx.window)).catch(error => error.code)
  await controller.dispose()
  ctx.window.destroy()
  ctx.check('Abandonment stops the helper and cannot write a file', await abandoned === 'ABANDONED' && !fs.existsSync(controller.fixture('abandono.md')))
}
