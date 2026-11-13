const stages = new Set(['profile', 'descriptor', 'connect', 'response', 'worktree', 'request', 'protocol'])
const reasons = new Set(['APPDATA_UNAVAILABLE', 'PROFILE_INVALID', 'PROFILE_NOT_FOUND', 'ACCESS_DENIED', 'IO_ERROR', 'DESCRIPTOR_NOT_FOUND', 'DESCRIPTOR_INVALID', 'PROTOCOL_INCOMPATIBLE', 'ENDPOINT_INVALID', 'PIPE_NOT_FOUND', 'CONNECTION_REFUSED', 'TIMEOUT', 'CONNECTION_RESET', 'CONNECTION_FAILED', 'PREMATURE_CLOSE', 'MALFORMED_RESPONSE', 'RESPONSE_LIMIT', 'REQUEST_LIMIT', 'SERVER_REJECTED', 'ROOT_UNAVAILABLE', 'IDENTITY_UNAVAILABLE'])
const operations = new Set(['status', 'worktree', 'resolve', 'snapshot', 'register', 'lookup'])
function safeDiagnostic(error, fallback = 'INVALID_ARGUMENT') {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,64}$/.test(error.code) ? error.code : fallback
  return { code, ...(stages.has(error?.stage) ? { stage: error.stage } : {}), ...(reasons.has(error?.reason) ? { reason: error.reason } : {}), ...(operations.has(error?.operation) ? { operation: error.operation } : {}), ...(Number.isSafeInteger(error?.elapsedMs) && error.elapsedMs >= 0 && error.elapsedMs <= 60000 ? { elapsedMs: error.elapsedMs } : {}) }
}
module.exports = { safeDiagnostic }
