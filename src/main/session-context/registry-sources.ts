import { randomUUID } from 'node:crypto'
import { discoverGitHubPage } from './github-discovery'
import type { ContinuumService } from '../continuum/continuum-service'
import type { Artifact } from '../continuum/continuum-types'
import type { ValidationLedger } from '../validation-ledger/validation-ledger'
import type { GitHubIntegrationService } from '../github/github-integration-service'
import type { RegistryBatch, RegistryEdge, RegistryEntity, RegistryReader } from './checkpoint-registry'
import { digest } from './privacy'
import { extractArtifactReferences } from '../continuum/artifact-references'

export function registrySources(options: {
  repositoryId: string; root: string; continuum: () => ContinuumService | null; ledger: ValidationLedger
  github: Pick<GitHubIntegrationService, 'commitPullRequests' | 'getPullRequest' | 'pullRequestCommits'> & Partial<Pick<GitHubIntegrationService, 'pullRequestCatalogPage'>>
  networkAllowed: () => boolean; assertCurrent: () => void
}): RegistryReader {
  const { repositoryId, assertCurrent } = options
  const discoveryEpoch = randomUUID()
  return async ({ selector, neighbors = [], cursors }) => {
    assertCurrent()
    const batches: RegistryBatch[] = [], artifacts = new Map<string, Artifact>(), prs = new Set<number>()
    for (const neighbor of neighbors) if (neighbor.kind === 'PR') prs.add(Number(neighbor.id))
    let selectedPartial = false
    const service = options.continuum()
    service?.assertRepository(repositoryId)
    let continuumStage = 'SERVICE'
    const addArtifact = (id: string) => {
      if (artifacts.size >= 20 || !service || artifacts.has(id)) return
      const version = /^(.*):([1-9][0-9]*)$/.exec(id)
      continuumStage = 'ARTIFACT_READBACK'
      const artifact = version ? service.provenanceSnapshot(version[1], Number(version[2])) : service.provenanceSnapshot ? service.provenanceSnapshot(id) : service.get(id)
      if (artifact) artifacts.set(id, artifact)
    }
    const addBatch = (batch: Omit<RegistryBatch, 'repositoryId'>) => batches.push({ repositoryId, ...batch })
    const diagnostic = (source: string, reasonCode: string, stage: string) => {
      const cursor = JSON.stringify({ reasonCode, stage })
      addBatch({ source: source + ':DIAGNOSTIC', revision: digest(cursor), cursor, status: reasonCode, edges: [] })
    }
    const unavailable = (source: string, status = 'UNAVAILABLE', reasonCode = 'SOURCE_UNAVAILABLE', stage = 'SOURCE_READ') => {
      addBatch({ source, revision: digest(status + reasonCode), cursor: cursors[source], status, edges: [] })
      diagnostic(source, reasonCode, stage)
    }
    if (service) {
      if (!selector) try {
        continuumStage = 'INVENTORY_CURSOR'
        const saved = JSON.parse(cursors.CONTINUUM ?? '{}')
        if (!saved || typeof saved !== 'object' || Array.isArray(saved) || ['after', 'until'].some(key => saved[key] !== undefined &&
          (typeof saved[key] !== 'string' || !Number.isFinite(Date.parse(saved[key])))) || saved.cursor !== undefined && typeof saved.cursor !== 'string') throw new Error('REGISTRY_CURSOR_STALE')
        const until = saved.until ?? new Date().toISOString()
        continuumStage = 'INVENTORY_LIST'
        const page = service.list({ limit: 10, sortBy: 'updatedAt', updatedBefore: until,
          ...(saved.after ? { updatedAfter: saved.after } : {}), ...(saved.cursor ? { cursor: saved.cursor } : {}) })
        for (const row of page.artifacts) addArtifact(row.artifactId)
        addBatch({ source: 'CONTINUUM', revision: digest(JSON.stringify(page.artifacts.map(a => [a.artifactId, a.revision]))), status: page.nextCursor ? 'PARTIAL' : 'COMPLETE', edges: [],
          cursor: JSON.stringify(page.nextCursor ? { after: saved.after, until, cursor: page.nextCursor } : { after: new Date(Date.parse(until) - 1).toISOString() }) })
        diagnostic('CONTINUUM', page.nextCursor ? 'BACKLOG_PENDING' : 'SOURCE_READY', continuumStage)
      } catch (error) {
        assertCurrent()
        const stale = error instanceof SyntaxError || error instanceof Error && (error.message === 'REGISTRY_CURSOR_STALE' || /^INVALID_ARGUMENT: (?:invalid cursor|cursor does not match|invalid updatedAfter|invalid updatedBefore)/.test(error.message))
        if (stale) {
          let after: string | undefined
          try { const saved = JSON.parse(cursors.CONTINUUM ?? '{}'); if (typeof saved.after === 'string' && Number.isFinite(Date.parse(saved.after))) after = saved.after } catch {}
          const cursor = JSON.stringify(after ? { after } : {})
          addBatch({ source: 'CONTINUUM', revision: digest(cursor + 'CURSOR_STALE'), cursor, status: 'PARTIAL', edges: [] })
          diagnostic('CONTINUUM', 'CURSOR_STALE', continuumStage)
        } else unavailable('CONTINUUM', 'UNAVAILABLE', 'PROJECTION_ERROR', continuumStage)
      }
      if (selector?.kind === 'ARTIFACT') {
        addArtifact(selector.id)
        const id = selector.id.replace(/:([1-9][0-9]*)$/, '')
        const related = service.list({ relatedToArtifactId: id, direction: 'both', limit: 10 })
        selectedPartial ||= !!related.nextCursor
        for (const row of related.artifacts) addArtifact(row.artifactId)
        if (service.graph) {
          const graph = service.graph({ artifactIds: [id], expand: true, nodeLimit: 20, edgeLimit: 40 }, { indexOnly: true })
          if (graph.repositoryId !== repositoryId) throw new Error('REPOSITORY_MISMATCH')
          selectedPartial ||= graph.truncated.nodes || graph.truncated.edges
          for (const node of graph.nodes) addArtifact(node.artifactId)
        }
      }
      for (const neighbor of neighbors.slice(0, 20)) if (neighbor.kind === 'ARTIFACT') addArtifact(neighbor.id)
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
        const assertNetwork = () => { assertCurrent(); if (!options.networkAllowed()) throw new Error('NETWORK_NOT_AUTHORIZED') }
        let discoveryUnavailable = false
        if (!selector && options.github.pullRequestCatalogPage) {
          const discovery = await discoverGitHubPage({ repositoryId, root: options.root, read: options.github.pullRequestCatalogPage.bind(options.github), cursor: cursors.GITHUB_DISCOVERY, epoch: discoveryEpoch, assertCurrent, assertNetwork })
          batches.push(...discovery)
          const state = discovery.find(batch => batch.source === 'GITHUB_DISCOVERY')
          discoveryUnavailable = state?.status === 'UNAVAILABLE'
          if (state) {
            const progress = JSON.parse(state.cursor ?? '{}')
            diagnostic('GITHUB_DISCOVERY', progress.reasonCode ?? 'SOURCE_READY', 'CATALOG_PAGE')
          }
        }
        if (selector?.kind === 'COMMIT') {
          assertNetwork()
          for (const number of await options.github.commitPullRequests(options.root, selector.id)) prs.add(number)
        }
        for (const number of [...prs].slice(0, 2)) {
          assertNetwork()
          const key = 'GITHUB:PR:' + number
          const saved = JSON.parse(cursors[key] ?? '{}')
          const catalog = batches.find(batch => batch.source === 'GITHUB_CATALOG:PR:' + number)?.cursor ?? cursors['GITHUB_CATALOG:PR:' + number]
          const catalogRecord = catalog ? JSON.parse(catalog) : undefined
          const { scanPass: _scanPass, ...catalogFields } = catalogRecord ?? {}
          const catalogRevision = catalog ? digest(JSON.stringify(catalogFields)) : undefined
          const record = catalogRecord
          if (record && (record.head.repositoryId !== record.base.repositoryId || record.head.repository?.toLowerCase() !== record.base.repository.toLowerCase())) {
            addBatch({ source: key, revision: record.head.sha, status: 'CONFLICT', cursor: JSON.stringify({ head: record.head.sha, nextPage: null, catalogRevision, reasonCode: 'SOURCE_IDENTITY_CONFLICT' }), edges: [] })
            continue
          }
          const pr = (await options.github.getPullRequest(options.root, number)).pullRequest
          if (saved.head === pr.head.sha && saved.nextPage === null && saved.catalogRevision === catalogRevision) continue
          const pageNumber = saved.head === pr.head.sha ? saved.nextPage ?? 1 : 1
          assertNetwork()
          let page
          try { page = await options.github.pullRequestCommits(options.root, number, pr.head.sha, pageNumber) }
          catch (error) {
            assertNetwork()
            if (error instanceof Error && error.message === 'PR_SOURCE_REPOSITORY_MISMATCH') {
              addBatch({ source: key, revision: pr.head.sha, status: 'CONFLICT', cursor: JSON.stringify({ head: pr.head.sha, nextPage: null, catalogRevision, reasonCode: 'SOURCE_IDENTITY_CONFLICT' }), edges: [] })
              continue
            }
            throw error
          }
          assertCurrent()
          if (page.repositoryId !== repositoryId) throw new Error('REPOSITORY_MISMATCH')
          addBatch({ source: key + ':' + pageNumber, revision: pr.head.sha, status: 'COMPLETE', entities: [{ kind: 'PR', id: String(number) }], edges: page.commits.map(commit => ({
            from: { kind: 'COMMIT', id: commit.sha }, relation: 'member-of', to: { kind: 'PR', id: String(number) }, evidenceKind: 'GITHUB_COMMIT_LIST', evidenceRef: `PR:${number}:${pr.head.sha}:${pageNumber}`, digest: digest(JSON.stringify(page.commits)), freshness: 'OBSERVED_SNAPSHOT' })) })
          addBatch({ source: key, revision: pr.head.sha, status: page.nextPage ? 'PARTIAL' : 'COMPLETE', cursor: JSON.stringify({ head: pr.head.sha, nextPage: page.nextPage, catalogRevision }), edges: [] })
        }
        addBatch({ source: 'GITHUB', revision: digest(JSON.stringify([...prs])), status: discoveryUnavailable ? 'UNAVAILABLE' : prs.size > 2 ? 'PARTIAL' : 'OBSERVED_SNAPSHOT', edges: [] })
      } catch (error) {
        assertCurrent()
        unavailable('GITHUB', error instanceof Error && error.message === 'NETWORK_NOT_AUTHORIZED' ? 'NETWORK_NOT_AUTHORIZED' : 'UNAVAILABLE')
      }
    }
    if (service) {
      for (const number of [...prs].slice(0, 2)) for (const row of service.list({ metadata: { pullRequest: number }, limit: 5 }).artifacts) addArtifact(row.artifactId)
      for (const artifact of [...artifacts.values()]) for (const relation of artifact.metadata.relations ?? []) addArtifact(relation.artifactId)
    }
    const projectProof = (proof: Awaited<ReturnType<ValidationLedger['getProofWithFreshness']>>) => {
      assertCurrent()
      if (!proof) return
      const sourceRepo = proof.commandProfile?.source?.repositoryId ?? proof.commandProfile?.checkout?.repositoryId
      if (sourceRepo && sourceRepo !== repositoryId) return
      const targets = proof.evidenceFor.filter(id => !!service?.get(id)).slice(0, 20)
      if (!sourceRepo && !targets.length) return
      for (const id of targets) addArtifact(id)
      const edges: RegistryEdge[] = targets.map(id => ({ from: { kind: 'ARTIFACT', id }, relation: 'evidence', to: { kind: 'PROOF', id: proof.proofId }, evidenceKind: 'LEDGER_EVIDENCE_FOR', evidenceRef: proof.proofId,
        digest: digest(JSON.stringify([proof.proofId, proof.evidenceFor, proof.sourceFingerprint])), freshness: proof.freshness }))
      addBatch({ source: 'LEDGER:' + proof.proofId, revision: digest(JSON.stringify([proof.recordedAt, proof.freshness])), status: 'COMPLETE', entities: [{ kind: 'PROOF', id: proof.proofId }], edges })
    }
    try {
      if (selector?.kind === 'PROOF') projectProof(await options.ledger.getProofWithFreshness(selector.id))
      const page = !selector ? await options.ledger.projectionPage(cursors.LEDGER) : undefined
      for (const proof of page?.proofs ?? []) projectProof(proof)
      for (const artifact of [...artifacts.values()].slice(0, 3)) for (const proof of await options.ledger.listProofs({ requirementId: artifact.artifactId, limit: 10 })) projectProof(proof)
      addBatch({ source: 'LEDGER', revision: digest(page?.cursor ?? selector?.id ?? ''), cursor: page?.cursor ?? cursors.LEDGER, status: page?.more ? 'PARTIAL' : selector ? 'SELECTED_SCOPE' : 'COMPLETE', edges: [] })
    } catch { assertCurrent(); unavailable('LEDGER') }
    for (const artifact of artifacts.values()) {
      const identity: RegistryEntity = { kind: 'ARTIFACT', id: artifact.artifactId }
      const from: RegistryEntity = { kind: 'ARTIFACT', id: artifact.artifactId + ':' + artifact.revision }
      const evidence = { evidenceRef: artifact.artifactId + ':' + artifact.revision, digest: artifact.contentHash, freshness: 'EXACT_REVISION' }
      const edges: RegistryEdge[] = (artifact.metadata.relations ?? []).slice(0, 40).map(r => ({ from, relation: r.kind, to: { kind: 'ARTIFACT', id: r.artifactId }, evidenceKind: 'CONTINUUM_TYPED_RELATION', ...evidence }))
      selectedPartial ||= (artifact.metadata.relations?.length ?? 0) > 40
      for (const id of extractArtifactReferences(artifact.rawMarkdown ?? '').slice(0, 20)) if (id !== artifact.artifactId && service?.get(id)) edges.push({ from, relation: 'references', to: { kind: 'ARTIFACT', id }, evidenceKind: 'CONTINUUM_REFERENCE', ...evidence })
      const nested = artifact.metadata.metadata
      const metadata = nested && typeof nested === 'object' && !Array.isArray(nested) ? { ...nested, ...artifact.metadata } : artifact.metadata
      if (typeof metadata.executionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(metadata.executionId)) edges.push({ from, relation: 'member-of', to: { kind: 'EXECUTION', id: metadata.executionId }, evidenceKind: 'EXECUTION_MEMBERSHIP', ...evidence })
      if (artifact.metadata.kind === 'IMPLEMENTATION_HANDOFF') {
        const targets: [RegistryEntity['kind'], unknown][] = [['PR', metadata.pullRequest], ['COMMIT', metadata.commitSha ?? metadata.headCommit], ['EXECUTION', metadata.executionId]]
        for (const [kind, id] of targets) if ((kind === 'PR' && Number.isSafeInteger(id) && Number(id) > 0) || (kind === 'COMMIT' && typeof id === 'string' && /^[a-f0-9]{40}$/.test(id)) || (kind === 'EXECUTION' && typeof id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(id))) {
          edges.push({ from, relation: 'declares', to: { kind, id: String(id) }, evidenceKind: 'HANDOFF_DECLARED', ...evidence })
          if (kind === 'PR') prs.add(Number(id))
        }
      }
      const native = artifact.provenance?.nativeArtifact as { state?: string; receiptId?: string } | undefined
      const authority = { nativeState: native?.state ?? 'UNAVAILABLE', receiptId: native?.receiptId }
      addBatch({ source: 'CONTINUUM:' + from.id, revision: String(artifact.revision) + ':' + artifact.contentHash + ':' + digest(JSON.stringify(authority)), cursor: JSON.stringify(authority), status: 'COMPLETE', entities: [from], edges })
      const current = service?.get(artifact.artifactId)
      if (current?.revision === artifact.revision) {
        addBatch({ source: 'CONTINUUM:' + artifact.artifactId, revision: 'REVISIONED_PROJECTION', status: 'REPLACED', edges: [] })
        addBatch({ source: 'CONTINUUM_CURRENT:' + artifact.artifactId, revision: String(artifact.revision) + ':' + artifact.contentHash, status: 'COMPLETE', entities: [identity], edges: [
        { from: identity, relation: 'revision', to: from, evidenceKind: 'CONTINUUM_REVISION', ...evidence }
        ] })
      }
    }
    if (selector && service) addBatch({ source: 'CONTINUUM', revision: digest(JSON.stringify([...artifacts.values()].map(artifact => [artifact.artifactId, artifact.revision, artifact.contentHash]))), cursor: cursors.CONTINUUM,
      status: selectedPartial || artifacts.size >= 20 ? 'PARTIAL' : 'SELECTED_SCOPE', edges: [] })
    assertCurrent()
    return batches
  }
}
