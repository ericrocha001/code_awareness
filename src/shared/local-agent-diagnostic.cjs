const stages = new Set(['profile', 'descriptor', 'connect', 'response', 'worktree', 'request', 'protocol'])
const reasons = new Set(['APPDATA_UNAVAILABLE', 'PROFILE_INVALID', 'PROFILE_NOT_FOUND', 'ACCESS_DENIED', 'IO_ERROR', 'DESCRIPTOR_NOT_FOUND', 'DESCRIPTOR_INVALID', 'PROTOCOL_INCOMPATIBLE', 'ENDPOINT_INVALID', 'PIPE_NOT_FOUND', 'CONNECTION_REFUSED', 'TIMEOUT', 'CONNECTION_RESET', 'CONNECTION_FAILED', 'PREMATURE_CLOSE', 'MALFORMED_RESPONSE', 'RESPONSE_LIMIT', 'REQUEST_LIMIT', 'SERVER_REJECTED', 'ROOT_UNAVAILABLE', 'IDENTITY_UNAVAILABLE'])
const operations = new Set(['status', 'worktree', 'resolve', 'snapshot', 'register', 'lookup'])
const snapshotPhases = ['dispatch', 'select', 'registry', 'index', 'worktree', 'revalidate', 'response']
const isDuration = value => Number.isSafeInteger(value) && value >= 0 && value <= 60000

function safeDiagnostic(error, fallback = 'INVALID_ARGUMENT') {
  const phase = snapshotPhases.includes(error?.snapshotPhase) ? error.snapshotPhase : undefined
  const snapshotTimings = Object.fromEntries(snapshotPhases
    .filter(key => isDuration(error?.snapshotTimings?.[key]))
    .map(key => [key, error.snapshotTimings[key]]))
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,64}$/.test(error.code) ? error.code : fallback
  return { code, ...(stages.has(error?.stage) ? { stage: error.stage } : {}), ...(reasons.has(error?.reason) ? { reason: error.reason } : {}), ...(operations.has(error?.operation) ? { operation: error.operation } : {}), ...(isDuration(error?.elapsedMs) ? { elapsedMs: error.elapsedMs } : {}),
    ...(error?.operation === 'snapshot' ? {
      ...(phase ? { snapshotPhase: phase } : {}),
      ...(Object.keys(snapshotTimings).length ? { snapshotTimings } : {}),
      ...(isDuration(error.connectMs) ? { connectMs: error.connectMs } : {})
    } : {}) }
}
module.exports = { safeDiagnostic }
