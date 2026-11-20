const { randomBytes } = require('node:crypto')
const { createServer } = require('node:net')

function createDevRuntimeEnvironment(environment, { port, token }) {
  return {
    ...environment,
    CODE_AWARENESS_RELAY_ENDPOINT: environment.CODE_AWARENESS_RELAY_ENDPOINT ?? 'https://code-awareness-gateway.eric-rocha.workers.dev/mcp',
    CODE_AWARENESS_DEV_SUPERVISOR_ENDPOINT: String(port),
    CODE_AWARENESS_DEV_SUPERVISOR_TOKEN: token
  }
}

function createDevSupervisor(options) {
  const token = options.token || randomBytes(32).toString('base64url')
  let child = null
  let restartExpected = false
  let restartPrepared = false
  let devSyncReserved = null
  let devSyncPending = null
  let latestDevSyncReceipt = null
  const devSyncReceipts = new Map()
  let stopping = false

  const server = createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n')
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message
        try { message = JSON.parse(line) } catch { socket.write('REJECTED\n'); continue }
        if (message.token !== token) { socket.write('REJECTED\n'); continue }

        if (message.action === 'PREPARE') {
          if (!restartPrepared && !devSyncReserved) {
            restartPrepared = true
            socket.write('READY\n')
          } else {
            socket.write('REJECTED\n')
          }
        } else if (message.action === 'COMMIT') {
          if (restartPrepared && !devSyncReserved) {
            restartExpected = true
            socket.write('ACK\n')
          } else {
            socket.write('REJECTED\n')
          }
        } else if (message.action === 'DEV_SYNC_PREPARE') {
          if (!restartPrepared && !devSyncReserved && message.operationId) {
            restartPrepared = true
            devSyncReserved = message.operationId
            socket.write('READY\n')
          } else {
            socket.write('REJECTED\n')
          }
        } else if (message.action === 'DEV_SYNC_CANCEL') {
          if (devSyncReserved && devSyncReserved === message.operationId) {
            devSyncReserved = null
            restartPrepared = false
            socket.write('RELEASED\n')
          } else {
            socket.write('REJECTED\n')
          }
        } else if (message.action === 'DEV_SYNC_COMMIT') {
          if (devSyncReserved && devSyncReserved === message.operationId) {
            restartExpected = true
            const receipt = {
              operationId: message.operationId,
              origin: message.origin,
              expectedHead: message.expectedHead,
              oldInstanceId: message.oldInstanceId,
              status: 'RESTARTING',
              committedAt: Date.now()
            }
            devSyncPending = receipt
            devSyncReceipts.set(message.operationId, receipt)
            latestDevSyncReceipt = receipt
            devSyncReserved = null
            socket.write('ACK\n')
          } else {
            socket.write('REJECTED\n')
          }
        } else if (message.action === 'RUNTIME_READY') {
          if (devSyncPending) {
            const headMatches = message.startupHead && message.startupHead === devSyncPending.expectedHead
            const instanceDifferent = !devSyncPending.oldInstanceId || message.instanceId !== devSyncPending.oldInstanceId
            if (headMatches && instanceDifferent) {
              devSyncPending.status = 'COMPLETED'
              devSyncPending.head = message.startupHead
              devSyncPending.newInstanceId = message.instanceId
              devSyncPending.completedAt = Date.now()
              latestDevSyncReceipt = { ...devSyncPending }
              devSyncPending = null
            } else {
              devSyncPending.status = 'PARTIAL'
              devSyncPending.error = 'IDENTITY_MISMATCH'
              devSyncPending.details = { startupHead: message.startupHead, expectedHead: devSyncPending.expectedHead }
              latestDevSyncReceipt = { ...devSyncPending }
              devSyncPending = null
            }
          }
          socket.write('ACK\n')
        } else if (message.action === 'GET_DEV_SYNC_STATUS') {
          const receipt = message.operationId
            ? devSyncReceipts.get(message.operationId)
            : latestDevSyncReceipt
          socket.write(`${JSON.stringify(receipt || { status: 'NONE' })}\n`)
        } else {
          socket.write('REJECTED\n')
        }
      }
    })
  })

  function bindChild(newChild) {
    child = newChild
    child.once('exit', async (code) => {
      child = null
      if (restartExpected && !stopping) {
        restartExpected = false
        restartPrepared = false
        devSyncReserved = null
        if (devSyncPending && options.renewRuntime) {
          try {
            const renewed = await options.renewRuntime({
              port: server.address().port,
              token,
              devSync: devSyncPending
            })
            bindChild(renewed)
          } catch (err) {
            console.error(`[Dev Supervisor] Renewal failed: ${err?.message || err}`)
            if (devSyncPending) {
              devSyncPending.status = 'FAILED'
              devSyncPending.error = err?.message || String(err)
              latestDevSyncReceipt = { ...devSyncPending }
            }
            server.close()
            options.onFinalExit?.(1)
          }
        } else {
          startRuntime()
        }
      } else {
        server.close()
        options.onFinalExit?.(code ?? 1)
      }
    })
  }

  function startRuntime() {
    restartExpected = false
    restartPrepared = false
    devSyncReserved = null
    const newChild = options.spawnRuntime({ port: server.address().port, token })
    bindChild(newChild)
  }

  server.listen(0, '127.0.0.1', startRuntime)

  return {
    server,
    stop(signal = 'SIGTERM') {
      stopping = true
      restartExpected = false
      if (child) child.kill(signal)
      else server.close()
    }
  }
}

module.exports = { createDevSupervisor, createDevRuntimeEnvironment }
