import { summarizeHookList } from '../../shared/native-hook-preflight.cjs'
import { nativeDigest } from './native-hooks'
import { inspectNativeInstallation } from './native-hook-installation'

export interface NativeClientScope {
  repositoryId: string; worktreeId: string; generation: string
  clientId: string; threadId: string; sessionId: string
  protocolVersion: string; clientVersion: string
  connectedAt: string
}
export interface NativeHookClient {
  authorized: boolean
  scope(): NativeClientScope | undefined
  request(method: 'hooks/list', params: { threadId: string }): Promise<unknown>
  readCompletions?(): unknown[]
}
export interface NativeTrustObservation {
  state: 'TRUSTED' | 'UNTRUSTED' | 'PARTIAL' | 'UNKNOWN' | 'UNSUPPORTED'
  reasonCode: string; freshness: string
  clientId?: string; threadId?: string; sessionId?: string; protocolVersion?: string; clientVersion?: string
  observedAt?: string; expiresAt?: string; hashDigest?: string; installationDigest?: string
  expected?: number; matched?: number; trusted?: number; issues?: { eventType: string; reasonCode: string }[]
  execution?: NativeExecutionObservation
}
export interface NativeExecutionObservation {
  state: 'OBSERVED' | 'FAILED'; reasonCode: string; freshness: string
  eventId: string; eventType: string; sessionId: string; observedAt: string
}
function hookCompletion(response: unknown, notifications: unknown[], scope: NativeClientScope, handlers: { key: string; event: string }[]): NativeExecutionObservation | undefined {
  if (!Array.isArray(notifications) || notifications.length > 64) return
  const listed = (response as { data?: { hooks: { key: string; sourcePath: string; displayOrder: number }[] }[] }).data?.flatMap(entry => entry.hooks) ?? []
  const observations = notifications.flatMap((notification): NativeExecutionObservation[] => {
    if (!notification || typeof notification !== 'object') return []
    const { threadId, run } = notification as { threadId?: unknown; run?: Record<string, unknown> }
    if (threadId !== scope.threadId || !run || run.handlerType !== 'command' || !['completed','failed','blocked','stopped'].includes(String(run.status)) || typeof run.id !== 'string' || run.id.length > 1024 ||
      !Number.isSafeInteger(run.completedAt) || !Number.isSafeInteger(run.startedAt) || Number(run.startedAt) > Number(run.completedAt) || Number(run.completedAt) * 1000 > Date.now() + 60000 ||
      Number(run.startedAt) * 1000 < Date.parse(scope.connectedAt)) return []
    const matched = handlers.filter(handler => {
      const hook = listed.find(item => item.key === handler.key)
      return hook && hook.sourcePath === run.sourcePath && hook.displayOrder === run.displayOrder && handler.event[0].toLowerCase() + handler.event.slice(1) === run.eventName
    })
    if (matched.length !== 1) return []
    const observedAt = new Date(Number(run.completedAt) * 1000).toISOString()
    return [{ state: run.status === 'completed' ? 'OBSERVED' : 'FAILED', reasonCode: run.status === 'completed' ? 'HOOK_COMPLETED' : 'HOOK_EXECUTION_FAILED', freshness: 'OBSERVED_SNAPSHOT',
      eventId: nativeDigest(JSON.stringify([scope.repositoryId, scope.clientId, scope.threadId, run.id, run.status, observedAt])), eventType: matched[0].event,
      sessionId: nativeDigest(JSON.stringify([scope.repositoryId, 'codex', scope.sessionId])), observedAt }]
  })
  return observations.sort((a, b) => b.observedAt.localeCompare(a.observedAt) || (a.state !== b.state ? a.state === 'FAILED' ? -1 : 1 : a.eventId.localeCompare(b.eventId)))[0]
}
export const unknownNativeTrust = (reasonCode: string): NativeTrustObservation => ({ state: 'UNKNOWN', reasonCode, freshness: 'UNAVAILABLE' })
export async function inspectNativeTrust(root: string, target: { repositoryId: string; worktreeId: string; generation: string }, requested: boolean, client?: NativeHookClient, assertCurrent: () => void = () => {}): Promise<NativeTrustObservation> {
  if (!requested) return unknownNativeTrust('TRUST_NOT_INSPECTED')
  if (!client) return unknownNativeTrust('SESSION_SCOPE_UNAVAILABLE')
  if (!client.authorized) return unknownNativeTrust('CLIENT_AUTHORIZATION_REQUIRED')
  const scope = client.scope()
  if (!scope || scope.repositoryId !== target.repositoryId || scope.worktreeId !== target.worktreeId || scope.generation !== target.generation ||
    ![scope.clientId, scope.threadId, scope.sessionId].every(value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) || !/^[A-Za-z0-9.+_-]{1,80}$/.test(scope.clientVersion) || !Number.isFinite(Date.parse(scope.connectedAt)) || Date.parse(scope.connectedAt) > Date.now()) return unknownNativeTrust('SESSION_SCOPE_UNAVAILABLE')
  if (scope.protocolVersion !== 'codex-app-server/v2') return { ...unknownNativeTrust('PROTOCOL_UNSUPPORTED'), state: 'UNSUPPORTED' }
  const installation = inspectNativeInstallation(root, target)
  if (installation.state !== 'CONFIGURED') return unknownNativeTrust(installation.reasonCode)
  const scopeDigest = nativeDigest(JSON.stringify(scope))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    assertCurrent()
    const response = await Promise.race([client.request('hooks/list', { threadId: scope.threadId }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PREFLIGHT_TIMEOUT')), 1500) })])
    assertCurrent()
    const currentScope = client.scope()
    if (!client.authorized || !currentScope || nativeDigest(JSON.stringify(currentScope)) !== scopeDigest) return unknownNativeTrust('SESSION_SCOPE_CHANGED')
    if (inspectNativeInstallation(root, target).digest !== installation.digest) return unknownNativeTrust('HOOK_CONFIG_DRIFT')
    const summary = summarizeHookList(response, installation.handlers)
    const { stale, ...safe } = summary
    const execution = summary.matched === 7 && client.readCompletions ? hookCompletion(response, client.readCompletions(), scope, installation.handlers) : undefined
    assertCurrent()
    if (!client.authorized || nativeDigest(JSON.stringify(client.scope() ?? null)) !== scopeDigest) return unknownNativeTrust('SESSION_SCOPE_CHANGED')
    const observedAt = new Date(), expiresAt = new Date(observedAt.getTime() + 30000)
    return { ...safe, freshness: stale ? 'STALE' : 'OBSERVED_SNAPSHOT', observedAt: observedAt.toISOString(), expiresAt: expiresAt.toISOString(),
      clientId: nativeDigest(JSON.stringify([target.repositoryId, 'codex-client', scope.clientId])), threadId: nativeDigest(JSON.stringify([target.repositoryId, 'codex-thread', scope.threadId])),
      sessionId: nativeDigest(JSON.stringify([target.repositoryId, 'codex', scope.sessionId])), protocolVersion: scope.protocolVersion, clientVersion: scope.clientVersion, installationDigest: installation.digest,
      ...(execution ? { execution } : {}) }
  } catch (error) {
    assertCurrent()
    if (error && typeof error === 'object' && 'code' in error && error.code === -32601) return { ...unknownNativeTrust('PROTOCOL_UNSUPPORTED'), state: 'UNSUPPORTED' }
    return unknownNativeTrust(error instanceof Error && error.message === 'PREFLIGHT_TIMEOUT' ? 'PREFLIGHT_TIMEOUT' : 'CLIENT_INSPECTION_UNAVAILABLE')
  } finally { if (timer) clearTimeout(timer) }
}
