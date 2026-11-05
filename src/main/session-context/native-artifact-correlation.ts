import type { PublicationProvenancePort } from '../../shared/types/publication-provenance-types'
import { publicationReceiptDigest } from '../../shared/types/publication-provenance-types'
import type { CheckpointRegistry, RegistryEntity } from './checkpoint-registry'
import { nativeDigest, type NativeHookBinding } from './native-hooks'
import { readNativeGapHistory } from './native-hook-diagnostics'
import type { NativeArtifactFact } from './native-artifact-facts'

interface RequestFact { action: 'PUBLISH' | 'UPDATE'; requestDigest: string; context: string; outcome: NativeArtifactFact['outcome']; receipt?: NativeArtifactFact['receipt'] }
export async function correlateNativeArtifact(registry: CheckpointRegistry, binding: NativeHookBinding, invocationId: string, port: PublicationProvenancePort, assertCurrent: () => void): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(invocationId) || registry.repositoryId !== binding.repositoryId) throw new Error('INVALID_NATIVE_CORRELATION')
  const invocation: RegistryEntity = { kind: 'EXECUTION', id: 'native-invocation:' + invocationId }, source = 'NATIVE_ARTIFACT:' + invocationId
  const reject = async (reason: string, state: 'UNAVAILABLE' | 'PARTIAL' | 'AMBIGUOUS' = 'UNAVAILABLE') => {
    assertCurrent()
    registry.apply({ repositoryId: binding.repositoryId, source, revision: nativeDigest(reason), status: 'CONFLICT', cursor: reason, edges: [] }, registry.source(source)?.revision, assertCurrent)
    await port.invalidate(invocationId, state)
    assertCurrent()
    return reason
  }
  const facts = registry.directEvidence(invocation, 'NATIVE_ARTIFACT_REQUEST')
  const scopes = registry.directEvidence(invocation, 'NATIVE_ARTIFACT_SCOPE')
  const pre = facts.filter(edge => edge.relation === 'PreToolUse'), post = facts.filter(edge => edge.relation === 'PostToolUse')
  if (pre.length > 1 || post.length > 1) return reject('INVOCATION_AMBIGUOUS', 'AMBIGUOUS')
  if (pre.length !== 1 || post.length !== 1) return reject('INVOCATION_INCOMPLETE', 'PARTIAL')
  if (pre[0].to.kind !== 'SESSION' || pre[0].to.id !== post[0].to.id || scopes.length !== 2 || scopes.some(edge => edge.to.id !== binding.worktreeId + ':' + binding.generation)) return reject('INVOCATION_AMBIGUOUS', 'AMBIGUOUS')
  const request = JSON.parse(pre[0].evidenceRef) as RequestFact, result = JSON.parse(post[0].evidenceRef) as RequestFact
  if (request.action !== result.action || request.requestDigest !== result.requestDigest || request.context !== result.context) return reject('INVOCATION_AMBIGUOUS', 'AMBIGUOUS')
  if (result.outcome !== 'SUCCESS' || !result.receipt) return reject('RESULT_UNCONFIRMED')
  if (result.receipt.replayed !== false) return reject('REPLAY_NOT_CAUSAL')
  const gaps = readNativeGapHistory(binding.spool)
  if (gaps.entries.some(entry => !gaps.acknowledgements.some(ack => ack.revision === entry.revision))) return reject('CAPTURE_PARTIAL', 'PARTIAL')
  let receipt
  try { receipt = await port.readReceipt(result.receipt.receiptId) } catch { return reject('RECEIPT_UNAVAILABLE') }
  assertCurrent()
  if (!receipt) return reject('RECEIPT_UNAVAILABLE')
  const { digest: receiptDigest, ...receiptBody } = receipt
  if (receiptDigest !== publicationReceiptDigest(receiptBody)) return reject('RECEIPT_MISMATCH')
  if (receipt.repositoryId !== registry.repositoryId || receipt.artifactId !== result.receipt.artifactId || receipt.revision !== result.receipt.revision || receipt.digest !== result.receipt.digest ||
    receipt.action !== request.action || receipt.requestDigest !== request.requestDigest) return reject('RECEIPT_MISMATCH')
  const revision = nativeDigest(JSON.stringify([pre[0].digest, post[0].digest, receipt.digest]))
  const sessionId = pre[0].to.id.slice('codex-native:'.length)
  const recorded = await port.associate({ repositoryId: registry.repositoryId, receiptId: receipt.receiptId, sessionId, invocationId, worktreeId: binding.worktreeId, generation: binding.generation, evidenceDigest: revision })
  assertCurrent()
  if (recorded.state !== 'VERIFIED') {
    for (const prior of recorded.conflictingInvocationIds) {
      const oldSource = 'NATIVE_ARTIFACT:' + prior
      registry.apply({ repositoryId: registry.repositoryId, source: oldSource, revision: nativeDigest('RECEIPT_AMBIGUOUS'), status: 'CONFLICT', cursor: 'RECEIPT_AMBIGUOUS', edges: [] }, registry.source(oldSource)?.revision, assertCurrent)
    }
    return reject('RECEIPT_AMBIGUOUS', 'AMBIGUOUS')
  }
  const artifact: RegistryEntity = { kind: 'ARTIFACT', id: receipt.artifactId + ':' + receipt.revision }
  const evidence = { evidenceKind: 'NATIVE_ARTIFACT_CAUSAL', evidenceRef: receipt.receiptId, digest: revision, freshness: 'EXACT_REVISION' }
  const batch = { repositoryId: registry.repositoryId, source, revision, status: 'COMPLETE', edges: [
    { from: pre[0].to, relation: 'invoked', to: invocation, ...evidence },
    { from: invocation, relation: receipt.action === 'PUBLISH' ? 'published' : 'updated', to: artifact, ...evidence },
    { from: { kind: 'ARTIFACT' as const, id: receipt.artifactId }, relation: 'revision', to: artifact, ...evidence }
  ] }
  if (registry.source(source)?.revision !== revision || registry.source(source)?.status !== 'COMPLETE') registry.apply(batch, registry.source(source)?.revision, assertCurrent)
  return 'VERIFIED'
}
