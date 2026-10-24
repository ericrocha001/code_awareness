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
test('unbounded or invalid deadlines are refused before Electron starts', async () => {
  for (const timeout of [0, NaN, 120001]) {
    const receipt = await run({ timeout })
    assert.equal(receipt.reason, 'TIMEOUT_INVALID')
    assert.equal(receipt.processId, undefined)
  }
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

test('Code Map convergence records checkout and HEAD even when launch is refused', async () => {
  const receipt = await run({ scenario: 'codemap-convergence', timeout: 0 })
  assert.equal(receipt.reason, 'TIMEOUT_INVALID')
  assert.equal(receipt.processId, undefined)
  assert.equal(receipt.source?.checkout, path.resolve(__dirname, '../..'))
  assert.equal(receipt.source?.head, require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim())
  assert.equal(receipt.source?.observation, 'SCENARIO_START')
})

test('Code Map renderer and continuous IPC failures remain FAIL with a healthy Main', async t => {
  const vm = require('node:vm')
  const source = fs.readFileSync(path.join(__dirname, 'scenarios/codemap-convergence.cjs'), 'utf8')
  const assertions = ['Main and continuous production IPC stay below 750ms across all phases', 'No renderer errors'].map(name => {
    const line = source.split(/\r?\n/).find(line => line.trim().startsWith('ctx.check(') && line.includes(name))
    assert.ok(line, name)
    return line.trim()
  }).join('\n')
  const controls = [
    { name: 'healthy control', expected: 'PASS' },
    { name: 'renderer failure', rendererErrors: ['injected render failure'], expected: 'FAIL' },
    { name: 'IPC rejection', continuousIpc: { samples: 20, failures: 1 }, expected: 'FAIL' },
    { name: 'IPC stall', maxIpcMs: 900, expected: 'FAIL' }
  ]
  for (const control of controls) await t.test(control.name, async () => {
    const temporary = path.join(os.tmpdir(), 'ca-ui-gate-control')
    const paths = {}
    let destroyed = false
    const scenario = { run: vm.runInNewContext('(async ctx => {\n' + assertions + '\n})', {
      maxEventLoopMs: 5, maxIpcMs: control.maxIpcMs ?? 5, pulses: 20,
      continuousIpc: control.continuousIpc ?? { samples: 20, failures: 0 }, rendererErrors: control.rendererErrors ?? []
    }) }
    const receipt = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Worker control did not finish')), 2000)
      const electron = { app: {
        setPath: (key, value) => { paths[key] = value }, getPath: key => paths[key],
        disableHardwareAcceleration() {}, whenReady: () => Promise.resolve(), quit() {}
      }, BrowserWindow: class { destroy() { destroyed = true } } }
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'worker.cjs'), 'utf8'), {
        require: name => name === 'electron' ? electron : name === 'control-scenario' ? scenario : name === 'node:fs'
          ? { readFileSync: () => JSON.stringify({ temporary, scenario: 'control-scenario' }) }
          : name === './evidence.cjs' ? require('./evidence.cjs') : require(name),
        process: { argv: ['', '', 'control-config'], versions: {}, platform: process.platform,
          send: (result, done) => { clearTimeout(deadline); done(); resolve(result) } },
        setTimeout, clearTimeout
      })
    })
    assert.equal(receipt.status, control.expected)
    assert.equal(destroyed, true)
    if (control.expected === 'FAIL') {
      assert.equal(receipt.reason, 'CHECK_FAILED')
      assert.ok(receipt.checks.some(check => !check.passed))
    }
  })
})
