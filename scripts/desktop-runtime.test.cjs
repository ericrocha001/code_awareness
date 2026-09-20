const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomBytes, randomUUID, createHash } = require('node:crypto')
const { createHarness, stateFiles } = require('./desktop-runtime/harness.cjs')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-desktop-proof-'))
  const harness = await createHarness()
  let passed = 0
  const credential = randomBytes(32).toString('base64url')
  const id = randomUUID()
  function profile(name) {
    const appData = path.join(root, name)
    const result = harness.canonicalDesktopProfile(appData)
    fs.mkdirSync(result.installationPath, { recursive: true })
    fs.writeFileSync(result.settingsPath, JSON.stringify({ remoteAccessEnabled: true, transportKind: 'relay', unrelated: { preserved: 17 } }))
    fs.writeFileSync(path.join(result.installationPath, 'installation.json'), JSON.stringify({ id }))
    return { appData, ...result }
  }
  function snapshot(value) {
    return stateFiles.map((file) => {
      const absolute = path.join(value.userData, file)
      return fs.existsSync(absolute) ? createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') : null
    })
  }
  function safe(result) { assert.ok(!JSON.stringify({ ...result, credential: undefined }).includes(credential)) }
  async function proof(name, run) {
    try { await run(); console.log(`PASS ${name}`); passed++ }
    catch (error) { error.proof = name; throw error }
  }
  try {
    const source = profile('source'), destination = profile('destination')
    await proof('real safeStorage persists across two Electron processes', async () => {
      const written = await harness.run({ mode: 'write', appData: source.appData, credential })
      assert.equal(written.healthy, true); safe(written)
      const read = await harness.run({ mode: 'read', appData: source.appData })
      assert.equal(read.credential, credential); safe(read)
    })
    await proof('canonical doctor is read-only and reports persisted settings', async () => {
      const before = snapshot(source)
      const result = await harness.doctor(source)
      assert.equal(result.healthy, true); assert.equal(result.enabled, true); assert.equal(result.transport, 'relay')
      assert.deepEqual(snapshot(source), before); safe(result)
      await assert.rejects(harness.doctor({ ...source, appName: 'Electron', userData: path.join(source.appData, 'Electron') }), { code: 'NON_CANONICAL_DESKTOP_PROFILE' })
    })
    await proof('non-canonical Electron profile aborts before protected access', async () => {
      const before = snapshot(source)
      const result = await harness.run({ mode: 'write', appData: source.appData, wrongProfile: true, credential })
      assert.equal(result.code, 'NON_CANONICAL_DESKTOP_PROFILE')
      assert.ok(result.expected.userData.endsWith('code-awareness')); assert.ok(result.actual.userData.endsWith('Electron'))
      assert.deepEqual(snapshot(source), before); safe(result)
    })
    await proof('missing and invalid settings/identity/credential are classified without defaults', async () => {
      const absent = profile('absent')
      fs.unlinkSync(absent.settingsPath)
      let result = await harness.doctor(absent)
      assert.equal(result.checks.Settings, 'SETTINGS_NOT_FOUND'); assert.equal(result.checks.Credential, 'CREDENTIAL_NOT_FOUND')
      fs.writeFileSync(absent.settingsPath, '{')
      result = await harness.doctor(absent); assert.equal(result.checks.Settings, 'SETTINGS_INVALID')
      fs.writeFileSync(absent.settingsPath, JSON.stringify({ remoteAccessEnabled: false, transportKind: 'wrong' }))
      fs.writeFileSync(path.join(absent.installationPath, 'installation.json'), '{}')
      result = await harness.doctor(absent)
      assert.equal(result.checks.Settings, 'INVALID_TRANSPORT_KIND'); assert.equal(result.checks.Installation, 'INSTALLATION_ID_UNAVAILABLE'); safe(result)
    })
    await proof('wrong encryption context is diagnosed and migration dry-run leaves state unchanged', async () => {
      assert.equal((await harness.run({ mode: 'write', appData: destination.appData, credential: randomBytes(32).toString('base64url') })).healthy, true)
      fs.copyFileSync(path.join(source.installationPath, 'installation.credential'), path.join(destination.installationPath, 'installation.credential'))
      const before = snapshot(destination)
      const result = await harness.doctor(destination)
      if (process.platform === 'win32') assert.equal(result.checks.Credential, 'CREDENTIAL_NOT_DECRYPTABLE')
      assert.deepEqual(snapshot(destination), before); safe(result)
      const dry = await harness.migrate(destination, source.userData, false)
      assert.equal(dry.changed, false); assert.deepEqual(snapshot(destination), before); safe(dry)
    })
    await proof('explicit migration preserves identity/logical credential/settings and passes fresh doctor', async () => {
      const before = snapshot(destination)
      const result = await harness.migrate(destination, source.userData, true)
      assert.equal(result.postMigrationDoctor, 'HEALTHY'); safe(result)
      const after = snapshot(destination)
      assert.deepEqual(after.slice(0, 3), before.slice(0, 3))
      const read = await harness.run({ mode: 'read', appData: destination.appData })
      assert.equal(read.credential, credential); safe(read)
    })
    await proof('conflicting installation is refused without mutation', async () => {
      const conflict = profile('conflict')
      fs.writeFileSync(path.join(conflict.installationPath, 'installation.json'), JSON.stringify({ id: randomUUID() }))
      const before = snapshot(destination)
      await assert.rejects(harness.migrate(destination, conflict.userData, true), { code: 'INSTALLATION_ID_CONFLICT' })
      assert.deepEqual(snapshot(destination), before)
    })
    console.log(`Desktop Harness: ${passed} passed; separate Electron processes; no personal credentials`)
  } finally { harness.close(); fs.rmSync(root, { recursive: true, force: true }) }
}

main().catch((error) => { console.error(`Desktop Harness FAIL: ${error.proof || 'setup'}: ${error.code || 'ASSERTION_FAILED'}`); process.exitCode = 1 })
