const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { desktopUserData } = require('../../src/shared/desktop-profile.cjs')
const { readDescriptor, publicError } = require('./discovery.cjs')
const { connect } = require('./client.cjs')

const channel = { directory: 'local-agent-channel', protocol: 'code-awareness-local/v1' }
const descriptor = { protocol: channel.protocol, endpoint: '\\\\.\\pipe\\code-awareness-continuum-' + 'a'.repeat(48), token: 'private-token' }
const matches = (stage, reason) => error => {
  assert.deepEqual(publicError(error), { code: 'APP_UNAVAILABLE', stage, reason })
  assert.equal(JSON.stringify(publicError(error)).includes('private'), false)
  return true
}

test('deterministic Windows profile is independent of cwd and honors explicit preserved profiles', () => {
  const appData = mkdtempSync(join(tmpdir(), 'cli-profile-'))
  try {
    const profile = desktopUserData(appData)
    mkdirSync(join(profile, channel.directory), { recursive: true })
    writeFileSync(join(profile, channel.directory, 'endpoint.json'), JSON.stringify(descriptor))
    assert.deepEqual(readDescriptor(undefined, channel, { platform: 'win32', env: { APPDATA: appData } }), descriptor)
    assert.deepEqual(readDescriptor(profile, channel, { platform: 'win32', env: {} }), descriptor)
    assert.throws(() => readDescriptor(undefined, channel, { platform: 'win32', env: {} }), { code: 'PROFILE_REQUIRED' })
    assert.throws(() => readDescriptor(join(appData, 'wrong'), channel), matches('profile', 'PROFILE_NOT_FOUND'))
    rmSync(join(profile, channel.directory), { recursive: true })
    assert.throws(() => readDescriptor(profile, channel), matches('descriptor', 'DESCRIPTOR_NOT_FOUND'))
  } finally { rmSync(appData, { recursive: true, force: true }) }
})

test('discovery separates filesystem denial, invalid descriptors and incompatible protocols without secrets', () => {
  const filesystem = { statSync: () => ({ isDirectory: () => true }), readFileSync: () => JSON.stringify(descriptor) }
  for (const code of ['EACCES', 'EPERM']) {
    assert.throws(() => readDescriptor('private-profile', channel, { filesystem: { ...filesystem, statSync: () => { throw { code } } } }), matches('profile', 'ACCESS_DENIED'))
    assert.throws(() => readDescriptor('private-profile', channel, { filesystem: { ...filesystem, readFileSync: () => { throw { code } } } }), matches('descriptor', 'ACCESS_DENIED'))
  }
  for (const value of ['{', 'null', '[]', '{}', JSON.stringify({ ...descriptor, token: '' })]) {
    assert.throws(() => readDescriptor('private-profile', channel, { filesystem: { ...filesystem, readFileSync: () => value } }), matches('descriptor', 'DESCRIPTOR_INVALID'))
  }
  assert.throws(() => readDescriptor('private-profile', channel, { filesystem: { ...filesystem, readFileSync: () => JSON.stringify({ ...descriptor, protocol: 'unknown' }) } }), matches('descriptor', 'PROTOCOL_INCOMPATIBLE'))
  assert.throws(() => readDescriptor('private-profile', channel, { platform: 'win32', filesystem: { ...filesystem, readFileSync: () => JSON.stringify({ ...descriptor, endpoint: 'http://localhost' }) } }), matches('descriptor', 'ENDPOINT_INVALID'))
})

function socketFixture(onWrite = () => {}) {
  const socket = new EventEmitter()
  socket.setEncoding = () => {}
  socket.destroy = () => { socket.destroyed = true }
  socket.write = onWrite
  return socket
}

test('connection errors retain legacy code and distinguish missing, refused, denied and reset', async () => {
  for (const [code, reason] of [['ENOENT', 'PIPE_NOT_FOUND'], ['ECONNREFUSED', 'CONNECTION_REFUSED'], ['EACCES', 'ACCESS_DENIED'], ['EPERM', 'ACCESS_DENIED'], ['ETIMEDOUT', 'TIMEOUT'], ['ECONNRESET', 'CONNECTION_RESET']]) {
    const socket = socketFixture()
    const result = connect(descriptor, {}, { createConnection: () => socket })
    socket.emit('error', { code, message: 'private-token private-profile' })
    await assert.rejects(result, matches('connect', reason))
    assert.equal(socket.destroyed, true)
  }
  await assert.rejects(connect(descriptor, {}, { createConnection: () => { throw { code: 'EPERM' } } }), matches('connect', 'ACCESS_DENIED'))
})

test('timeout and premature closure report the actual stage, without retry', async () => {
  for (const connected of [false, true]) {
    const socket = socketFixture()
    const timeout = connect(descriptor, {}, { createConnection: () => socket, timeoutMs: 5 })
    if (connected) socket.emit('connect')
    await assert.rejects(timeout, { code: 'IPC_TIMEOUT', stage: connected ? 'response' : 'connect', reason: 'TIMEOUT' })
    const closing = socketFixture()
    const closed = connect(descriptor, {}, { createConnection: () => closing })
    if (connected) closing.emit('connect')
    closing.emit('close')
    await assert.rejects(closed, { code: 'IPC_CLOSED', stage: connected ? 'response' : 'connect', reason: 'PREMATURE_CLOSE' })
  }
})

test('response framing, legacy errors and authentication outcomes remain compatible', async () => {
  for (const [wire, expected] of [['{"result":{"available":true}}\n', { available: true }], ['{"error":{"code":"UNAUTHORIZED"}}\n', 'UNAUTHORIZED'], ['invalid\n', 'IPC_PROTOCOL_ERROR']]) {
    const socket = socketFixture()
    const result = connect(descriptor, {}, { createConnection: () => socket })
    socket.emit('connect')
    socket.emit('data', wire)
    if (typeof expected === 'string') await assert.rejects(result, { code: expected })
    else assert.deepEqual(await result, expected)
  }
})
