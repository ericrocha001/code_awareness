import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { inspectNativeInstallation, inspectSharedNativeInstallation } from './native-hook-installation'
import {
  inspectUserHookInstallation,
  resolveRuntimeHelperExpectation,
  type CapturedRuntimeHelperState,
  type HelperBundleKind,
  type RuntimeHelperBundleOptions
} from './native-hook-profile'
import { openNativeHookCatalog, readNativeEnrollment, readUserHookProfile } from './native-hook-catalog'
import type { CheckpointRegistry } from './checkpoint-registry'
import { unknownNativeTrust, type NativeTrustObservation } from './native-hook-preflight'
import { nativeCaptureConfiguration } from './native-capture-window'
import { nativeBindingPath, nativeCaptureRuntimeId, nativeCaptureRuntimeStartedAt, nativeHookSource, nativeSessionEntityId, readNativeBinding, type NativeHookProvider } from './native-hooks'
import { readNativeGapHistory } from './native-hook-diagnostics'

export interface NativeHelperVersionStatus {
  state: 'CURRENT' | 'STALE' | 'UNKNOWN' | 'NOT_INSTALLED'
  reasonCode: string
  installedDigest?: string
  expectedDigest?: string
  sourceScope?: 'USER' | 'CHECKOUT' | 'NONE'
  helperKind?: HelperBundleKind
  nextAction?: string
}

function resolveHelperVersionStatus(
  installation: { state: 'CONFIGURED' | 'MISSING' | 'INCOMPATIBLE' | 'UNKNOWN'; reasonCode: string; scope?: 'USER' | 'CHECKOUT'; helperDigest?: string; helperKind?: HelperBundleKind },
  options?: { runtimeHelper?: CapturedRuntimeHelperState; runtimeHelperOptions?: RuntimeHelperBundleOptions }
): NativeHelperVersionStatus {
  if (installation.state === 'MISSING') {
    const expectation = options?.runtimeHelper || options?.runtimeHelperOptions
      ? resolveRuntimeHelperExpectation('PORTABLE', options?.runtimeHelper, options?.runtimeHelperOptions)
      : undefined
    if (expectation?.state === 'RUNTIME_SOURCE_STALE') {
      return {
        state: 'UNKNOWN',
        reasonCode: 'RUNTIME_SOURCE_STALE',
        sourceScope: 'NONE',
        nextAction: 'RESTART_CODE_AWARENESS_RUNTIME'
      }
    }
    return {
      state: 'NOT_INSTALLED',
      reasonCode: 'HOOK_HELPER_NOT_INSTALLED',
      ...(expectation?.expectedDigest ? { expectedDigest: expectation.expectedDigest } : {}),
      sourceScope: 'NONE',
      nextAction: 'INSTALL_NATIVE_HOOKS'
    }
  }
  if (installation.state !== 'CONFIGURED') {
    return {
      state: 'UNKNOWN',
      reasonCode: installation.reasonCode,
      ...(installation.helperDigest ? { installedDigest: installation.helperDigest } : {}),
      ...(installation.scope ? { sourceScope: installation.scope } : {}),
      ...(installation.helperKind ? { helperKind: installation.helperKind } : {})
    }
  }
  const kind: HelperBundleKind = installation.helperKind ?? 'PORTABLE'
  const expectation = resolveRuntimeHelperExpectation(kind, options?.runtimeHelper, options?.runtimeHelperOptions)
  if (expectation.state === 'RUNTIME_SOURCE_STALE') {
    return {
      state: 'UNKNOWN',
      reasonCode: 'RUNTIME_SOURCE_STALE',
      ...(installation.helperDigest ? { installedDigest: installation.helperDigest } : {}),
      ...(installation.scope ? { sourceScope: installation.scope } : {}),
      helperKind: kind,
      nextAction: 'RESTART_CODE_AWARENESS_RUNTIME'
    }
  }
  if (expectation.state !== 'AVAILABLE' || !expectation.expectedDigest || !installation.helperDigest) {
    return {
      state: 'UNKNOWN',
      reasonCode: 'HOOK_HELPER_UNAVAILABLE',
      ...(installation.helperDigest ? { installedDigest: installation.helperDigest } : {}),
      ...(installation.scope ? { sourceScope: installation.scope } : {}),
      helperKind: kind,
      nextAction: 'VERIFY_RUNTIME_HELPER_BUNDLE'
    }
  }
  if (installation.helperDigest === expectation.expectedDigest) {
    return {
      state: 'CURRENT',
      reasonCode: 'HELPER_VERSION_CURRENT',
      installedDigest: installation.helperDigest,
      expectedDigest: expectation.expectedDigest,
      ...(installation.scope ? { sourceScope: installation.scope } : {}),
      helperKind: kind
    }
  }
  return {
    state: 'STALE',
    reasonCode: 'HOOK_HELPER_STALE',
    installedDigest: installation.helperDigest,
    expectedDigest: expectation.expectedDigest,
    ...(installation.scope ? { sourceScope: installation.scope } : {}),
    helperKind: kind,
    nextAction: 'REINSTALL_NATIVE_HOOKS'
  }
}

