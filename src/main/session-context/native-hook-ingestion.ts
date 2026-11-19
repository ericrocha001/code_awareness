import { lstatSync, unlinkSync, type BigIntStats } from 'node:fs'
import { join } from 'node:path'
import type { CheckpointRegistry, RegistryBatch, RegistryEntity } from './checkpoint-registry'
import type { SessionTargetResolver } from './target'
import { boundedFile, nativeCaptureRuntimeId, nativeDigest, nativeGapReason, nativeGitIdentity, nativeHookLimits, nativeSessionEntityId, parseNativeEnvelope, recordNativeGap, spoolEventFiles, type NativeHookBinding, type NativeHookEnvelope } from './native-hooks'
import { persistNativeCapture } from './native-hook-diagnostics'

const fileIdentity = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`

export function nativeObservationBatch(event: NativeHookEnvelope): RegistryBatch {
  const session: RegistryEntity = { kind: 'SESSION', id: nativeSessionEntityId(event, event.sessionId) }
  const observation: RegistryEntity = { kind: 'EXECUTION', id: `native-observation:${event.eventId}` }
  const invocation: RegistryEntity | undefined = event.invocationId ? { kind: 'EXECUTION', id: `native-invocation:${event.invocationId}` } : undefined
  const evidence = { evidenceKind: 'NATIVE_HOOK_OBSERVED', evidenceRef: event.eventId, digest: event.digest, freshness: 'OBSERVED_SNAPSHOT' }
  return { repositoryId: event.repositoryId, source: `NATIVE_HOOK:${event.eventId}`, revision: event.digest, status: 'COMPLETE', cursor: JSON.stringify(event), entities: [session, observation], edges: [
    { from: observation, relation: event.event, to: session, ...evidence },
    { from: observation, relation: 'observed-in', to: { kind: 'WORKTREE', id: `${event.worktreeId}:${event.generation}` }, ...evidence },
    ...(invocation ? [{ from: observation, relation: 'invocation', to: invocation, ...evidence }] : []),
    ...(event.capture ? [{ from: observation, relation: 'captured-in', to: { kind: 'EXECUTION' as const, id: 'native-window:' + event.capture.epoch },
      ...evidence, evidenceKind: 'NATIVE_CAPTURE_MEMBERSHIP' }] : []),
    ...(event.capture && invocation ? [{ from: invocation, relation: event.event, to: { kind: 'EXECUTION' as const, id: 'native-window:' + event.capture.epoch },
      ...evidence, evidenceKind: 'NATIVE_CAPTURE_WINDOW', evidenceRef: JSON.stringify(event.capture) }] : []),
    ...(event.capture && event.event === 'SessionStart' ? [session, { kind: 'WORKTREE' as const, id: `${event.worktreeId}:${event.generation}` }].map(to => ({
      from: { kind: 'EXECUTION' as const, id: 'native-window:' + event.capture!.epoch }, relation: 'window-start', to,
      ...evidence, evidenceKind: 'NATIVE_CAPTURE_BOUNDARY', evidenceRef: JSON.stringify(event.capture)
    })) : []),
    ...(invocation && event.git ? [
      { from: invocation, relation: event.event, to: session, ...evidence, evidenceKind: 'NATIVE_GIT_REQUEST', evidenceRef: JSON.stringify(event.git) },
      { from: invocation, relation: event.event, to: session, ...evidence, evidenceKind: 'NATIVE_GIT_CONTEXT', evidenceRef: nativeDigest(JSON.stringify([event.sessionId, event.turnId ?? null, event.subagentId ?? null])) },
      { from: invocation, relation: 'scoped-to', to: { kind: 'WORKTREE' as const, id: `${event.worktreeId}:${event.generation}` }, ...evidence, evidenceKind: 'NATIVE_GIT_SCOPE' }
    ] : []),
    ...(invocation && event.artifact ? [
      { from: invocation, relation: event.event, to: session, ...evidence, evidenceKind: 'NATIVE_ARTIFACT_REQUEST',
        evidenceRef: JSON.stringify({ action: event.artifact.category === 'ARTIFACT_PUBLISH' ? 'PUBLISH' : 'UPDATE', requestDigest: event.artifact.requestDigest,
          outcome: event.artifact.outcome, context: nativeDigest(JSON.stringify([event.sessionId, event.turnId ?? null, event.subagentId ?? null, event.worktreeId, event.generation])),
          ...(event.artifact.receipt ? { receipt: event.artifact.receipt } : {}) }) },
      { from: invocation, relation: 'scoped-to', to: { kind: 'WORKTREE' as const, id: `${event.worktreeId}:${event.generation}` }, ...evidence, evidenceKind: 'NATIVE_ARTIFACT_SCOPE' }
    ] : [])
  ] }
}

function windowAttempt(registry: CheckpointRegistry, event: NativeHookEnvelope, outcome: 'accepted' | 'deduplicated' | 'expired' | 'rejected'): RegistryBatch[] {
  if (!event.capture) return []
  const source = 'NATIVE_WINDOW_METRICS:' + event.capture.epoch
  const previous = registry.source(source)
  const counters = JSON.parse(previous?.cursor ?? '{"ingress":0,"accepted":0,"deduplicated":0,"expired":0,"rejected":0}') as Record<string, number>
  counters.ingress++; counters[outcome]++
  const cursor = JSON.stringify(counters)
  return [{ repositoryId: registry.repositoryId, source, revision: nativeDigest(cursor), status: 'OBSERVED', cursor, edges: [] }]
}

export interface IngestNativeHooksOptions {
  maxEvents?: number
  deadlineMs?: number
  shouldStop?: () => boolean
}

export async function ingestNativeHooks(registry: CheckpointRegistry, binding: NativeHookBinding, resolveTarget: SessionTargetResolver,
  assertCurrent: () => void, now = Date.now(), onEvent?: (event: NativeHookEnvelope) => Promise<void>, options?: IngestNativeHooksOptions): Promise<{ state: 'DISABLED' | 'OBSERVED' | 'PARTIAL' | 'READY'; ingested: number; rejected: number; expired: number; deduplicated: number; pending: boolean; deferredByBudget?: boolean }> {
  const receipt = { state: 'READY' as 'DISABLED' | 'OBSERVED' | 'PARTIAL' | 'READY', ingested: 0, rejected: 0, expired: 0, deduplicated: 0, pending: false, deferredByBudget: false }
  const admitted: string[] = []
  if (!binding.enabled) return { ...receipt, state: 'DISABLED' }
  if (binding.repositoryId !== registry.repositoryId) throw new Error('REPOSITORY_MISMATCH')
  const target = await resolveTarget({ worktreeId: binding.worktreeId, generation: binding.generation })
  const identity = nativeGitIdentity(target.root)
  if (identity.root !== binding.root || identity.directoryIdentity !== binding.directoryIdentity || identity.commonDirectory !== binding.commonDirectory) throw new Error('WORKTREE_STALE')
  assertCurrent()
  const maxEvents = Math.max(1, Math.min(128, options?.maxEvents ?? 32))
  const files = spoolEventFiles(binding.spool)
  let attempted = 0
  let abortedByBudget = false
  if (files.length > 0) {
    await target.validate()
    for (const name of files.slice(0, maxEvents)) {
      if (options?.shouldStop?.() || (options?.deadlineMs !== undefined && Date.now() >= options.deadlineMs)) {
        abortedByBudget = true
        break
      }
      attempted++
      const path = join(binding.spool, name)
      let beforeId: string
      let rawText: string
      try {
        const beforeStat = lstatSync(path, { bigint: true })
        if (!beforeStat.isFile() || beforeStat.isSymbolicLink()) throw new Error('IO_FAILURE')
        beforeId = fileIdentity(beforeStat)
        rawText = boundedFile(path, nativeHookLimits.envelopeBytes)
        const afterStat = lstatSync(path, { bigint: true })
        if (fileIdentity(afterStat) !== beforeId) continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        recordNativeGap(binding.spool, nativeGapReason(error), 'INGEST'); receipt.rejected++; continue
      }
      let event: NativeHookEnvelope
      try { event = parseNativeEnvelope(rawText) }
      catch (error) { recordNativeGap(binding.spool, error instanceof SyntaxError ? 'JSON_SYNTAX' : nativeGapReason(error), 'INGEST'); receipt.rejected++; continue }
      if (event.repositoryId !== binding.repositoryId || event.worktreeId !== binding.worktreeId || event.generation !== binding.generation) { recordNativeGap(binding.spool, 'WORKTREE_MISMATCH', 'INGEST', event.event); receipt.rejected++; continue }
      if (Date.parse(event.observedAt) > now + 60000) { recordNativeGap(binding.spool, 'EVENT_TIME_INVALID', 'INGEST', event.event); registry.applyAll(windowAttempt(registry, event, 'rejected'), assertCurrent); receipt.rejected++; continue }
      if (now - Date.parse(event.observedAt) > nativeHookLimits.retentionMs) {
        recordNativeGap(binding.spool, 'EVENT_EXPIRED', 'INGEST', event.event)
        registry.applyAll(windowAttempt(registry, event, 'expired'), assertCurrent)
        receipt.expired++
        try {
          const unlinkStat = lstatSync(path, { bigint: true })
          if (fileIdentity(unlinkStat) === beforeId) unlinkSync(path)
        } catch {}
        continue
      }
      if (nativeGitIdentity(binding.root).directoryIdentity !== binding.directoryIdentity) throw new Error('WORKTREE_STALE')
      assertCurrent()
      const batch = nativeObservationBatch(event)
      const existing = registry.source(batch.source)
      registry.applyAll([...(existing ? [] : [batch]), ...windowAttempt(registry, event, existing ? 'deduplicated' : 'accepted')], assertCurrent)
      if (!existing) admitted.push(batch.revision)
      else receipt.deduplicated++
      await onEvent?.(event)
      const currentSource = binding.provider === 'antigravity' ? `NATIVE_CURRENT:antigravity:${binding.worktreeId}:${binding.generation}` : `NATIVE_CURRENT:${binding.worktreeId}:${binding.generation}`
      const cursor = JSON.stringify({ runtimeId: nativeCaptureRuntimeId, eventId: event.eventId, sessionId: event.sessionId, epoch: event.capture?.epoch })
      if (!existing) registry.apply({ repositoryId: binding.repositoryId, source: currentSource, revision: nativeDigest(cursor), status: 'OBSERVED', cursor, edges: [] }, registry.source(currentSource)?.revision, assertCurrent)
      try {
        const unlinkStat = lstatSync(path, { bigint: true })
        if (fileIdentity(unlinkStat) === beforeId) unlinkSync(path)
      } catch {}
      receipt.ingested++
    }
  }
  receipt.pending = files.length > attempted
  receipt.deferredByBudget = abortedByBudget
  const diagnostics = persistNativeCapture(registry, binding, receipt, assertCurrent)
  receipt.state = receipt.rejected || receipt.expired || receipt.pending || diagnostics.historicalCoverage.state === 'PARTIAL' ? 'PARTIAL' : receipt.ingested ? 'OBSERVED' : 'READY'
  const source = 'NATIVE_HOOK', previous = registry.source(source)
  if (admitted.length || receipt.state === 'PARTIAL' && previous?.status !== 'PARTIAL') {
    const revision = nativeDigest(JSON.stringify([previous?.revision, binding.worktreeId, admitted, receipt.state]))
    registry.apply({ repositoryId: binding.repositoryId, source, revision, status: receipt.state, edges: [] }, previous?.revision, assertCurrent)
  }
  return receipt
}
