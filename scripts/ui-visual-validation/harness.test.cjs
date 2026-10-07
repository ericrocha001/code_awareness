const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { run } = require('./harness.cjs')
test('real Electron capture and teardown', async () => {
  const receipt = await run()
  assert.equal(receipt.status, 'PASS', JSON.stringify(receipt))
  assert.equal(receipt.cleanup, 'PASS')
  assert.ok(receipt.runtime.chromium)
  assert.equal(receipt.captures.length, 2)
  assert.throws(() => process.kill(receipt.processId, 0), { code: 'ESRCH' })
})
test('startup error has stable reason and cleanup', async () => {
  const receipt = await run({ executable: path.join(os.tmpdir(), 'nonexistent-electron.exe') })
  assert.equal(receipt.reason, 'ELECTRON_START_FAILED')
  assert.equal(receipt.cleanup, 'PASS')
})
test('unwritable output is classified', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-output-test-'))
  try { const file = path.join(folder, 'file'); fs.writeFileSync(file, 'occupied'); assert.equal((await run({ output: file })).reason, 'OUTPUT_UNWRITABLE') }
  finally { fs.rmSync(folder, { recursive: true, force: true }) }
})
test('deadline terminates Electron and cleans isolated profile', async () => {
  const receipt = await run({ scenario: 'timeout', timeout: 4000 })
  assert.equal(receipt.reason, 'HARNESS_TIMEOUT')
  assert.equal(receipt.cleanup, 'PASS')
  assert.throws(() => process.kill(receipt.processId, 0), { code: 'ESRCH' })
})
