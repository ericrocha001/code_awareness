const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createController, fixtureRegistry, startHelper } = require('./native-dialogs.cjs')

test('only predefined Unicode fixture names and matching operations are authorized', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-native-test-'))
  try {
    const registry = fixtureRegistry(temporary, [{ name: 'entrada-漢字.md', type: 'OPEN' }, { name: 'saída.md', type: 'SAVE' }])
    const input = registry.get('entrada-漢字.md')
    fs.writeFileSync(input, 'ação\r\n漢字')
    assert.equal(registry.get('entrada-漢字.md', 'OPEN', 'CONFIRM'), input)
    assert.throws(() => registry.get('../outside.md'), { code: 'PATH_UNAUTHORIZED' })
    assert.throws(() => registry.get('entrada-漢字.md', 'SAVE', 'CONFIRM'), { code: 'PATH_UNAUTHORIZED' })
    const output = registry.get('saída.md', 'SAVE', 'CONFIRM')
    fs.writeFileSync(output, 'existing')
    assert.throws(() => registry.get('saída.md', 'SAVE', 'CONFIRM'), { code: 'FIXTURE_EXISTS' })
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

test('traversal, UNC, alternate streams, reserved and executable fixtures are rejected', () => {
  for (const name of ['../escape.md', '..\\escape.md', '\\\\server\\file.md', 'x.md:stream', 'CON.md', 'payload.exe']) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-native-test-'))
    try { assert.throws(() => fixtureRegistry(temporary, [{ name, type: 'SAVE' }]), { code: 'FIXTURE_INVALID' }) }
    finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  }
})

test('a replaced sandbox junction cannot authorize an external file', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-native-test-'))
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-native-outside-'))
  try {
    const registry = fixtureRegistry(temporary, [{ name: 'output.md', type: 'SAVE' }])
    fs.rmdirSync(registry.root)
    fs.symlinkSync(external, registry.root, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => registry.get('output.md', 'SAVE', 'CONFIRM'), { code: 'PATH_UNAUTHORIZED' })
    assert.deepEqual(fs.readdirSync(external), [])
    fs.unlinkSync(registry.root)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); fs.rmSync(external, { recursive: true, force: true }) }
})

test('Windows helper rejects a missing owner before operating any window', { skip: process.platform !== 'win32' }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-native-test-'))
  try {
    const helper = startHelper({ pid: process.pid, owner: '0', type: 'SAVE', action: 'CANCEL', target: path.join(temporary, 'unused.md'), root: temporary, timeout: 1000 })
    await assert.rejects(helper.done, { code: 'OWNER_MISMATCH' })
    await helper.exited
    assert.notEqual(helper.child.exitCode, null)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

test('rejected concurrent calls do not unlock an active operation; disposal stops it', { skip: process.platform !== 'win32' }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-native-test-'))
  const records = []
  const controller = createController({ temporary, definitions: [{ name: 'output.md', type: 'SAVE' }], records, window: { getNativeWindowHandle: () => Buffer.alloc(8), showInactive() {} } })
  try {
    const pending = controller.run({ type: 'SAVE', fixture: 'output.md' }, () => new Promise(() => {})).catch(error => error.code)
    for (let i = 0; i < 2; i++) await assert.rejects(controller.run({ type: 'SAVE', fixture: 'output.md' }, () => {}), { code: 'OPERATION_INVALID' })
    await controller.dispose()
    assert.equal(await pending, 'ABANDONED')
    assert.equal(records[0].helperStopped, true)
    assert.equal(records[0].result, 'ABANDONED')
    assert.equal(fs.existsSync(controller.fixture('output.md')), false)
  } finally { await controller.dispose(); fs.rmSync(temporary, { recursive: true, force: true }) }
})
