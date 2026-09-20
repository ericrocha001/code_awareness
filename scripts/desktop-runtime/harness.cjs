const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomBytes } = require('node:crypto')
const { spawn } = require('node:child_process')
const { buildSync } = require('esbuild')

const stateFiles = ['Local State', 'settings.json', 'installation/installation.json', 'installation/installation.credential']

function fail(code, stage = 'migration') { throw Object.assign(new Error(code), { code, stage }) }

async function createHarness() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-desktop-harness-'))
  const worker = path.join(temporary, 'worker.cjs')
  const profileBundle = path.join(temporary, 'profile.cjs')
  try {
    buildSync({ entryPoints: [path.join(__dirname, '../desktop-runtime-worker.ts')], outfile: worker, bundle: true, platform: 'node', external: ['electron'], logLevel: 'silent' })
    buildSync({ entryPoints: [path.join(__dirname, '../../src/main/desktop-profile.ts')], outfile: profileBundle, bundle: true, platform: 'node', logLevel: 'silent' })
  } catch {
    fs.rmSync(temporary, { recursive: true, force: true })
    fail('HARNESS_BUILD_FAILED', 'build')
  }
  const { canonicalDesktopProfile, assertCanonicalDesktopProfile } = require(profileBundle)

  function guard(profile) {
    return assertCanonicalDesktopProfile({ getName: () => profile.appName, getPath: (name) => name === 'userData' ? profile.userData : profile.appData || path.dirname(profile.userData) })
  }

  function run(input) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(require('electron'), [worker], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      let result, output = ''
      const timeout = setTimeout(() => { child.kill(); reject(Object.assign(new Error('HARNESS_TIMEOUT'), { code: 'HARNESS_TIMEOUT' })) }, 30000)
      child.stdout.on('data', (data) => { output += data })
      child.stderr.on('data', (data) => { output += data })
      child.on('message', (message) => { result = message })
      child.on('error', () => { clearTimeout(timeout); reject(Object.assign(new Error('ELECTRON_START_FAILED'), { code: 'ELECTRON_START_FAILED' })) })
      child.on('exit', (code) => {
        clearTimeout(timeout)
        if (code !== 0 || !result) reject(Object.assign(new Error('ELECTRON_PROBE_FAILED'), { code: 'ELECTRON_PROBE_FAILED' }))
        else resolve({ ...result, output })
      })
      child.send(input)
    })
  }

  function snapshot(origin, keyOrigin = origin) {
    const appData = fs.mkdtempSync(path.join(temporary, 'profile-'))
    const profile = canonicalDesktopProfile(appData)
    fs.mkdirSync(profile.installationPath, { recursive: true, mode: 0o700 })
    for (const file of stateFiles) {
      const source = path.join(file === 'Local State' ? keyOrigin : origin, file)
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(profile.userData, file))
    }
    return { appData, ...profile }
  }

  async function doctor(profile) {
    guard(profile)
    const copy = snapshot(profile.userData)
    return run({ mode: 'doctor', appData: copy.appData })
  }

  async function migrate(profile, source, apply) {
    guard(profile)
    const before = new Map(stateFiles.map((file) => {
      const destination = path.join(profile.userData, file)
      return [file, fs.existsSync(destination) ? fs.readFileSync(destination) : null]
    }))
    if (path.resolve(source) === path.resolve(profile.userData)) fail('SOURCE_EQUALS_DESTINATION')
    const targetIdFile = path.join(profile.installationPath, 'installation.json')
    const sourceIdFile = path.join(source, 'installation/installation.json')
    const targetExists = fs.existsSync(targetIdFile)
    const sourceExists = fs.existsSync(sourceIdFile)
    if (!targetExists && !sourceExists) fail('INSTALLATION_ID_UNAVAILABLE')
    const readId = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).id } catch { fail('INSTALLATION_ID_UNAVAILABLE') } }
    if (targetExists && sourceExists && readId(targetIdFile) !== readId(sourceIdFile)) fail('INSTALLATION_ID_CONFLICT')
    const origin = targetExists ? profile.userData : source
    const sourceCopy = snapshot(origin, source)
    const sourceCredential = path.join(source, 'installation/installation.credential')
    if (fs.existsSync(sourceCredential)) fs.copyFileSync(sourceCredential, path.join(sourceCopy.installationPath, 'installation.credential'))
    if (!fs.existsSync(path.join(source, 'Local State')) && process.platform === 'win32') fail('SOURCE_PROTECTION_KEY_UNAVAILABLE')
    const recovered = await run({ mode: 'read', appData: sourceCopy.appData })
    if (!recovered.healthy || !recovered.credential) fail('SOURCE_CREDENTIAL_NOT_DECRYPTABLE')
    const destinationCopy = snapshot(profile.userData)
    for (const file of ['settings.json', 'installation/installation.json']) {
      const destination = path.join(destinationCopy.userData, file)
      if (!fs.existsSync(destination)) fs.copyFileSync(path.join(origin, file), destination)
    }
    const written = await run({ mode: 'write', appData: destinationCopy.appData, credential: recovered.credential })
    if (!written.healthy) fail('DESTINATION_ENCRYPTION_FAILED')
    const verified = await run({ mode: 'read', appData: destinationCopy.appData })
    if (!verified.healthy || verified.credential !== recovered.credential) fail('CROSS_PROCESS_VERIFICATION_FAILED')
    if (!apply) return { healthy: true, stage: 'dry-run', action: 'preserve identity/settings; re-encrypt existing logical credential', changed: false }
    for (const [file, previous] of before) {
      const destination = path.join(profile.userData, file)
      const current = fs.existsSync(destination) ? fs.readFileSync(destination) : null
      if (previous === null ? current !== null : !current || !previous.equals(current)) fail('DESKTOP_STATE_CHANGED')
    }
    const updates = ['installation/installation.credential']
    for (const file of ['Local State', 'settings.json', 'installation/installation.json']) if (!fs.existsSync(path.join(profile.userData, file))) updates.unshift(file)
    const backups = new Map(updates.map((file) => [file, fs.existsSync(path.join(profile.userData, file)) ? fs.readFileSync(path.join(profile.userData, file)) : null]))
    try {
      for (const file of updates) atomicWrite(path.join(profile.userData, file), fs.readFileSync(path.join(destinationCopy.userData, file)))
      const check = await doctor(profile)
      if (!check.healthy) fail('POST_MIGRATION_DOCTOR_FAILED')
      return { healthy: true, stage: 'migration', changed: true, postMigrationDoctor: 'HEALTHY' }
    } catch (error) {
      for (const [file, previous] of backups) {
        const destination = path.join(profile.userData, file)
        if (previous) atomicWrite(destination, previous)
        else fs.rmSync(destination, { force: true })
      }
      throw error
    }
  }

  return { run, snapshot, doctor, migrate, canonicalDesktopProfile, resolve: () => run({ mode: 'resolve' }), close: () => fs.rmSync(temporary, { recursive: true, force: true }) }
}

function atomicWrite(destination, bytes) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`
  try { fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, destination) }
  finally { fs.rmSync(temporary, { force: true }) }
}

module.exports = { createHarness, stateFiles }
