import type { GitService } from '../core/git-service'
import type { CheckpointRegistry, RegistryBatch, RegistryEntity } from './checkpoint-registry'
import { decodeGitReceiptResult } from '../git-operations/git-operation-receipts'
import { nativeDigest, type NativeHookBinding, type NativeHookEnvelope } from './native-hooks'

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
  if (pre.length > 1 || post.length > 1) return unverified('INVOCATION_AMBIGUOUS')
  if (pre.length !== 1 || post.length !== 1) return unverified('INVOCATION_INCOMPLETE')
  if (pre[0].to.kind !== 'SESSION' || pre[0].to.id !== post[0].to.id || scopes.length !== 2 || scopes.some(edge => edge.to.id !== `${binding.worktreeId}:${binding.generation}`)) return unverified('INVOCATION_AMBIGUOUS')
  const request = JSON.parse(pre[0].evidenceRef) as NonNullable<NativeHookEnvelope['git']>
  const result = JSON.parse(post[0].evidenceRef) as NonNullable<NativeHookEnvelope['git']>
  if (request.operationId !== result.operationId || request.fingerprint !== result.fingerprint || request.expectedHead !== result.expectedHead || !result.sha || result.parent !== result.expectedHead) return unverified('RESULT_UNCONFIRMED')
  if (result.replayed !== false) return unverified('REPLAY_NOT_AUTHORSHIP')
  let observed: Awaited<ReturnType<GitService['readOperationReceipt']>>
  try { observed = await git.readOperationReceipt(binding.root, request.operationId) } catch { return unverified('RECEIPT_UNAVAILABLE') }
  assertCurrent()
  if (!observed || observed.receipt.status !== 'COMPLETED' || observed.receipt.operation !== 'commit_git_changes' || observed.receipt.argumentFingerprint !== request.fingerprint || !observed.receipt.result) return unverified('RECEIPT_UNVERIFIED')
  const receipt = decodeGitReceiptResult(observed.receipt.result)
  if (receipt.isError || receipt.value.sha !== result.sha || receipt.value.parent !== request.expectedHead) return unverified('RECEIPT_MISMATCH')
  const commits = await git.getCommitOperationObjects(binding.root, [result.sha])
  assertCurrent()
  const commit = commits.find(commit => commit.sha === result.sha)
  if (!commit || (request.expectedHead === null ? commit.parents.length !== 0 : commit.parents.length !== 1 || commit.parents[0] !== request.expectedHead)) return unverified('GIT_OBJECT_UNVERIFIED')
  const source = `NATIVE_GIT:${invocationId}`, revision = nativeDigest(JSON.stringify([pre[0].digest, post[0].digest, observed.sha, result.sha]))
  const batch: RegistryBatch = { repositoryId: binding.repositoryId, source, revision, status: 'COMPLETE', edges: [
    { from: pre[0].to, relation: 'invoked', to: invocation, evidenceKind: 'NATIVE_GIT_CAUSAL', evidenceRef: observed.sha, digest: revision, freshness: 'OBSERVED_SNAPSHOT' },
    { from: invocation, relation: 'committed', to: { kind: 'COMMIT', id: result.sha }, evidenceKind: 'NATIVE_GIT_CAUSAL', evidenceRef: observed.sha, digest: revision, freshness: 'OBSERVED_SNAPSHOT' }
  ] }
  const previous = registry.source(source)
  if (previous?.revision !== revision || previous.status !== 'COMPLETE') registry.apply(batch, previous?.revision, assertCurrent)
  return 'VERIFIED'
}
