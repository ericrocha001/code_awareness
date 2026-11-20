const { test, describe, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createConnection } = require('node:net')
const { EventEmitter } = require('node:events')
const { createDevSupervisor } = require('./dev-supervisor-core.cjs')

function createMockChild() {
  const child = new EventEmitter()
  child.kill = (signal) => {
    child.emit('exit', 0, signal)
  }
  return child
}

function sendCommand(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(`${JSON.stringify(payload)}\n`)
    })
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline >= 0) {
        socket.end()
        resolve(buffer.slice(0, newline))
      }
    })
    socket.on('error', reject)
  })
}

describe('dev-supervisor-core', () => {
  let activeSupervisor = null

  afterEach(() => {
    if (activeSupervisor) {
      activeSupervisor.stop('SIGTERM')
      activeSupervisor = null
    }
  })

  test('handles legacy PREPARE and COMMIT correctly', async () => {
    let mockChild = createMockChild()
    let spawnCount = 0
    activeSupervisor = createDevSupervisor({
      token: 'test-token',
      spawnRuntime() {
        spawnCount++
        return mockChild
      }
    })

    await new Promise((resolve) => activeSupervisor.server.once('listening', resolve))
    const port = activeSupervisor.server.address().port

    const prep = await sendCommand(port, { action: 'PREPARE', token: 'test-token' })
    assert.equal(prep, 'READY')

    const commit = await sendCommand(port, { action: 'COMMIT', token: 'test-token' })
    assert.equal(commit, 'ACK')

    // On child exit, runtime should be restarted
    const nextChild = createMockChild()
    activeSupervisor.spawnRuntime = () => nextChild
    mockChild.emit('exit', 0)
    assert.equal(spawnCount, 2)
  })

  test('orchestrates DEV_SYNC_PREPARE, CANCEL, and single-flight lock', async () => {
    const mockChild = createMockChild()
    activeSupervisor = createDevSupervisor({
      token: 'test-token',
      spawnRuntime: () => mockChild
    })

    await new Promise((resolve) => activeSupervisor.server.once('listening', resolve))
    const port = activeSupervisor.server.address().port

    // Reserve via legacy wire literal (DEV_SYNC_PREPARE)
    const prep1 = await sendCommand(port, { action: 'DEV_SYNC_PREPARE', token: 'test-token', operationId: 'op-1' })
    assert.equal(prep1, 'READY')

    // Second reservation attempt should be rejected (single-flight)
    const prep2 = await sendCommand(port, { action: 'DEV_SYNC_PREPARE', token: 'test-token', operationId: 'op-2' })
    assert.equal(prep2, 'REJECTED')

    // Cancel op-2 should fail because op-1 holds lock
    const cancel2 = await sendCommand(port, { action: 'DEV_SYNC_CANCEL', token: 'test-token', operationId: 'op-2' })
    assert.equal(cancel2, 'REJECTED')

    // Cancel op-1 releases lock
    const cancel1 = await sendCommand(port, { action: 'DEV_SYNC_CANCEL', token: 'test-token', operationId: 'op-1' })
    assert.equal(cancel1, 'RELEASED')

    // Now op-2 can acquire
    const prepAgain = await sendCommand(port, { action: 'DEV_SYNC_PREPARE', token: 'test-token', operationId: 'op-2' })
    assert.equal(prepAgain, 'READY')
  })

  test('orchestrates DEV_SYNC_COMMIT, renewRuntime, and RUNTIME_READY verification', async () => {
    const mockChild1 = createMockChild()
    const mockChild2 = createMockChild()
    let renewedWith = null

    activeSupervisor = createDevSupervisor({
      token: 'test-token',
      spawnRuntime: () => mockChild1,
      async renewRuntime({ devUpdate }) {
        renewedWith = devUpdate
        return mockChild2
      }
    })

    await new Promise((resolve) => activeSupervisor.server.once('listening', resolve))
    const port = activeSupervisor.server.address().port

    // Prepare
    await sendCommand(port, { action: 'DEV_SYNC_PREPARE', token: 'test-token', operationId: 'op-sync-1' })

    // Commit
    const commitResp = await sendCommand(port, {
      action: 'DEV_SYNC_COMMIT',
      token: 'test-token',
      operationId: 'op-sync-1',
      origin: { rootPath: '/test/root', branch: 'main' },
      expectedHead: 'commit-sha-target',
      oldInstanceId: 'inst-1'
    })
    assert.equal(commitResp, 'ACK')

    // Query status before exit
    const statusBefore = JSON.parse(await sendCommand(port, { action: 'GET_DEV_SYNC_STATUS', token: 'test-token', operationId: 'op-sync-1' }))
    assert.equal(statusBefore.status, 'RESTARTING')
    assert.equal(statusBefore.expectedHead, 'commit-sha-target')

    // Child 1 exits -> renewRuntime called
    mockChild1.emit('exit', 0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(renewedWith)
    assert.equal(renewedWith.operationId, 'op-sync-1')
    assert.equal(renewedWith.expectedHead, 'commit-sha-target')

    // Child 2 starts and announces RUNTIME_READY with matching head
    const readyResp = await sendCommand(port, {
      action: 'RUNTIME_READY',
      token: 'test-token',
      instanceId: 'inst-2',
      startupHead: 'commit-sha-target',
      sourceOrigin: { worktree: { rootPath: '/test/root', branch: 'main' } }
    })
    assert.equal(readyResp, 'ACK')

    // Query status after ready
    const statusAfter = JSON.parse(await sendCommand(port, { action: 'GET_DEV_SYNC_STATUS', token: 'test-token', operationId: 'op-sync-1' }))
    assert.equal(statusAfter.status, 'COMPLETED')
    assert.equal(statusAfter.head, 'commit-sha-target')
    assert.equal(statusAfter.newInstanceId, 'inst-2')
  })

  test('marks PARTIAL when RUNTIME_READY reports mismatched head', async () => {
    const mockChild1 = createMockChild()
    const mockChild2 = createMockChild()

    activeSupervisor = createDevSupervisor({
      token: 'test-token',
      spawnRuntime: () => mockChild1,
      async renewRuntime() {
        return mockChild2
      }
    })

    await new Promise((resolve) => activeSupervisor.server.once('listening', resolve))
    const port = activeSupervisor.server.address().port

    await sendCommand(port, { action: 'DEV_SYNC_PREPARE', token: 'test-token', operationId: 'op-sync-mismatch' })
    await sendCommand(port, {
      action: 'DEV_SYNC_COMMIT',
      token: 'test-token',
      operationId: 'op-sync-mismatch',
      origin: { rootPath: '/test/root', branch: 'main' },
      expectedHead: 'expected-sha',
      oldInstanceId: 'inst-1'
    })

    mockChild1.emit('exit', 0)
    await new Promise((resolve) => setImmediate(resolve))

    // Child 2 starts with unexpected head
    await sendCommand(port, {
      action: 'RUNTIME_READY',
      token: 'test-token',
      instanceId: 'inst-2',
      startupHead: 'wrong-sha'
    })

    const statusAfter = JSON.parse(await sendCommand(port, { action: 'GET_DEV_SYNC_STATUS', token: 'test-token', operationId: 'op-sync-mismatch' }))
    assert.equal(statusAfter.status, 'PARTIAL')
    assert.equal(statusAfter.error, 'IDENTITY_MISMATCH')
  })
})
