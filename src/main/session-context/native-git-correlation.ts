import type { GitService } from '../core/git-service'
import type { CheckpointRegistry, RegistryBatch, RegistryEntity } from './checkpoint-registry'
import { decodeGitReceiptResult } from '../git-operations/git-operation-receipts'
import { nativeDigest, parseNativeEnvelope, type NativeHookBinding, type NativeHookEnvelope } from './native-hooks'
import { nativeInvocationWindow } from './native-capture-window'

function verifiedAntigravityEnvelopes(registry: CheckpointRegistry, invocation: RegistryEntity, sessionId: string): boolean {
  const obs = registry.directEvidence(invocation, 'NATIVE_HOOK_OBSERVED')
  const rawSession = sessionId.slice('antigravity-native:'.length)
  const preObs = obs.find(edge => edge.relation === 'invocation')
  if (!preObs || obs.length === 0) return false
  const sessionObs = registry.directEvidence({ kind: 'SESSION', id: sessionId }, 'NATIVE_HOOK_OBSERVED')
  const preEnvRaw = sessionObs.filter(e => e.relation === 'PreToolUse').map(e => registry.source('NATIVE_HOOK:' + e.evidenceRef)?.cursor).filter(Boolean)
  const postEnvRaw = sessionObs.filter(e => e.relation === 'PostToolUse').map(e => registry.source('NATIVE_HOOK:' + e.evidenceRef)?.cursor).filter(Boolean)
  const match = (raw: string | undefined) => {
    if (!raw) return false
    try {
      const env = parseNativeEnvelope(raw)
      return env.source === 'ANTIGRAVITY_NATIVE_HOOK' && env.invocationId &&
        obs.some(e => e.evidenceRef === env.eventId) &&
        env.producerWitness?.verifiedBy === 'MANAGED_RUNTIME' &&
        env.producerWitness.sessionId === rawSession
    } catch { return false }
  }
  return preEnvRaw.some(raw => match(raw)) && postEnvRaw.some(raw => match(raw))
}

