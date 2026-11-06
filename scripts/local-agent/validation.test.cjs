const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')

const descriptor = { protocol: 'code-awareness-local/v1', endpoint: 'fixture-pipe', token: 'fixture-token' }
const identity = { repositoryId: 'repository-A', worktreeId: 'worktree-A', generation: 'generation-A' }
const receiptId = '94daeed3-59ff-4ab6-bb78-cd53cb8d941f'
const association = { kind: 'TARGETED_TEST', scope: ['fixture'], evidenceFor: ['plan-A'] }

function fixture(t, responses = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requests = [], root = process.cwd()
  const load = (name, overrides) => {
    const filename = join(__dirname, name), module = { exports: {} }, localRequire = createRequire(filename)
    runInNewContext(readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, setTimeout, clearTimeout, process: { platform: process.platform },
      require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name) }, { filename })
    return module.exports
  }
  const connect = load('client.cjs', { 'node:net': { createConnection: () => {
    const socket = new EventEmitter()
    socket.setEncoding = () => {}
    socket.destroy = () => { socket.destroyed = true }
    socket.write = wire => {
      const request = JSON.parse(wire); requests.push(request)
      const response = responses[request.action] ?? { delay: 0, result: request.action === 'status'
        ? { repository: { repositoryId: identity.repositoryId }, worktrees: [{ path: root, ...identity }] }
        : { proofId: 'proof-A', state: 'PERSISTED', freshness: 'UNVERIFIABLE' } }
      setTimeout(() => socket.emit('data', JSON.stringify(response.error ? { error: { code: response.error } } : { result: response.result }) + '\n'), response.delay)
    }
    setTimeout(() => socket.emit('connect'), 0)
    return socket
  } } }).connect
  const helper = load('validation.cjs', { './client.cjs': { connect }, './discovery.cjs': { readDescriptor: () => descriptor },
    'node:fs': { realpathSync: value => value }, 'node:child_process': { execFileSync: () => root } })
  const open = async () => { const pending = helper.validationConnection(root); t.mock.timers.tick(0); return pending }
  return { requests, helper, root, open, tick: ms => { t.mock.timers.tick(0); t.mock.timers.tick(ms) } }
}

test('register accepts an authenticated response after 2s while preserving identity, receipt and association', async t => {
  const f = fixture(t, { register: { delay: 3000, result: { proofId: 'proof-A', state: 'PERSISTED', freshness: 'UNVERIFIABLE' } } })
  const connection = await f.open()
  let settled = false
  const result = connection.register(receiptId, association).then(value => { settled = true; return value })
  f.tick(2001); await Promise.resolve(); assert.equal(settled, false)
  f.tick(999)
  assert.deepEqual(JSON.parse(JSON.stringify(await result)), { proofId: 'proof-A', state: 'PERSISTED', freshness: 'UNVERIFIABLE' })
  assert.deepEqual(f.requests[1], { domain: 'validation', action: 'register', args: { ...identity, receiptId, association }, protocol: descriptor.protocol, token: descriptor.token })
  assert.equal(f.requests.length, 2)
})

test('register expires at 12s with IPC_TIMEOUT, without retry or turning a late response into success', async t => {
  const f = fixture(t, { register: { delay: 12001, result: { state: 'PERSISTED', status: 'PASSED' } } }), connection = await f.open()
  const pending = connection.register(receiptId, association)
  const rejected = assert.rejects(pending, { code: 'IPC_TIMEOUT', stage: 'response', reason: 'TIMEOUT' })
  f.tick(12000); await rejected
  f.tick(1); assert.equal(f.requests.length, 2)
})

test('status retains its 2s budget and cannot proceed to validation after timeout', async t => {
  const f = fixture(t, { status: { delay: 2001, result: {} } })
  const rejected = assert.rejects(f.open(), { code: 'IPC_TIMEOUT', stage: 'response', reason: 'TIMEOUT' })
  f.tick(2000); await rejected
  assert.deepEqual(f.requests.map(r => r.action), ['status'])
})

test('snapshot still accepts responses after 2s and expires at 12s', async t => {
  const responses = { snapshot: { delay: 3000, result: { fingerprint: 'source-A' } } }, f = fixture(t, responses), connection = await f.open()
  const accepted = connection.snapshot(); f.tick(3000)
  assert.equal((await accepted).fingerprint, 'source-A')
  assert.deepEqual(f.requests[1].args, identity)
  responses.snapshot = { delay: 12001, result: {} }
  const rejected = assert.rejects(connection.snapshot(), { code: 'IPC_TIMEOUT', stage: 'response', reason: 'TIMEOUT' })
  f.tick(12000); await rejected
  assert.equal(f.requests.length, 3)
})

for (const code of ['UNAUTHORIZED', 'REPOSITORY_MISMATCH', 'WORKTREE_STALE', 'RECEIPT_IDENTITY_MISMATCH', 'RECEIPT_ASSOCIATION_CONFLICT', 'IDEMPOTENCY_CONFLICT']) {
  test(`register preserves server rejection ${code} without retry`, async t => {
    const f = fixture(t, { register: { delay: 3000, error: code } }), connection = await f.open()
    const rejected = assert.rejects(connection.register(receiptId, association), { code })
    f.tick(3000); await rejected
    assert.equal(f.requests.length, 2)
  })
}

test('unlinked Worktree fails before registration', async t => {
  const f = fixture(t, { status: { delay: 0, result: { repository: { repositoryId: 'repository-A' }, worktrees: [] } } })
  await assert.rejects(f.open(), { code: 'WORKTREE_UNLINKED' })
  assert.deepEqual(f.requests.map(r => r.action), ['status'])
})

test('explicit receipt replay preserves the same idempotency identity and server outcome', async t => {
  const responses = { register: { delay: 3000, result: { proofId: 'proof-A', replayed: false } } }, f = fixture(t, responses), connection = await f.open()
  const first = connection.register(receiptId, association); f.tick(3000); assert.equal((await first).proofId, 'proof-A')
  responses.register = { delay: 3000, result: { proofId: 'proof-A', replayed: true } }
  const replay = connection.register(receiptId, association); f.tick(3000)
  assert.equal((await replay).replayed, true)
  assert.deepEqual(f.requests[1].args, f.requests[2].args)
  assert.equal(f.requests.length, 3)
})
