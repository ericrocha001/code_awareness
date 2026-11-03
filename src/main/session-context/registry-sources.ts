import type { ContinuumService } from '../continuum/continuum-service'
import type { Artifact } from '../continuum/continuum-types'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import type { GitHubIntegrationService } from '../github/github-integration-service'
import type { RegistryBatch, RegistryEdge, RegistryEntity, RegistryReader } from './checkpoint-registry'
import { digest } from './privacy'

export function registrySources(options: {
  repositoryId: string; root: string; continuum: () => ContinuumService | null; ledger: ValidationLedger
  github: Pick<GitHubIntegrationService, 'commitPullRequests' | 'getPullRequest' | 'pullRequestCommits'>
  networkAllowed: () => boolean; assertCurrent: () => void
}): RegistryReader {
  const { repositoryId, assertCurrent } = options
  return async ({ selector, cursors }) => {
    assertCurrent()
    const batches: RegistryBatch[] = [], artifacts = new Map<string, Artifact>(), prs = new Set<number>()
    const service = options.continuum()
    const addArtifact = (id: string) => {
      if (artifacts.size >= 20 || !service || artifacts.has(id)) return
      const artifact = service.get(id)
      if (artifact) artifacts.set(id, artifact)
    }
    const addBatch = (batch: Omit<RegistryBatch, 'repositoryId'>) => batches.push({ repositoryId, ...batch })
    const unavailable = (source: string, status = 'UNAVAILABLE') => addBatch({ source, revision: digest(status), cursor: cursors[source], status, edges: [] })
    if (service) {
      try {
        const saved = JSON.parse(cursors.CONTINUUM ?? '{}')
        const until = saved.until ?? new Date().toISOString()
        const page = service.list({ limit: 10, sortBy: 'updatedAt', updatedAfter: saved.after, updatedBefore: until, cursor: saved.cursor })
        for (const row of page.artifacts) addArtifact(row.artifactId)
        addBatch({ source: 'CONTINUUM', revision: digest(JSON.stringify(page.artifacts.map(a => [a.artifactId, a.revision]))), status: page.nextCursor ? 'PARTIAL' : 'COMPLETE', edges: [],
          cursor: JSON.stringify(page.nextCursor ? { after: saved.after, until, cursor: page.nextCursor } : { after: new Date(Date.parse(until) - 1).toISOString() }) })
      } catch { unavailable('CONTINUUM') }
      if (selector?.kind === 'ARTIFACT') {
        addArtifact(selector.id)
        for (const row of service.list({ relatedToArtifactId: selector.id, direction: 'both', limit: 10 }).artifacts) addArtifact(row.artifactId)
      }
      const metadataKey = selector?.kind === 'PR' ? 'pullRequest' : selector?.kind === 'COMMIT' ? 'commitSha' : selector?.kind === 'EXECUTION' ? 'executionId' : undefined
      if (metadataKey && selector) for (const row of service.list({ metadata: { [metadataKey]: selector.kind === 'PR' ? Number(selector.id) : selector.id }, limit: 10 }).artifacts) addArtifact(row.artifactId)
    } else unavailable('CONTINUUM')
    if (selector?.kind === 'PR') prs.add(Number(selector.id))
    for (const artifact of artifacts.values()) {
      const nested = artifact.metadata.metadata
      const metadata = nested && typeof nested === 'object' && !Array.isArray(nested) ? { ...nested, ...artifact.metadata } : artifact.metadata
      if (artifact.metadata.kind === 'IMPLEMENTATION_HANDOFF' && Number.isSafeInteger(metadata.pullRequest) && Number(metadata.pullRequest) > 0) prs.add(Number(metadata.pullRequest))
    }
    if (!options.networkAllowed()) unavailable('GITHUB', 'NETWORK_NOT_AUTHORIZED')
    else {
      try {
        if (selector?.kind === 'COMMIT') for (const number of await options.github.commitPullRequests(options.root, selector.id)) prs.add(number)
        for (const number of [...prs].slice(0, 2)) {
          const pr = (await options.github.getPullRequest(options.root, number)).pullRequest
          const key = 'GITHUB:PR:' + number
          const saved = JSON.parse(cursors[key] ?? '{}')
          const pageNumber = saved.head === pr.head.sha ? saved.nextPage ?? 1 : 1
          const page = await options.github.pullRequestCommits(options.root, number, pr.head.sha, pageNumber)
          if (page.repositoryId !== repositoryId) throw new Error('REPOSITORY_MISMATCH')
          addBatch({ source: key + ':' + pageNumber, revision: pr.head.sha, status: 'COMPLETE', entities: [{ kind: 'PR', id: String(number) }], edges: page.commits.map(commit => ({
            from: { kind: 'COMMIT', id: commit.sha }, relation: 'member-of', to: { kind: 'PR', id: String(number) }, evidenceKind: 'GITHUB_COMMIT_LIST', evidenceRef: `PR:${number}:${pr.head.sha}:${pageNumber}`, digest: digest(JSON.stringify(page.commits)), freshness: 'OBSERVED_SNAPSHOT' })) })
          addBatch({ source: key, revision: pr.head.sha, status: page.nextPage ? 'PARTIAL' : 'COMPLETE', cursor: JSON.stringify({ head: pr.head.sha, nextPage: page.nextPage }), edges: [] })
        }
        addBatch({ source: 'GITHUB', revision: digest(JSON.stringify([...prs])), status: prs.size > 2 ? 'PARTIAL' : 'OBSERVED_SNAPSHOT', edges: [] })
      } catch { unavailable('GITHUB') }
    }
    if (service) {
      for (const number of [...prs].slice(0, 2)) for (const row of service.list({ metadata: { pullRequest: number }, limit: 5 }).artifacts) addArtifact(row.artifactId)
      for (const artifact of [...artifacts.values()]) for (const relation of artifact.metadata.relations ?? []) addArtifact(relation.artifactId)
    }
    for (const artifact of artifacts.values()) {
      const from: RegistryEntity = { kind: 'ARTIFACT', id: artifact.artifactId }
      const evidence = { evidenceRef: artifact.artifactId, digest: artifact.contentHash, freshness: 'OBSERVED_SNAPSHOT' }
      const edges: RegistryEdge[] = (artifact.metadata.relations ?? []).slice(0, 40).map(r => ({ from, relation: r.kind, to: { kind: 'ARTIFACT', id: r.artifactId }, evidenceKind: 'CONTINUUM_TYPED_RELATION', ...evidence }))
      const nested = artifact.metadata.metadata
      const metadata = nested && typeof nested === 'object' && !Array.isArray(nested) ? { ...nested, ...artifact.metadata } : artifact.metadata
      if (artifact.metadata.kind === 'IMPLEMENTATION_HANDOFF') {
        const targets: [RegistryEntity['kind'], unknown][] = [['PR', metadata.pullRequest], ['COMMIT', metadata.commitSha ?? metadata.headCommit], ['EXECUTION', metadata.executionId]]
        for (const [kind, id] of targets) if ((kind === 'PR' && Number.isSafeInteger(id) && Number(id) > 0) || (kind === 'COMMIT' && typeof id === 'string' && /^[a-f0-9]{40}$/.test(id)) || (kind === 'EXECUTION' && typeof id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(id))) {
          edges.push({ from, relation: 'declares', to: { kind, id: String(id) }, evidenceKind: 'HANDOFF_DECLARED', ...evidence })
          if (kind === 'PR') prs.add(Number(id))
        }
      }
      addBatch({ source: 'CONTINUUM:' + artifact.artifactId, revision: String(artifact.revision) + ':' + artifact.contentHash, status: 'COMPLETE', entities: [from], edges })
    }
    const projectProof = (proof: Awaited<ReturnType<ValidationLedger['getProofWithFreshness']>>) => {
      if (!proof) return
      const sourceRepo = proof.commandProfile?.source?.repositoryId ?? proof.commandProfile?.checkout?.repositoryId
      if (sourceRepo && sourceRepo !== repositoryId) return
      const targets = proof.evidenceFor.filter(id => !!service?.get(id)).slice(0, 20)
      if (!sourceRepo && !targets.length) return
      const edges: RegistryEdge[] = targets.map(id => ({ from: { kind: 'ARTIFACT', id }, relation: 'evidence', to: { kind: 'PROOF', id: proof.proofId }, evidenceKind: 'LEDGER_EVIDENCE_FOR', evidenceRef: proof.proofId,
        digest: digest(JSON.stringify([proof.proofId, proof.evidenceFor, proof.sourceFingerprint])), freshness: proof.freshness }))
      addBatch({ source: 'LEDGER:' + proof.proofId, revision: digest(JSON.stringify([proof.recordedAt, proof.freshness])), status: 'COMPLETE', entities: [{ kind: 'PROOF', id: proof.proofId }], edges })
    }
    try {
      if (selector?.kind === 'PROOF') projectProof(await options.ledger.getProofWithFreshness(selector.id))
      const page = await options.ledger.projectionPage(cursors.LEDGER)
      for (const proof of page.proofs) projectProof(proof)
      for (const artifact of [...artifacts.values()].slice(0, 3)) for (const proof of await options.ledger.listProofs({ requirementId: artifact.artifactId, limit: 10 })) projectProof(proof)
      addBatch({ source: 'LEDGER', revision: digest(page.cursor), cursor: page.cursor, status: page.more ? 'PARTIAL' : 'COMPLETE', edges: [] })
    } catch { unavailable('LEDGER') }
    assertCurrent()
    return batches
  }
}
