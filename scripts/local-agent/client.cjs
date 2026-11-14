const net = require('node:net')
const { performance } = require('node:perf_hooks')
const { unavailable, publicError } = require('./discovery.cjs')
const MAX_BYTES = 8 * 1024 * 1024
function connect(descriptor, payload, { createConnection = net.createConnection, timeoutMs = 15000, onSnapshotDiagnostic } = {}) {
  return new Promise((resolve, reject) => {
    const wire = JSON.stringify({ ...payload, protocol: descriptor.protocol, token: descriptor.token }) + '\n'
    if (Buffer.byteLength(wire) > MAX_BYTES) return reject(Object.assign(new Error(), { code: 'REQUEST_TOO_LARGE', stage: 'request', reason: 'REQUEST_LIMIT' }))
    const startedAt = performance.now()
    const isSnapshot = payload.domain === 'validation' && payload.action === 'snapshot'
    let socket
    try { socket = createConnection(descriptor.endpoint) } catch (error) { return reject(connectionError(error)) }
    let connectMs
    const timer = setTimeout(() => finish(Object.assign(new Error('IPC_TIMEOUT'), { code: 'IPC_TIMEOUT', stage: connected ? 'response' : 'connect', reason: 'TIMEOUT' })), timeoutMs)
    let data = '', bytes = 0, done = false, connected = false
    function finish(error, result) {
      if (done) return
      done = true; clearTimeout(timer); socket.destroy()
      if (error && isSnapshot) Object.assign(error, { operation: 'snapshot', connectMs })
      if (error) reject(error)
      else resolve(result)
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      connected = true
      connectMs = Math.round(performance.now() - startedAt)
      socket.write(wire)
    })
    socket.on('error', error => finish(connectionError(error, connected ? 'response' : 'connect')))
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_BYTES * 2) return finish(Object.assign(new Error('RESPONSE_TOO_LARGE'), { code: 'RESPONSE_TOO_LARGE', stage: 'response', reason: 'RESPONSE_LIMIT' }))
      data += chunk
      if (!data.endsWith('\n')) return
      try {
        const response = JSON.parse(data)
        if (!response || typeof response !== 'object' || Array.isArray(response) || !Object.hasOwn(response, 'result') && !response.error || response.error && (typeof response.error.code !== 'string' || !/^[A-Z][A-Z0-9_]{2,64}$/.test(response.error.code))) throw new Error('IPC_PROTOCOL_ERROR')
        const error = response.error
        const semantic = error?.code === 'MISSING_SEMANTIC_FIELD' && ['name', 'description', 'kind'].includes(error.field)
          ? Object.assign(new Error(`MISSING_SEMANTIC_FIELD: ${error.field}: provide an explicit semantic ${error.field}`), { code: error.code, field: error.field }) : error ? Object.assign(new Error(error.code), publicError(error)) : undefined
        if (semantic) { semantic.stage ??= 'response'; semantic.reason ??= 'SERVER_REJECTED' }
        if (!semantic && isSnapshot && onSnapshotDiagnostic) {
          const diagnostic = publicError({ ...response.diagnostic, code: 'SNAPSHOT_COMPLETE', operation: 'snapshot', connectMs })
          const elapsedMs = Math.round(performance.now() - startedAt)
          onSnapshotDiagnostic({ ...diagnostic, roundTripMs: elapsedMs })
        }
        finish(semantic, response.result)
      } catch { finish(Object.assign(new Error('IPC_PROTOCOL_ERROR'), { code: 'IPC_PROTOCOL_ERROR', stage: 'response', reason: 'MALFORMED_RESPONSE' })) }
    })
    socket.on('close', () => { if (!done) finish(Object.assign(new Error('IPC_CLOSED'), { code: 'IPC_CLOSED', stage: connected ? 'response' : 'connect', reason: 'PREMATURE_CLOSE' })) })
  })
}

function connectionError(error, stage = 'connect') {
  const reason = { ENOENT: 'PIPE_NOT_FOUND', ECONNREFUSED: 'CONNECTION_REFUSED', EACCES: 'ACCESS_DENIED', EPERM: 'ACCESS_DENIED', ETIMEDOUT: 'TIMEOUT', ECONNRESET: 'CONNECTION_RESET' }[error.code] || 'CONNECTION_FAILED'
  return reason === 'TIMEOUT' ? Object.assign(new Error('IPC_TIMEOUT'), { code: 'IPC_TIMEOUT', stage, reason }) : unavailable(stage, reason)
}
module.exports = { connect }
