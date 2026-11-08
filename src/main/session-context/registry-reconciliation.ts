import type { SessionStore } from './store'
import type { CommandRunner } from './entire-provider'
import { observeCheckpoint } from './checkpoint-observation'
import { resolveCheckpointFromCommit } from './checkpoint'
import { digest } from './privacy'
import { sessionIdentity } from './session-identity'
import type { RegistryBatch, RegistryEntity, RegistryReader } from './checkpoint-registry'
import type { CaptureHealthObservation } from './capture-health-types'

export function registrySelector(query: { artifactId?: string; commitSha?: string; pullRequest?: number; executionId?: string; checkpointId?: string; sessionId?: string }): RegistryEntity | undefined {
  if (query.artifactId) return { kind: 'ARTIFACT', id: query.artifactId }
  if (query.commitSha) return { kind: 'COMMIT', id: query.commitSha }
  if (query.pullRequest) return { kind: 'PR', id: String(query.pullRequest) }
  if (query.executionId) return { kind: 'EXECUTION', id: query.executionId }
  if (query.checkpointId) return { kind: 'CHECKPOINT', id: query.checkpointId }
  if (query.sessionId) return { kind: 'SESSION', id: query.sessionId }
}
export async function reconcileRegistry(store: SessionStore, runner: CommandRunner, root: string, selector: RegistryEntity | undefined,
  assertCurrent: () => void, read?: RegistryReader, capture?: CaptureHealthObservation) {
  const registry = store.registry
  if (read) await reconcileRegistry(store, runner, root, selector, assertCurrent, undefined, capture)
  registry.legacy(assertCurrent)
  const apply = (batch: RegistryBatch) => registry.apply(batch, registry.source(batch.source)?.revision, assertCurrent)
  if (capture?.capture.providerSessionId && capture.capture.state === 'OBSERVED') {
    const from: RegistryEntity = { kind: 'WORKTREE', id: `${capture.worktreeId}:${capture.generation}` }
    apply({ repositoryId: store.repositoryId, source: `CAPTURE:${from.id}`, revision: capture.sourceFingerprint + ':' + capture.policyDigest + ':' + capture.capture.providerSessionId, status: 'COMPLETE',
      edges: [{ from, relation: 'observed-session', to: { kind: 'SESSION', id: sessionIdentity('entire', capture.capture.providerSessionId, capture.capture.agent) }, evidenceKind: 'PROVIDER_OBSERVED', evidenceRef: capture.configurationDigest,
        digest: digest(JSON.stringify(capture.capture)), freshness: 'OBSERVED_SNAPSHOT' }] })
  }
  let batches: RegistryBatch[] = []
  let refreshPullRequests: RegistryEntity[] | undefined
  if (read) {
    const pending = !selector ? registry.pendingReconciliation('PR', 2) : []
    if (!selector && !pending.length) refreshPullRequests = registry.reconciliationPullRequests(registry.source('GITHUB_REFRESH')?.cursor ?? '')
    const neighbors: RegistryEntity[] = selector ? registry.contextGraph(selector, undefined, 2).nodes.filter(node => node.type === 'ARTIFACT').slice(0, 20).map(node => ({ kind: 'ARTIFACT', id: node.id + (node.revision ? ':' + node.revision : '') })) : pending.length ? pending : refreshPullRequests!.slice(0, 2)
    batches = await read({ selector, neighbors, cursors: registry.cursors() })
  }
  assertCurrent()
  registry.applyAll(batches, assertCurrent)
  if (refreshPullRequests) {
    const previous = registry.source('GITHUB_REFRESH')
    const unavailable = ['NETWORK_NOT_AUTHORIZED', 'UNAVAILABLE'].includes(registry.source('GITHUB')?.status ?? 'UNAVAILABLE') && refreshPullRequests.length > 0
    const cursor = unavailable ? previous?.cursor ?? '' : refreshPullRequests.length > 2 ? refreshPullRequests[1].id : ''
    apply({ repositoryId: store.repositoryId, source: 'GITHUB_REFRESH', revision: digest(cursor + String(unavailable)), cursor,
      status: unavailable || refreshPullRequests.length > 2 ? 'PARTIAL' : 'COMPLETE', edges: [] })
  }
  const commits = new Set<string>()
  if (!selector && read) for (const candidate of registry.pendingReconciliation('COMMIT', 5)) commits.add(candidate.id)
  if (selector?.kind === 'COMMIT') commits.add(selector.id)
  if (capture?.checkpoint.commitSha) commits.add(capture.checkpoint.commitSha)
  else if (capture && /^[a-f0-9]{40}$/.test(capture.head)) commits.add(capture.head)
  for (const batch of batches) for (const edge of batch.edges) if (edge.from.kind === 'COMMIT' && edge.evidenceKind === 'GITHUB_COMMIT_LIST') commits.add(edge.from.id)
  if (!selector && !capture) {
    const head = await runner('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD'], root, 4096)
    if (head.code === 0 && /^[a-f0-9]{40}$/.test(head.text.trim())) commits.add(head.text.trim())
  }
  const unobserved = [...commits].filter(sha => !registry.source('GIT:' + sha))
  const selected = read ? unobserved : selector?.kind === 'COMMIT' ? [selector.id] : unobserved.length ? unobserved : [...commits]
  const requests: { commitSha?: string; checkpointId?: string }[] = selected.slice(0, 4).map(commitSha => ({ commitSha }))
  if (selector?.kind === 'CHECKPOINT') requests.push({ checkpointId: selector.id })
  let refInventory: RegistryBatch | undefined
  if (!selector) {
    const previous = registry.source('ENTIRE_REFS'), after = previous?.cursor ?? ''
    const refs = await runner('git', ['-c', 'core.fsmonitor=false', 'for-each-ref', '--count=3', '--format=%(refname)', ...(after ? ['--start-after=' + after] : []), 'refs/entire/checkpoints/'], root, 4096)
    assertCurrent()
    if (refs.code === 0 && !refs.limited) {
      const rows = refs.text.trim().split('\n').filter(ref => /^refs\/entire\/checkpoints\/[A-Za-z0-9]{2}\/[A-Za-z0-9]{10,40}$/.test(ref))
      for (const ref of rows.slice(0, 2)) requests.push({ checkpointId: ref.split('/').at(-1)! })
      refInventory = { repositoryId: store.repositoryId, source: 'ENTIRE_REFS', revision: digest(refs.text), cursor: rows.length > 2 ? rows[1] : '', status: rows.length > 2 ? 'PARTIAL' : 'OBSERVED_SNAPSHOT', edges: [] }
    } else refInventory = { repositoryId: store.repositoryId, source: 'ENTIRE_REFS', revision: 'UNAVAILABLE', cursor: after, status: 'UNAVAILABLE', edges: [] }
  }
  for (const query of requests) {
    assertCurrent()
    let cached
    try {
      const checkpointId = query.checkpointId ?? (await resolveCheckpointFromCommit(runner, root, query.commitSha!, assertCurrent)).checkpointId
      const args = ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', '--quiet', 'refs/entire/checkpoints/' + checkpointId.slice(-2) + '/' + checkpointId]
      const ref = await runner('git', args, root, 4096)
      if (ref.code === 0 && !ref.limited) cached = registry.cachedCheckpoint(checkpointId, ref.text.trim())
      if (cached) {
        const after = await runner('git', args, root, 4096)
        if (after.code !== 0 || after.text.trim() !== cached.refRevision) cached = undefined
      }
    } catch (error) {
      if (error instanceof Error && ['PROJECT_CONTEXT_CHANGED', 'WORKTREE_STALE', 'REGISTRY_INTEGRITY_FAILED'].includes(error.message)) throw error
    }
    assertCurrent()
    const observation = cached ? { ...cached, commitSha: query.commitSha } : await observeCheckpoint(runner, root, query, assertCurrent)
    const source = 'GIT:' + (query.commitSha ?? query.checkpointId), edges: RegistryBatch['edges'] = []
    const revision = digest(JSON.stringify([observation.state, observation.checkpointId, observation.commitSha, observation.refRevision, observation.metadataDigest, observation.sessionIds])), entities: RegistryEntity[] = query.commitSha ? [{ kind: 'COMMIT', id: query.commitSha }] : []
    if (observation.checkpointId) {
      const checkpoint: RegistryEntity = { kind: 'CHECKPOINT', id: observation.checkpointId }
      entities.push(checkpoint)
      registry.checkpoint(checkpoint.id, observation.refRevision ?? 'UNOBSERVED', observation.state, observation.metadataDigest ?? revision, observation.sessionIds, observation.sessionRefs)
      if (observation.refRevision && observation.metadataDigest && ['VERIFIED', 'PARTIAL'].includes(observation.state)) {
        const evidence = { evidenceRef: checkpoint.id, digest: observation.metadataDigest, freshness: 'OBSERVED_SNAPSHOT' }
        if (query.commitSha && observation.commitSha) edges.push({ from: { kind: 'COMMIT', id: query.commitSha }, relation: 'checkpoint', to: checkpoint, evidenceKind: 'CHECKPOINT_VERIFIED', ...evidence })
        apply({ repositoryId: store.repositoryId, source: 'ENTIRE:' + checkpoint.id, revision: observation.refRevision, status: observation.state === 'VERIFIED' ? 'COMPLETE' : 'PARTIAL',
          entities: [checkpoint], edges: (observation.sessionRefs ?? observation.sessionIds.map(id => ({ id, agent: 'codex' }))).map(session => ({ from: checkpoint, relation: 'contains-session', to: { kind: 'SESSION', id: sessionIdentity('entire', session.id, session.agent) }, evidenceKind: 'CHECKPOINT_SESSION_METADATA', ...evidence })) })
      }
    }
    apply({ repositoryId: store.repositoryId, source, revision, status: observation.reason === 'SOURCE_IDENTITY_CONFLICT' ? 'CONFLICT' : observation.state === 'VERIFIED' ? query.commitSha ? 'COMPLETE' : 'PENDING_COMMIT_ASSOCIATION' : observation.state === 'MISSING' ? 'CHECKPOINT_NOT_OBSERVED' : observation.state, entities, edges })
  }
  if (refInventory) apply(refInventory)
  apply({ repositoryId: store.repositoryId, source: 'ENTIRE_COMMITS', revision: digest(JSON.stringify([...commits])), status: unobserved.length > 4 ? 'PARTIAL' : 'OBSERVED_SNAPSHOT', edges: [] })
  const backlog = registry.reconciliationBacklog()
  if (!backlog.pending) {
    const github = registry.source('GITHUB')
    if (github?.status === 'PARTIAL') apply({ repositoryId: store.repositoryId, source: 'GITHUB', revision: github.revision, cursor: github.cursor, status: 'OBSERVED_SNAPSHOT', edges: [] })
  }
  return selector ? registry.map(selector) : { repositoryId: store.repositoryId, sources: registry.coverageSources(), backlog }
}
