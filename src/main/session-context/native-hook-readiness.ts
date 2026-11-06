import { inspectNativeInstallation } from './native-hook-installation'
import type { CheckpointRegistry } from './checkpoint-registry'
import { unknownNativeTrust, type NativeTrustObservation } from './native-hook-preflight'

export function nativeHookReadiness(registry: CheckpointRegistry, root: string, target: { worktreeId: string; generation: string }, trust: NativeTrustObservation = unknownNativeTrust('TRUST_NOT_INSPECTED')) {
  const { handlers: _handlers, ...installation } = inspectNativeInstallation(root, { repositoryId: registry.repositoryId, ...target })
  if (trust.expiresAt && Date.parse(trust.expiresAt) <= Date.now()) trust = unknownNativeTrust('TRUST_EXPIRED')
  if (trust.installationDigest && trust.installationDigest !== installation.digest) trust = unknownNativeTrust('HOOK_CONFIG_DRIFT')
  const { execution: completion, ...authorization } = trust
  const events = registry.nativeHookEvidence(target.worktreeId, target.generation, trust.sessionId).sort((a, b) => b.observedAt.localeCompare(a.observedAt))
  const event = events[0]
  const legacy = !trust.sessionId && registry.source(`NATIVE_CAPTURE:${target.worktreeId}:${target.generation}`)?.status === 'OBSERVED'
  const execution = completion ?? (event ? { state: 'OBSERVED', reasonCode: 'ENVELOPE_INGESTED', freshness: 'HISTORICAL', eventId: event.eventId, eventType: event.event, sessionId: event.sessionId, observedAt: event.observedAt } :
    legacy ? { state: 'UNKNOWN', reasonCode: 'EVENT_DETAIL_UNAVAILABLE', freshness: 'HISTORICAL' } : { state: 'UNOBSERVED', reasonCode: 'NO_EVENT_OBSERVED', freshness: 'UNAVAILABLE' })
  return { schemaVersion: 1, ...target, installation,
    trust: authorization, execution,
    nextEvidence: installation.state === 'MISSING' ? 'REQUEST_INSTALLATION_APPROVAL' : installation.state !== 'CONFIGURED' ? 'INSPECT_INSTALLATION_READ_ONLY' : execution.state === 'FAILED' ? 'INSPECT_FAILED_EVENT_READ_ONLY' :
      trust.state === 'UNTRUSTED' || trust.state === 'PARTIAL' ? 'REQUEST_CLIENT_AUTHORIZATION_REVIEW' : trust.state === 'TRUSTED' && execution.state === 'UNOBSERVED' ? 'OBSERVE_REAL_WORKFLOW_WITH_CONSENT' : 'REQUEST_CLIENT_INSPECTION' }
}
