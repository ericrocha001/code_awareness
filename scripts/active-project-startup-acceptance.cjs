const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const normalize = value => path.resolve(value).toLowerCase()

async function application() {
  const { app } = require('electron')
  const config = JSON.parse(fs.readFileSync(process.env.CA_STARTUP_ACCEPTANCE_CONFIG, 'utf8'))
  app.setName('code-awareness')
  for (const [name, folder] of Object.entries({ appData: config.appData, userData: config.profile, sessionData: path.join(config.temporary, 'chromium'), logs: path.join(config.temporary, 'logs') })) {
    fs.mkdirSync(folder, { recursive: true }); app.setPath(name, folder)
  }
  let protocolCalls = 0
  // The startup contract is real; Windows protocol registration is outside this isolated proof.
  app.setAsDefaultProtocolClient = () => { protocolCalls++; return false }
  const fail = error => {
    fs.writeFileSync(config.result, JSON.stringify({ status: 'FAIL', reason: String(error.stack) }))
    app.exit(1)
  }
  const deadline = setTimeout(() => fail(Error('STARTUP_ACCEPTANCE_TIMEOUT')), 90000)
  app.once('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', async () => {
      try {
        assert.ok(process.env.ELECTRON_RENDERER_URL, 'actual electron-vite Dev runtime required')
        const evaluate = code => window.webContents.executeJavaScript(code, true)
        const repositories = await evaluate('window.codeAwareness.listRepositories()')
        const ids = Object.fromEntries(Object.entries(config.repositories).map(([name, folder]) => {
          const record = repositories.find(r => r.localCheckout && normalize(r.localCheckout.path) === normalize(folder))
          assert.ok(record, name + ' must resolve through the real Catalog'); return [name, record.id]
        }))
        const initial = await evaluate('window.codeAwareness.getActiveProject()')
        assert.equal(initial.context.mode, 'HOST')
        assert.equal(initial.project?.id ?? null, config.expected ? ids[config.expected] : null)
        if (config.expected) assert.equal(initial.context.identity, 'IDENTITY_BOUND')
        let selected = initial
        if (config.select) {
          const response = await evaluate(`window.codeAwareness.activateRepository(${JSON.stringify(ids[config.select])})`)
          assert.equal(response.success, true); selected = response.data
          assert.equal(selected.project.id, ids[config.select])
        }
        const settings = JSON.parse(fs.readFileSync(path.join(config.profile, 'settings.json'), 'utf8'))
        assert.equal(settings.lastActiveRepositoryId, ids[config.select ?? config.expected])
        assert.equal(normalize(app.getPath('userData')), normalize(config.profile)); assert.ok(protocolCalls > 0)
        fs.writeFileSync(config.result, JSON.stringify({ status: 'PASS', stage: config.stage, mode: 'HOST', dev: true,
          pid: process.pid, electron: process.versions.electron, sourceRoot: root, userData: app.getPath('userData'),
          ids, initial, selected, persistedRepositoryId: settings.lastActiveRepositoryId, windowsProtocolRegistration: 'BLOCKED_BY_TEST_BOUNDARY' }, null, 2))
        clearTimeout(deadline); app.quit()
      } catch (error) { fail(error) }
    })
  })
  await import(require('node:url').pathToFileURL(path.join(root, 'out/main/main.js')).href)
}

async function development(configFile) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  process.env.CA_STARTUP_ACCEPTANCE_CONFIG = configFile
  process.env.ELECTRON_ENTRY = __filename
  const { createServer } = await import('electron-vite')
  await createServer({ configFile: path.join(root, 'electron.vite.config.ts'), renderer: { server: { host: '127.0.0.1', port: config.port, strictPort: true } } }, {})
}

async function acceptance() {
  if (process.platform !== 'win32') throw Error('REAL_WINDOWS_REQUIRED')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-restore-host-'))
  const evidence = path.join(root, '.code-awareness/restore-active/dev-restart')
  fs.mkdirSync(evidence, { recursive: true })
  const appData = path.join(temporary, 'appData'), profile = path.join(appData, 'code-awareness')
  fs.mkdirSync(profile, { recursive: true })
  const repositories = { A: path.join(temporary, 'repository-A'), B: path.join(temporary, 'repository-B') }
  for (const folder of Object.values(repositories)) {
    fs.mkdirSync(folder); execFileSync('git', ['init', folder], { windowsHide: true, stdio: 'ignore' })
    fs.writeFileSync(path.join(folder, 'example.ts'), 'export const startupFixture = true\n')
  }
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ rootFolders: [], individualProjects: Object.values(repositories), hiddenProjects: [], remoteAccessEnabled: false }))
  for (const [stage, expected, select] of [['select-A', null, 'A'], ['restore-A-select-B', 'A', 'B'], ['restore-B', 'B', null]]) {
    const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)) }) })
    const result = path.join(evidence, stage + '.json'), configFile = path.join(evidence, stage + '-config.json')
    fs.writeFileSync(configFile, JSON.stringify({ temporary, appData, profile, repositories, stage, expected, select, result, port }))
    const env = Object.fromEntries(['SystemRoot', 'PATH', 'PATHEXT', 'ComSpec'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
    Object.assign(env, { APPDATA: appData, LOCALAPPDATA: path.join(temporary, 'local'), USERPROFILE: temporary, HOME: temporary, TEMP: temporary, TMP: temporary })
    const child = spawn(process.execPath, [__filename, '--dev', configFile], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-65536) })
    const deadline = setTimeout(() => { if (child.exitCode === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }, 120000)
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
    clearTimeout(deadline); fs.writeFileSync(path.join(evidence, stage + '.log'), log)
    assert.equal(code, 0, log.slice(-3000)); assert.equal(JSON.parse(fs.readFileSync(result, 'utf8')).status, 'PASS')
    console.log(JSON.stringify({ stage, status: 'PASS', evidence: result }))
    await pause(300)
  }
  console.log(JSON.stringify({ status: 'PASS', evidence, profile, proof: 'THREE_REAL_DEV_HOST_STARTS_WITH_PRIVATE_PROFILE' }))
}

const run = process.versions.electron ? application() : process.argv[2] === '--dev' ? development(process.argv[3]) : acceptance()
run.catch(error => { console.error(error.stack); process.exitCode = 1 })
