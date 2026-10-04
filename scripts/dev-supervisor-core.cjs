const { randomBytes } = require('node:crypto')
const { createServer } = require('node:net')

function createDevSupervisor(options) {
  const token = options.token || randomBytes(32).toString('base64url')
  let child = null
  let restartExpected = false
  let restartPrepared = false
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
        if (message.action === 'PREPARE' && !restartPrepared) {
          restartPrepared = true
          socket.write('READY\n')
        } else if (message.action === 'COMMIT' && restartPrepared) {
          restartExpected = true
          socket.write('ACK\n')
        } else socket.write('REJECTED\n')
      }
    })
  })
  function startRuntime() {
    restartExpected = false
    restartPrepared = false
    child = options.spawnRuntime({ port: server.address().port, token })
    child.once('exit', (code) => {
      child = null
      if (restartExpected && !stopping) startRuntime()
      else {
        server.close()
        options.onFinalExit?.(code ?? 1)
      }
    })
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

module.exports = { createDevSupervisor }
