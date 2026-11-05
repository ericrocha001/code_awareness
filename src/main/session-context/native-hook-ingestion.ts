import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckpointRegistry, RegistryBatch, RegistryEntity } from './checkpoint-registry'
import type { SessionTargetResolver } from './target'
import { boundedFile, nativeDigest, nativeGitIdentity, nativeHookLimits, parseNativeEnvelope, type NativeHookBinding, type NativeHookEnvelope } from './native-hooks'

export function nativeObservationBatch(event: NativeHookEnvelope): RegistryBatch {
  const session: RegistryEntity = { kind: 'SESSION', id: `codex-native:${event.sessionId}` }
  const observation: RegistryEntity = { kind: 'EXECUTION', id: `native-observation:${event.eventId}` }
  const invocation: RegistryEntity | undefined = event.invocationId ? { kind: 'EXECUTION', id: `native-invocation:${event.invocationId}` } : undefined
  const evidence = { evidenceKind: 'NATIVE_HOOK_OBSERVED', evidenceRef: event.eventId, digest: event.digest, freshness: 'OBSERVED_SNAPSHOT' }
  return { repositoryId: event.repositoryId, source: `NATIVE_HOOK:${event.eventId}`, revision: event.digest, status: 'COMPLETE', entities: [session, observation], edges: [
    { from: observation, relation: event.event, to: session, ...evidence },
    { from: observation, relation: 'observed-in', to: { kind: 'WORKTREE', id: `${event.worktreeId}:${event.generation}` }, ...evidence },
    ...(invocation ? [{ from: observation, relation: 'invocation', to: invocation, ...evidence }] : []),
    ...(invocation && event.git ? [
      { from: invocation, relation: event.event, to: session, ...evidence, evidenceKind: 'NATIVE_GIT_REQUEST', evidenceRef: JSON.stringify(event.git) },
      { from: invocation, relation: 'scoped-to', to: { kind: 'WORKTREE' as const, id: `${event.worktreeId}:${event.generation}` }, ...evidence, evidenceKind: 'NATIVE_GIT_SCOPE' }
    ] : [])
  ] }
}

export async function ingestNativeHooks(registry: CheckpointRegistry, binding: NativeHookBinding, resolveTarget: SessionTargetResolver,
  assertCurrent: () => void, now = Date.now(), onEvent?: (event: NativeHookEnvelope) => Promise<void>): Promise<{ state: 'DISABLED' | 'OBSERVED' | 'PARTIAL' | 'READY'; ingested: number; rejected: number; expired: number; pending: boolean }> {
  const receipt = { state: 'READY' as 'DISABLED' | 'OBSERVED' | 'PARTIAL' | 'READY', ingested: 0, rejected: 0, expired: 0, pending: false }
  const admitted: string[] = []
  if (!binding.enabled) return { ...receipt, state: 'DISABLED' }
  if (binding.repositoryId !== registry.repositoryId) throw new Error('REPOSITORY_MISMATCH')
  const target = await resolveTarget({ worktreeId: binding.worktreeId, generation: binding.generation })
  const identity = nativeGitIdentity(target.root)
  if (identity.root !== binding.root || identity.directoryIdentity !== binding.directoryIdentity || identity.commonDirectory !== binding.commonDirectory) throw new Error('WORKTREE_STALE')
  assertCurrent()
  const files = readdirSync(binding.spool).filter(name => /^(?:[0-9]{1,3}|10[01][0-9]|102[0-3])\.json$/.test(name)).sort()
  receipt.pending = files.length > 32
  await target.validate()
  for (const name of files.slice(0, 32)) {
    const path = join(binding.spool, name)
    let event: NativeHookEnvelope
    try { event = parseNativeEnvelope(boundedFile(path, nativeHookLimits.envelopeBytes)) }
    catch { receipt.rejected++; continue }
    if (event.repositoryId !== binding.repositoryId || event.worktreeId !== binding.worktreeId || event.generation !== binding.generation || Date.parse(event.observedAt) > now + 60000) { receipt.rejected++; continue }
    if (now - Date.parse(event.observedAt) > nativeHookLimits.retentionMs) { receipt.expired++; unlinkSync(path); continue }
    if (nativeGitIdentity(binding.root).directoryIdentity !== binding.directoryIdentity) throw new Error('WORKTREE_STALE')
    assertCurrent()
    const batch = nativeObservationBatch(event)
    const existing = registry.source(batch.source)
    if (!existing) { registry.apply(batch, undefined, assertCurrent); admitted.push(batch.revision) }
    await onEvent?.(event)
    unlinkSync(path)
    receipt.ingested++
  }
  receipt.state = receipt.rejected || receipt.expired || receipt.pending || existsSync(join(binding.spool, 'gap.json')) ? 'PARTIAL' : receipt.ingested ? 'OBSERVED' : 'READY'
  const source = 'NATIVE_HOOK', previous = registry.source(source)
  if (admitted.length || receipt.state === 'PARTIAL' && previous?.status !== 'PARTIAL') {
    const revision = nativeDigest(JSON.stringify([previous?.revision, binding.worktreeId, admitted, receipt.state]))
    registry.apply({ repositoryId: binding.repositoryId, source, revision, status: receipt.state, edges: [] }, previous?.revision, assertCurrent)
  }
  return receipt
}
