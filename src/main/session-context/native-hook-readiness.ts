import { inspectNativeInstallation } from './native-hook-installation'
import type { CheckpointRegistry } from './checkpoint-registry'
import { unknownNativeTrust, type NativeTrustObservation } from './native-hook-preflight'
import { nativeCaptureConfiguration } from './native-capture-window'
import { nativeCaptureRuntimeId, nativeCaptureRuntimeStartedAt, nativeHookSource, nativeSessionEntityId, readNativeBinding, type NativeHookProvider } from './native-hooks'
import { readNativeGapHistory } from './native-hook-diagnostics'
import { join } from 'node:path'

export function nativeHookReadiness(registry: CheckpointRegistry, root: string, target: { worktreeId: string; generation: string }, trust: NativeTrustObservation = unknownNativeTrust('TRUST_NOT_INSPECTED'), provider: NativeHookProvider = 'codex') {
  const { handlers: _handlers, ...installation } = inspectNativeInstallation(root, { repositoryId: registry.repositoryId, ...target }, process.platform, provider)
  if (trust.expiresAt && Date.parse(trust.expiresAt) <= Date.now()) trust = unknownNativeTrust('TRUST_EXPIRED')
  if (trust.installationDigest && trust.installationDigest !== installation.digest) trust = unknownNativeTrust('HOOK_CONFIG_DRIFT')
  const { execution: completion, ...authorization } = trust
  const expectedSource = nativeHookSource(provider)
  const events = registry.nativeHookEvidence(target.worktreeId, target.generation, trust.sessionId, expectedSource)
    .filter(item => item.source === expectedSource)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
  const event = events[0]
  const captureSource = provider === 'antigravity' ? `NATIVE_CAPTURE:antigravity:${target.worktreeId}:${target.generation}` : `NATIVE_CAPTURE:${target.worktreeId}:${target.generation}`
  const legacy = !trust.sessionId && registry.source(captureSource)?.status === 'OBSERVED'
  const execution = completion ?? (event ? { state: 'OBSERVED', reasonCode: 'ENVELOPE_INGESTED', freshness: 'HISTORICAL', eventId: event.eventId, eventType: event.event, sessionId: event.sessionId, observedAt: event.observedAt } :
    legacy ? { state: 'UNKNOWN', reasonCode: 'EVENT_DETAIL_UNAVAILABLE', freshness: 'HISTORICAL' } : { state: 'UNOBSERVED', reasonCode: 'NO_EVENT_OBSERVED', freshness: 'UNAVAILABLE' })
  let captureReadiness = { state: 'NOT_VERIFIED', reasonCode: 'CURRENT_CAPTURE_UNPROVEN' }
  const trustSatisfied = provider === 'antigravity'
    ? installation.state === 'CONFIGURED' && !!event?.capture && Date.parse(event.observedAt) >= nativeCaptureRuntimeStartedAt
    : installation.state === 'CONFIGURED' && trust.state === 'TRUSTED' && trust.freshness === 'OBSERVED_SNAPSHOT' &&
      !!trust.sessionId && !!trust.clientId && !!trust.connectedAt && !!trust.expiresAt && trust.installationDigest === installation.digest && !!event?.capture &&
      event.event !== 'SessionEnd' && event.sessionId === trust.sessionId && Date.parse(event.observedAt) >= Math.max(Date.parse(trust.connectedAt), nativeCaptureRuntimeStartedAt)
  if (trustSatisfied && event?.capture) {
    try {
      const bindingPath = join(root, provider === 'antigravity' ? '.code-awareness/native-hooks/antigravity/binding.json' : '.code-awareness/native-hooks/binding.json')
      const binding = readNativeBinding(bindingPath)
      const history = readNativeGapHistory(binding.spool)
      const currentSource = provider === 'antigravity' ? `NATIVE_CURRENT:antigravity:${target.worktreeId}:${target.generation}` : `NATIVE_CURRENT:${target.worktreeId}:${target.generation}`
      const current = JSON.parse(registry.source(currentSource)?.cursor ?? '{}')
      const boundary = registry.directEvidence({ kind: 'EXECUTION', id: 'native-window:' + event.capture.epoch }, 'NATIVE_CAPTURE_BOUNDARY')
      if (current.runtimeId === nativeCaptureRuntimeId && current.sessionId === event.sessionId && current.epoch === event.capture.epoch &&
        event.capture.configuration === nativeCaptureConfiguration(binding) && boundary.length === 2 &&
        boundary.some(edge => edge.to.kind === 'SESSION' && edge.to.id === nativeSessionEntityId({ provider }, event.sessionId)) &&
        boundary.some(edge => edge.to.kind === 'WORKTREE' && edge.to.id === target.worktreeId + ':' + target.generation) &&
        boundary.every(edge => edge.evidenceRef === JSON.stringify(event.capture))) {
        captureReadiness = history.revision === event.capture.gapRevision && !history.overflow ? { state: 'OBSERVED', reasonCode: 'CURRENT_WINDOW_INGESTED' } : { state: 'PARTIAL', reasonCode: 'CAPTURE_PARTIAL' }
      }
    } catch {}
  }
  return { schemaVersion: 1, ...target, installation,
    trust: authorization, execution, captureReadiness,
    nextEvidence: installation.repairability === 'REPAIRABLE' ? 'REQUEST_REPAIR_APPROVAL' : installation.state === 'MISSING' ? 'REQUEST_INSTALLATION_APPROVAL' : installation.state !== 'CONFIGURED' ? 'INSPECT_INSTALLATION_READ_ONLY' : execution.state === 'FAILED' ? 'INSPECT_FAILED_EVENT_READ_ONLY' :
      trust.state === 'UNTRUSTED' || trust.state === 'PARTIAL' ? 'REQUEST_CLIENT_AUTHORIZATION_REVIEW' : (provider === 'antigravity' || trust.state === 'TRUSTED') && execution.state === 'UNOBSERVED' ? 'OBSERVE_REAL_WORKFLOW_WITH_CONSENT' : 'REQUEST_CLIENT_INSPECTION' }
}