export async function correlateNativeGit(registry: CheckpointRegistry, binding: NativeHookBinding, invocationId: string,
  git: Pick<GitService, 'readOperationReceipt' | 'getCommitOperationObjects'>, assertCurrent: () => void): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(invocationId) || registry.repositoryId !== binding.repositoryId) throw new Error('INVALID_NATIVE_CORRELATION')
  const invocation: RegistryEntity = { kind: 'EXECUTION', id: `native-invocation:${invocationId}` }
  const edges = registry.directEvidence(invocation, 'NATIVE_GIT_REQUEST')
  const scopes = registry.directEvidence(invocation, 'NATIVE_GIT_SCOPE')
  const pre = edges.filter(edge => edge.relation === 'PreToolUse'), post = edges.filter(edge => edge.relation === 'PostToolUse')
  const unverified = (reason: string) => {
    const source = `NATIVE_GIT:${invocationId}`
    registry.apply({ repositoryId: binding.repositoryId, source, revision: nativeDigest(reason), status: 'CONFLICT', cursor: reason, edges: [] }, registry.source(source)?.revision, assertCurrent)
    return reason
  }
  const hookObs = registry.directEvidence(invocation, 'NATIVE_HOOK_OBSERVED')
  const isAntigravityHook = binding.provider === 'antigravity' || hookObs.some(e => {
    const c = registry.source('NATIVE_HOOK:' + e.evidenceRef)?.cursor
    return typeof c === 'string' && c.includes('"ANTIGRAVITY_NATIVE_HOOK"')
  })
  if (isAntigravityHook && pre.length === 0 && post.length === 0) return unverified('ANTIGRAVITY_CAUSAL_UNSUPPORTED')
  if (pre.length > 1 || post.length > 1) return unverified('INVOCATION_AMBIGUOUS')
  if (pre.length !== 1 || post.length !== 1) return unverified('INVOCATION_INCOMPLETE')
  const sessionEntity = pre[0].to
  const isCodex = sessionEntity.id.startsWith('codex-native:')
  const isAntigravity = sessionEntity.id.startsWith('antigravity-native:')
  if (sessionEntity.kind !== 'SESSION' || (!isCodex && !isAntigravity) || sessionEntity.id !== post[0].to.id || scopes.length !== 2 || scopes.some(edge => edge.to.id !== `${binding.worktreeId}:${binding.generation}`)) return unverified('INVOCATION_AMBIGUOUS')
  if (isAntigravity && !verifiedAntigravityEnvelopes(registry, invocation, sessionEntity.id)) return unverified('ANTIGRAVITY_CAUSAL_UNVERIFIABLE')
  const contexts = registry.directEvidence(invocation, 'NATIVE_GIT_CONTEXT')
  if (contexts.length !== 2 || contexts[0].evidenceRef !== contexts[1].evidenceRef) return unverified('INVOCATION_AMBIGUOUS')
  const request = JSON.parse(pre[0].evidenceRef) as NonNullable<NativeHookEnvelope['git']>
  const result = JSON.parse(post[0].evidenceRef) as NonNullable<NativeHookEnvelope['git']>
  if (request.operationId !== result.operationId || request.fingerprint !== result.fingerprint || request.expectedHead !== result.expectedHead || !result.sha || result.parent !== result.expectedHead) return unverified('RESULT_UNCONFIRMED')
  if (result.replayed !== false) return unverified('REPLAY_NOT_AUTHORSHIP')
  const window = () => nativeInvocationWindow(registry, binding, invocation, sessionEntity)
  let integrity = window()
  if (integrity !== 'VERIFIED') return unverified(integrity)
  let observed: Awaited<ReturnType<GitService['readOperationReceipt']>>
  try { observed = await git.readOperationReceipt(binding.root, request.operationId) } catch { return unverified('RECEIPT_UNAVAILABLE') }
  assertCurrent()
  if (!observed || observed.receipt.status !== 'COMPLETED' || observed.receipt.operation !== 'commit_git_changes' || observed.receipt.argumentFingerprint !== request.fingerprint || !observed.receipt.result) return unverified('RECEIPT_UNVERIFIED')
  const receipt = decodeGitReceiptResult(observed.receipt.result)
  if (receipt.isError || receipt.value.sha !== result.sha || receipt.value.parent !== request.expectedHead) return unverified('RECEIPT_MISMATCH')
  if (observed.receipt.deliveryContext) {
    const dc = observed.receipt.deliveryContext as { repositoryId?: string; snapshot?: { worktreeId?: string; worktreeGeneration?: string } }
    if (dc.repositoryId !== registry.repositoryId || (dc.snapshot && (dc.snapshot.worktreeId !== binding.worktreeId || dc.snapshot.worktreeGeneration !== binding.generation))) return unverified('DELIVERY_CONTEXT_CONFLICT')
  }
  if (isAntigravity) {
    const sw = observed.receipt.sessionWitness
    const rawSession = sessionEntity.id.slice('antigravity-native:'.length)
    const hashed = sw?.sessionId ? nativeDigest(JSON.stringify([registry.repositoryId, 'antigravity', sw.sessionId])) : undefined
    const idMatches = sw?.provider === 'antigravity' && (sw.sessionId === rawSession || hashed === rawSession) &&
      (!sw.invocationId || nativeDigest(JSON.stringify([rawSession, 'tool_call_id', sw.invocationId])) === invocationId || sw.invocationId === invocationId)
    if (!idMatches) return unverified('ANTIGRAVITY_CAUSAL_UNVERIFIABLE')
  }
  const commits = await git.getCommitOperationObjects(binding.root, [result.sha])
  assertCurrent()
  const commit = commits.find(commit => commit.sha === result.sha)
  if (!commit || (request.expectedHead === null ? commit.parents.length !== 0 : commit.parents.length !== 1 || commit.parents[0] !== request.expectedHead)) return unverified('GIT_OBJECT_UNVERIFIED')
  integrity = window()
  if (integrity !== 'VERIFIED') return unverified(integrity)
  const source = `NATIVE_GIT:${invocationId}`, revision = nativeDigest(JSON.stringify([pre[0].digest, post[0].digest, observed.sha, result.sha]))
  const batch: RegistryBatch = { repositoryId: binding.repositoryId, source, revision, status: 'COMPLETE', edges: [
    { from: sessionEntity, relation: 'invoked', to: invocation, evidenceKind: 'NATIVE_GIT_CAUSAL', evidenceRef: observed.sha, digest: revision, freshness: 'OBSERVED_SNAPSHOT' },
    { from: invocation, relation: 'committed', to: { kind: 'COMMIT', id: result.sha }, evidenceKind: 'NATIVE_GIT_CAUSAL', evidenceRef: observed.sha, digest: revision, freshness: 'OBSERVED_SNAPSHOT' }
  ] }
  const previous = registry.source(source)
  if (previous?.revision !== revision || previous.status !== 'COMPLETE') registry.apply(batch, previous?.revision, assertCurrent)
  return 'VERIFIED'
}
