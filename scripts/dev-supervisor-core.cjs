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
  let devUpdateReserved = null
  let devUpdatePending = null
  let latestDevUpdateReceipt = null
  const devUpdateReceipts = new Map()
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
          if (!restartPrepared && !devUpdateReserved) {
            restartPrepared = true
            socket.write('READY\n')
          } else {
            socket.write('REJECTED\n')
          }
        } else if (message.action === 'COMMIT') {
          if (restartPrepared && !devUpdateReserved) {
            restartExpected = true
            socket.write('ACK\n')
          } else {
            socket.write('REJECTED\n')
          }
        // Legado técnico intencional: literais privados wire DEV_SYNC_* preservados para
        // compatibilidade com o Dev Supervisor que pode sobreviver à troca de código Electron.
        } else if (message.action === 'DEV_SYNC_PREPARE') {
          if (!restartPrepared && !devUpdateReserved && message.operationId) {
            restartPrepared = true
            devUpdateReserved = message.operationId
            socket.write('READY\n')
          } else {
            socket.write('REJECTED\n')
          }
        } else if (message.action === 'DEV_SYNC_CANCEL') {
          if (devUpdateReserved && devUpdateReserved === message.operationId) {
            devUpdateReserved = null
            restartPrepared = false
            socket.write('RELEASED\n')
          } else {
            socket.write('REJECTED\n')
          }
        } else if (message.action === 'DEV_SYNC_COMMIT') {
          if (devUpdateReserved && devUpdateReserved === message.operationId) {
            restartExpected = true
            const receipt = {
              operationId: message.operationId,
              origin: message.origin,
              expectedHead: message.expectedHead,
              oldInstanceId: message.oldInstanceId,
              status: 'RESTARTING',
              committedAt: Date.now()
            }
            devUpdatePending = receipt
            devUpdateReceipts.set(message.operationId, receipt)
            latestDevUpdateReceipt = receipt
            devUpdateReserved = null
            socket.write('ACK\n')
          } else {
            socket.write('REJECTED\n')
          }
        } else if (message.action === 'RUNTIME_READY') {
          if (devUpdatePending) {
            const headMatches = message.startupHead && message.startupHead === devUpdatePending.expectedHead
            const instanceDifferent = !devUpdatePending.oldInstanceId || message.instanceId !== devUpdatePending.oldInstanceId
            if (headMatches && instanceDifferent) {
              devUpdatePending.status = 'COMPLETED'
              devUpdatePending.head = message.startupHead
              devUpdatePending.newInstanceId = message.instanceId
              devUpdatePending.completedAt = Date.now()
              latestDevUpdateReceipt = { ...devUpdatePending }
              devUpdatePending = null
            } else {
              devUpdatePending.status = 'PARTIAL'
              devUpdatePending.error = 'IDENTITY_MISMATCH'
              devUpdatePending.details = { startupHead: message.startupHead, expectedHead: devUpdatePending.expectedHead }
              latestDevUpdateReceipt = { ...devUpdatePending }
              devUpdatePending = null
            }
          }
          socket.write('ACK\n')
        } else if (message.action === 'GET_DEV_SYNC_STATUS') {
          const receipt = message.operationId
            ? devUpdateReceipts.get(message.operationId)
            : latestDevUpdateReceipt
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
        devUpdateReserved = null
        if (devUpdatePending && options.renewRuntime) {
          try {
            const renewed = await options.renewRuntime({
              port: server.address().port,
              token,
              devUpdate: devUpdatePending
            })
            bindChild(renewed)
          } catch (err) {
            console.error(`[Dev Supervisor] Renewal failed: ${err?.message || err}`)
            if (devUpdatePending) {
              devUpdatePending.status = 'FAILED'
              devUpdatePending.error = err?.message || String(err)
              latestDevUpdateReceipt = { ...devUpdatePending }
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
    devUpdateReserved = null
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
