const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const { desktopUserData, DESKTOP_APP_NAME } = require('../../src/shared/desktop-profile.cjs')

const temporary = fs.mkdtempSync(path.join(tmpdir(), 'cli-electron-profile-'))
const metadata = require('../../package.json')
fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ name: metadata.name, ...(metadata.productName ? { productName: metadata.productName } : {}), main: 'probe.cjs' }))
fs.writeFileSync(path.join(temporary, 'probe.cjs'), `const { app } = require('electron'); process.send({ appName: app.getName(), appData: app.getPath('appData'), userData: app.getPath('userData') }, () => app.exit(0))`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [temporary], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
let result
const timer = setTimeout(() => child.kill(), 20000)
child.on('message', value => { result = value })
child.on('error', () => { process.exitCode = 1 })
child.on('exit', code => {
  clearTimeout(timer)
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const success = code === 0 && result?.appName === DESKTOP_APP_NAME && normalize(result.userData) === normalize(desktopUserData(result.appData))
  console.log(JSON.stringify({ success, runtime: 'Electron Main / application package metadata', appName: result?.appName, profileMatchesDefault: success, appDataMatchesCLI: !!result && !!process.env.APPDATA && normalize(result.appData) === normalize(process.env.APPDATA) }))
  if (!success) process.exitCode = 1
  fs.rmSync(temporary, { recursive: true, force: true })
})
