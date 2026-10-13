const net = require('node:net')
const { unavailable } = require('./discovery.cjs')
const MAX_BYTES = 8 * 1024 * 1024
function connect(descriptor, payload, { createConnection = net.createConnection, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const wire = JSON.stringify({ ...payload, protocol: descriptor.protocol, token: descriptor.token }) + '\n'
    if (Buffer.byteLength(wire) > MAX_BYTES) return reject(Object.assign(new Error(), { code: 'REQUEST_TOO_LARGE' }))
    let socket
    try { socket = createConnection(descriptor.endpoint) } catch (error) { return reject(connectionError(error)) }
    const timer = setTimeout(() => finish(Object.assign(new Error('IPC_TIMEOUT'), { code: 'IPC_TIMEOUT', stage: connected ? 'response' : 'connect', reason: 'TIMEOUT' })), timeoutMs)
    let data = '', bytes = 0, done = false, connected = false
    function finish(error, result) {
      if (done) return
      done = true; clearTimeout(timer); socket.destroy()
      if (error) reject(typeof error === 'string' ? Object.assign(new Error(error), { code: error }) : error); else resolve(result)
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => { connected = true; socket.write(wire) })
    socket.on('error', error => finish(connectionError(error, connected ? 'response' : 'connect')))
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_BYTES * 2) return finish('RESPONSE_TOO_LARGE')
      data += chunk
      if (!data.endsWith('\n')) return
      try { const response = JSON.parse(data); finish(response.error?.code, response.result) } catch { finish('IPC_PROTOCOL_ERROR') }
    })
    socket.on('close', () => { if (!done) finish(Object.assign(new Error('IPC_CLOSED'), { code: 'IPC_CLOSED', stage: connected ? 'response' : 'connect', reason: 'PREMATURE_CLOSE' })) })
  })
}

function connectionError(error, stage = 'connect') {
  const reason = { ENOENT: 'PIPE_NOT_FOUND', ECONNREFUSED: 'CONNECTION_REFUSED', EACCES: 'ACCESS_DENIED', EPERM: 'ACCESS_DENIED', ETIMEDOUT: 'TIMEOUT', ECONNRESET: 'CONNECTION_RESET' }[error.code] || 'CONNECTION_FAILED'
  return unavailable(stage, reason)
}
module.exports = { connect }