export function nativeHookReadiness(
  registry: CheckpointRegistry,
  root: string,
  target: { worktreeId: string; generation: string },
  trust: NativeTrustObservation = unknownNativeTrust('TRUST_NOT_INSPECTED'),
  provider: NativeHookProvider = 'codex',
  options?: { profile?: string; codexHome?: string; runtimeHelper?: CapturedRuntimeHelperState; runtimeHelperOptions?: RuntimeHelperBundleOptions }
) {
  let { handlers: _handlers, helperPath: _helperPath, ...installation } = inspectNativeInstallation(root, { repositoryId: registry.repositoryId, ...target }, process.platform, provider)
  let bootstrap: { state: 'AVAILABLE' | 'UNAVAILABLE'; reasonCode: string } | undefined
  let userProfileConfigured = false
  if ((provider === 'codex' || provider === 'antigravity') && options?.profile) {
    try {
      const userInstall = inspectUserHookInstallation(options.profile, provider, options.codexHome, process.platform)
      userProfileConfigured = userInstall.state === 'CONFIGURED'
      const db = openNativeHookCatalog(options.profile, true)
      try {
        const profileRow = readUserHookProfile(db, provider)
        const enrollment = readNativeEnrollment(db, registry.repositoryId, provider)
        if (profileRow?.enabled && userProfileConfigured && enrollment?.externalPreparation) {
          bootstrap = { state: 'AVAILABLE', reasonCode: 'USER_BOOTSTRAP_AVAILABLE' }
          if (installation.state === 'MISSING') {
            installation = {
              state: 'CONFIGURED',
              reasonCode: 'USER_PROFILE_READY_BINDING_PENDING',
              digest: userInstall.digest,
              installed: userInstall.installed,
              expected: userInstall.expected,
              scope: 'USER',
              helperKind: 'PORTABLE',
              helperDigest: userInstall.helperDigest
            }
          }
        } else if (profileRow?.enabled && !userProfileConfigured) {
          bootstrap = { state: 'UNAVAILABLE', reasonCode: userInstall.reasonCode }
          if (installation.state === 'MISSING') {
            const { handlers: _u, helperPath: _uh, ...userRest } = userInstall
            installation = { ...userRest, scope: 'USER', helperKind: 'PORTABLE' }
          }
        } else {
          bootstrap = { state: 'UNAVAILABLE', reasonCode: profileRow?.enabled ? 'HOOK_ENROLLMENT_REQUIRED' : 'NATIVE_CONFIG_MISSING' }
        }
      } finally { db.close() }
    } catch {}
  }

  const helperVersion = resolveHelperVersionStatus(installation, options)

  if (trust.expiresAt && Date.parse(trust.expiresAt) <= Date.now()) trust = unknownNativeTrust('TRUST_EXPIRED')
  if (trust.installationDigest && trust.installationDigest !== installation.digest) trust = unknownNativeTrust('HOOK_CONFIG_DRIFT')
  if (trust.loadedSource === 'MAIN' && (!trust.sharedSourceDigest ||
    inspectSharedNativeInstallation(root, { repositoryId: registry.repositoryId, ...target })?.digest !== trust.sharedSourceDigest)) trust = unknownNativeTrust('HOOK_CONFIG_DRIFT')
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
  let captureReadiness = helperVersion.state === 'STALE'
    ? { state: 'NOT_VERIFIED', reasonCode: 'HOOK_HELPER_STALE' }
    : helperVersion.reasonCode === 'RUNTIME_SOURCE_STALE'
      ? { state: 'NOT_VERIFIED', reasonCode: 'RUNTIME_SOURCE_STALE' }
      : { state: 'NOT_VERIFIED', reasonCode: 'CURRENT_CAPTURE_UNPROVEN' }
  const helperExecutionMatches = !helperVersion.expectedDigest || !event?.helperDigest || event.helperDigest === helperVersion.expectedDigest
  const helperAllowedForCurrentCapture = helperVersion.state !== 'STALE' && helperVersion.reasonCode !== 'RUNTIME_SOURCE_STALE'
  const trustSatisfied = helperAllowedForCurrentCapture && helperExecutionMatches && (provider === 'antigravity'
    ? installation.state === 'CONFIGURED' && !!event?.capture && Date.parse(event.observedAt) >= nativeCaptureRuntimeStartedAt
    : installation.state === 'CONFIGURED' && trust.state === 'TRUSTED' && trust.freshness === 'OBSERVED_SNAPSHOT' &&
      !!trust.sessionId && !!trust.clientId && !!trust.connectedAt && !!trust.expiresAt && trust.installationDigest === installation.digest && !!event?.capture &&
      event.event !== 'SessionEnd' && event.sessionId === trust.sessionId && Date.parse(event.observedAt) >= Math.max(Date.parse(trust.connectedAt), nativeCaptureRuntimeStartedAt))
  if (trustSatisfied && event?.capture) {
    try {
      const bindingPath = nativeBindingPath(root, provider)
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
  const bindingPresent = existsSync(nativeBindingPath(root, provider))
  return {
    schemaVersion: 1, ...target, installation, helperVersion,
    ...(bootstrap ? { bootstrap, bindingState: bindingPresent ? 'PRESENT' : 'PENDING_FIRST_SESSION' } : {}),
    trust: authorization, execution, captureReadiness,
    nextEvidence: helperVersion.reasonCode === 'RUNTIME_SOURCE_STALE' ? 'RESTART_RUNTIME_TO_RELOAD_HELPER_BUNDLE'
      : helperVersion.state === 'STALE' ? 'REINSTALL_HELPER_AND_RELOAD_CLIENT'
      : installation.repairability === 'REPAIRABLE' ? 'REQUEST_REPAIR_APPROVAL'
      : bootstrap?.state === 'UNAVAILABLE' && bootstrap.reasonCode === 'HOOK_ENROLLMENT_REQUIRED' ? 'ENROLL_REPOSITORY_FOR_NATIVE_HOOKS'
      : installation.state === 'MISSING' ? 'REQUEST_INSTALLATION_APPROVAL'
      : installation.state !== 'CONFIGURED' ? 'INSPECT_INSTALLATION_READ_ONLY'
      : execution.state === 'FAILED' ? 'INSPECT_FAILED_EVENT_READ_ONLY'
      : trust.state === 'UNTRUSTED' || trust.state === 'PARTIAL' ? 'REQUEST_CLIENT_AUTHORIZATION_REVIEW'
      : (provider === 'antigravity' || trust.state === 'TRUSTED') && (execution.state === 'UNOBSERVED' || captureReadiness.state === 'NOT_VERIFIED') ? 'OBSERVE_REAL_WORKFLOW_WITH_CONSENT'
      : 'REQUEST_CLIENT_INSPECTION'
  }
}
