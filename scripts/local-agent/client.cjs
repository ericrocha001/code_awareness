const net = require('node:net')
const MAX_BYTES = 8 * 1024 * 1024
function connect(descriptor, payload) {
  return new Promise((resolve, reject) => {
    const wire = JSON.stringify({ ...payload, protocol: descriptor.protocol, token: descriptor.token }) + '\n'
    if (Buffer.byteLength(wire) > MAX_BYTES) return reject(Object.assign(new Error(), { code: 'REQUEST_TOO_LARGE' }))
    const socket = net.createConnection(descriptor.endpoint)
    const timer = setTimeout(() => finish('IPC_TIMEOUT'), 15000)
    let data = '', bytes = 0, done = false
    function finish(code, result) {
      if (done) return
      done = true; clearTimeout(timer); socket.destroy()
      if (code) reject(Object.assign(new Error(code), { code })); else resolve(result)
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(wire))
    socket.on('error', () => finish('APP_UNAVAILABLE'))
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_BYTES * 2) return finish('RESPONSE_TOO_LARGE')
      data += chunk
      if (!data.endsWith('\n')) return
      try { const response = JSON.parse(data); finish(response.error?.code, response.result) } catch { finish('IPC_PROTOCOL_ERROR') }
    })
    socket.on('close', () => { if (!done) finish('IPC_CLOSED') })
  })
}
module.exports = { connect }
