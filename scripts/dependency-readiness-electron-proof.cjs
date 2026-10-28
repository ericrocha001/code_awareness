if (process.versions.electron && process.type === 'browser' && process.env.CODE_AWARENESS_DEPENDENCY_PROOF) {
  const fs = require('node:fs')
  const path = require('node:path')
  const Module = require('node:module')
  const load = Module._load
  Module._load = function (request, ...args) {
    const value = load.call(this, request, ...args)
    if (request === 'electron' && value?.app) { Module._load = load; isolate(value.app) }
    return value
  }
  function isolate(app) {
    const root = process.env.CODE_AWARENESS_DEPENDENCY_PROOF
    const appData = path.join(root, 'appData')
    const paths = { appData, userData: path.join(appData, 'code-awareness'), sessionData: path.join(root, 'session'), home: path.join(root, 'home'), temp: path.join(root, 'temp'), logs: path.join(root, 'logs'), crashDumps: path.join(root, 'crashes') }
    for (const [name, directory] of Object.entries(paths)) { fs.mkdirSync(directory, { recursive: true }); app.setPath(name, directory) }
    process.env.USERPROFILE = paths.home; process.env.HOME = paths.home
    app.setAsDefaultProtocolClient = () => false
    app.setLoginItemSettings = () => {}
    let finished = false
    const deadline = setTimeout(() => { console.error('DEPENDENCY_PROOF_ELECTRON_TIMEOUT'); app.exit(1) }, 45000)
    app.on('browser-window-created', (_event, window) => {
      window.on('show', () => window.hide())
      window.webContents.once('did-finish-load', () => {
        if (finished) return
        finished = true
        const loaded = Object.keys(require.cache).some(file => file.replace(/\\/g, '/').includes('/archiver/'))
        fs.writeFileSync(path.join(root, 'electron.json'), JSON.stringify({ pid: process.pid, electron: process.versions.electron, archiverLoaded: loaded, userData: app.getPath('userData'), url: window.webContents.getURL() }))
        clearTimeout(deadline)
        setTimeout(() => app.exit(loaded ? 0 : 1), 250)
      })
    })
  }
}
