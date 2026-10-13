export function localChannelStartupDiagnostic(error: unknown) {
  const value = error as { code?: unknown; stage?: unknown }
  const code = typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{2,64}$/.test(value.code) ? value.code : 'START_FAILED'
  const stage = typeof value?.stage === 'string' && ['profile', 'authorization', 'listen', 'descriptor'].includes(value.stage) ? value.stage : 'startup'
  const reason = ['EACCES', 'EPERM', 'AUTHORIZATION_UNAVAILABLE'].includes(code) ? 'ACCESS_DENIED' : code
  return { code: 'APP_UNAVAILABLE', stage, reason }
}
