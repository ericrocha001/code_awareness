import { ArtifactTokenCache, TOKEN_CACHE_SCHEMA } from './artifact-token-cache'
import { PublicationReceipts, type PublicationReceiptContext } from './publication-receipts'
import { PublicationAssociations } from './publication-associations'
import type { DocumentaryMembership, DocumentaryMembershipIntent, PublicationAssociation } from '../../shared/types/publication-provenance-types'
import { ArtifactTags, editArtifactTags } from './artifact-tags'
import { artifactTags, quickTag, tagDescription, validateTagSlug, type ContinuumTagAssignment, type ContinuumTagDefinition } from '../../shared/types/continuum-tag-types'
import { parseArtifactMarkdown } from './artifact-metadata'
import { metadataPeriod, validatePeriods } from './temporal-metadata'
import { ArtifactGraph } from './artifact-graph'
import { ArtifactSuggestions } from './artifact-suggestions'
import type { ContinuumSuggestionQuery } from '../../shared/types/continuum-suggestion-types'
import type { ContinuumGraphQuery } from '../../shared/types/continuum-graph-types'
import Database from 'better-sqlite3'
import type { ContinuumFacet, ContinuumScalar } from '../../shared/types/continuum-ui-types'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { ExecutionActivationRecord, ExecutionActivationScopeKind, ExecutionActivationStatus, ExecutionIdentityRecord } from '../../shared/types/delivery-context-types'
import type { ExecutionBranchSnapshot } from '../../shared/types/execution-branch-types'
import { artifactSearchQuery } from './artifact-search-query'
import { searchArtifacts } from './artifact-search'
import { ArtifactSearchProjection } from './artifact-search-projection'
import { ArtifactNavigation } from './artifact-navigation'
import type { StructureQuery, SectionQuery } from './artifact-structure'
import { inspectWebP, mediaHash } from './visual-media'
import type { VisualMedia, VisualArtifact } from './continuum-types'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Artifact, ArtifactDiscoveryRecord, ArtifactPage, CreateArtifactInput, UpdateArtifactInput, ListArtifactsFilter, MetadataValue } from './continuum-types'
import { canonicalJson, normalizeMetadataValue, relationsOf, validateMetadata, validateMarkdown } from './artifact-metadata'
import { extractOutline, STRUCTURE_VERSION, type OutlineSection } from './artifact-structure'

export class ArtifactIdentityConflictError extends Error {
  constructor(readonly artifactId: string) { super(`IDENTITY_CONFLICT: Artifact "${artifactId}" already exists`); this.name = 'ArtifactIdentityConflictError' }
}
export class ArtifactRevisionConflictError extends Error {
  constructor(readonly artifactId: string, readonly currentRevision: number) {
    super(`REVISION_CONFLICT: Artifact "${artifactId}" is at revision ${currentRevision}; read again before updating`)
    this.name = 'ArtifactRevisionConflictError'
  }
}
export class ArtifactContentIntegrityError extends Error {
  constructor() { super('INTEGRITY_ERROR: contentHash does not match rawMarkdown'); this.name = 'ArtifactContentIntegrityError' }
}
export function computeContentHash(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex') }

interface ArtifactRow {
  artifact_id: string; revision: number; metadata_json: string; name: string; description: string | null
  kind: string; status: string | null; created_at: string; updated_at: string; raw_markdown: string
  content_hash: string; provenance_json: string
}
interface DiscoveryRow {
  revision: number
  artifact_id: string; name: string; description: string | null; kind: string; status: string | null
  created_at?: string; updated_at: string; relation_count: number; content_hash: string
}

export class ArtifactStore {
  private readonly publicationReceipts: PublicationReceipts
  private readonly publicationAssociations: PublicationAssociations
  associatePublication(value: PublicationAssociation) { return this.publicationAssociations.record(value) }
  invalidatePublication(invocationId: string, state: 'UNAVAILABLE' | 'PARTIAL' | 'AMBIGUOUS') { this.publicationAssociations.invalidate(invocationId, state) }
  publicationProvenance(artifactId: string, revision: number) { return this.publicationAssociations.projection(artifactId, revision) }
  indexedArtifact(artifactId: string) {
    const row = this.db.prepare('SELECT revision, metadata_json, provenance_json, content_hash FROM artifacts WHERE artifact_id=?').get(artifactId) as
      { revision: number; metadata_json: string; provenance_json: string; content_hash: string } | undefined
    if (!row) return null
    const executionIdentity = this.getExecutionIdentity(artifactId)
    const provenance = JSON.parse(row.provenance_json) as Artifact['provenance']
    return { revision: row.revision, metadata: JSON.parse(row.metadata_json) as Artifact['metadata'],
      provenance: executionIdentity ? { ...provenance, executionIdentity: executionIdentity as unknown as MetadataValue } : provenance,
      contentHash: row.content_hash }
  }
  readPublicationReceipt(receiptId: string) { return this.publicationReceipts.read(receiptId) }
  publicationReceiptAt(artifactId: string, revision: number, action: 'PUBLISH' | 'UPDATE') {
    return this.publicationReceipts.atRevision(artifactId, revision, action)
  }
  private revisionHeader(artifactId: string, revision: number) {
    return this.db.prepare(`SELECT json_extract(snapshot_json, '$.contentHash') AS hash,
      json_extract(snapshot_json, '$.metadata') AS metadata,
      json_extract(snapshot_json, '$.provenance.executionBranchBinding') AS binding
      FROM artifact_revisions WHERE artifact_id = ? AND revision = ?`).get(artifactId, revision) as
      { hash: string; metadata: string; binding: number | null } | undefined
  }
  private describeMembership(receipt: import('./continuum-types').PublicationReceipt | null): DocumentaryMembership | null {
    if (!receipt?.documentaryMembership || !receipt.deliveryContext) return null
    const anchor = receipt.deliveryContext
    const document = this.revisionHeader(receipt.artifactId, receipt.revision)
    const plan = this.revisionHeader(anchor.planArtifactId, anchor.planRevision)
    const binding = this.revisionHeader(anchor.bindingArtifactId, anchor.bindingRevision)
    if (!document || document.hash !== receipt.contentHash || !plan || plan.hash !== anchor.planDigest ||
      !binding || binding.hash !== anchor.bindingDigest || binding.binding !== 1) throw new Error('MEMBERSHIP_RECEIPT_INTEGRITY')
    const planMetadata = JSON.parse(plan.metadata) as Artifact['metadata']
    const bindingMetadata = JSON.parse(binding.metadata) as Artifact['metadata']
    const metadata = JSON.parse(document.metadata) as Artifact['metadata']
    const targets = relationsOf(metadata).filter(relation => relation.kind === 'implements')
    if (planMetadata.kind !== 'EXECUTABLE_PLAN' || metadata.kind === 'EXECUTABLE_PLAN' ||
      this.getExecutionIdentity(anchor.planArtifactId)?.executionId !== anchor.executionId ||
      this.db.prepare('SELECT 1 FROM execution_identities WHERE execution_id = ? AND artifact_id <> ?').get(anchor.executionId, anchor.planArtifactId) ||
      bindingMetadata.repositoryId !== this.repositoryId || bindingMetadata.sourceArtifactId !== anchor.planArtifactId ||
      bindingMetadata.executionId !== anchor.executionId || bindingMetadata.bindingRole !== 'EXECUTION_BRANCH' ||
      bindingMetadata.worktreeId !== anchor.snapshot.worktreeId || bindingMetadata.worktreeGeneration !== anchor.snapshot.worktreeGeneration ||
      bindingMetadata.branchRef !== anchor.snapshot.branchRef || bindingMetadata.branchGeneration !== anchor.snapshot.branchGeneration ||
      targets.length > 1 || targets.some(target => target.artifactId !== anchor.planArtifactId) ||
      receipt.documentaryMembership === 'HANDOFF_IMPLEMENTS' && (metadata.kind !== 'IMPLEMENTATION_HANDOFF' || targets.length !== 1)) throw new Error('MEMBERSHIP_RECEIPT_INTEGRITY')
    return { repositoryId: this.repositoryId, artifactId: receipt.artifactId, revision: receipt.revision, contentHash: receipt.contentHash,
      executionId: anchor.executionId, planArtifactId: anchor.planArtifactId, planRevision: anchor.planRevision, planDigest: anchor.planDigest,
      bindingArtifactId: anchor.bindingArtifactId, bindingRevision: anchor.bindingRevision, bindingDigest: anchor.bindingDigest,
      evidenceRef: receipt.receiptId, digest: receipt.digest, intent: receipt.documentaryMembership, classification: 'VERIFIED' as const }
  }
  membershipAt(artifactId: string, revision?: number) {
    const currentRevision = revision ?? (this.db.prepare('SELECT revision FROM artifacts WHERE artifact_id = ?').get(artifactId) as { revision: number } | undefined)?.revision
    return currentRevision === undefined ? null : this.describeMembership(this.publicationReceipts.membershipAt(artifactId, currentRevision))
  }
  executionRoot(executionId: string) {
    const rows = this.db.prepare('SELECT artifact_id, assigned_revision FROM execution_identities WHERE execution_id = ? LIMIT 2')
      .all(executionId) as Array<{ artifact_id: string; assigned_revision: number }>
    if (rows.length !== 1) return null
    const row = rows[0]!
    const header = this.revisionHeader(row.artifact_id, row.assigned_revision)
    if (!header || JSON.parse(header.metadata).kind !== 'EXECUTABLE_PLAN') return null
    return { executionId, artifactId: row.artifact_id, revision: row.assigned_revision,
      contentHash: header.hash, evidenceRef: row.artifact_id + ':' + row.assigned_revision, classification: 'VERIFIED' as const }
  }
  membershipSelection(artifactId: string, revision?: number) {
    const current = this.db.prepare('SELECT revision FROM artifacts WHERE artifact_id = ?').get(artifactId) as { revision: number } | undefined
    const selected = revision ?? current?.revision
    if (selected === undefined || !this.revisionHeader(artifactId, selected)) throw new Error('ARTIFACT_REVISION_NOT_FOUND')
    const membership = this.membershipAt(artifactId, selected)
    const identity = this.getExecutionIdentity(artifactId)
    const root = identity && identity.assignedRevision === selected ? this.executionRoot(identity.executionId) : null
    return { artifactId, revision: selected, membership, root, coverage: 'COMPLETE' as const,
      ...(!membership && !root ? { reason: 'NO_VERIFIED_MEMBERSHIP_FOR_REVISION' } : {}) }
  }
  executionMembers(executionId: string, limit = 20, cursor?: string) {
    const bounded = Math.max(1, Math.min(50, limit))
    const prefix = computeContentHash(JSON.stringify([this.repositoryId, executionId, bounded])).slice(0, 16) + ':'
    if (cursor && (!cursor.startsWith(prefix) || !/^\d+$/.test(cursor.slice(prefix.length)))) throw new Error('INVALID_MEMBERSHIP_CURSOR')
    const root = this.executionRoot(executionId)
    if (!root) return { root, members: [], coverage: 'PARTIAL', reason: 'CANONICAL_EXECUTION_UNAVAILABLE' }
    const rows = this.publicationReceipts.membershipRows(executionId, cursor ? Number(cursor.slice(prefix.length)) : 0, bounded + 1)
    const page = rows.slice(0, bounded)
    const members = page.map(row => this.describeMembership(this.publicationReceipts.read(row.receipt_id, true)))
    return { root, members, coverage: rows.length > bounded ? 'PARTIAL' : 'COMPLETE',
      ...(rows.length > bounded ? { nextCursor: prefix + page.at(-1)!.rowid } : {}) }
  }
  publicationDeliveryPage(after?: string, limit?: number, filter?: import('../../shared/types/delivery-context-types').DeliveryProjectionFilter) { return this.publicationReceipts.deliveryPage(after, limit, filter) }
  private qualifyPublication(metadata: Artifact['metadata'], context?: PublicationReceiptContext, intent?: DocumentaryMembershipIntent, prior?: Artifact | null): PublicationReceiptContext | undefined {
    const anchor = context?.deliveryContext
    const previous = prior ? this.publicationReceipts.latestMembershipEvent(prior.artifactId) : null
    const origin = previous?.documentaryMembership ? previous.deliveryContext : undefined
    const implementsTargets = (value: Artifact['metadata']) => relationsOf(value).filter(relation => relation.kind === 'implements').map(relation => relation.artifactId)
    const targets = implementsTargets(metadata)
    const sameOrigin = Boolean(origin && anchor && origin.planArtifactId === anchor.planArtifactId && origin.executionId === anchor.executionId)
    const assertAnchor = () => {
      if (!anchor || anchor.repositoryId !== this.repositoryId) throw new Error('MEMBERSHIP_AUTHORITY_REQUIRED')
      const plan = this.get(anchor.planArtifactId), binding = this.get(anchor.bindingArtifactId)
      if (!plan || !binding || plan.metadata.kind !== 'EXECUTABLE_PLAN' || binding.provenance.executionBranchBinding !== true ||
        binding.metadata.sourceArtifactId !== plan.artifactId || binding.metadata.executionId !== anchor.executionId ||
        this.resolvePlanExecutionId(plan) !== anchor.executionId) throw new Error('MEMBERSHIP_SOURCE_MISMATCH')
      const activation = this.getActiveActivation(anchor.snapshot.worktreeId)
      if (!activation || activation.activationId !== context?.activation?.id || activation.revision !== context.activation.revision ||
        activation.executionId !== anchor.executionId || activation.planArtifactId !== plan.artifactId ||
        activation.bindingArtifactId !== binding.artifactId || activation.repositoryId !== this.repositoryId ||
        activation.worktreeGeneration !== anchor.snapshot.worktreeGeneration || activation.branchRef !== anchor.snapshot.branchRef ||
        activation.branchGeneration !== anchor.snapshot.branchGeneration) throw new Error('MEMBERSHIP_ACTIVATION_INVALID')
      if (plan.revision !== anchor.planRevision || plan.contentHash !== anchor.planDigest ||
        binding.revision !== anchor.bindingRevision || binding.contentHash !== anchor.bindingDigest ||
        activation.planRevision !== anchor.planRevision || activation.planContentHash !== anchor.planDigest ||
        activation.bindingRevision !== anchor.bindingRevision || activation.bindingContentHash !== anchor.bindingDigest) throw new Error('MEMBERSHIP_CONTEXT_STALE')
    }
    if (intent && 'action' in intent) {
      if (!sameOrigin || !intent.reason.trim()) throw new Error('MEMBERSHIP_ORIGIN_REQUIRED')
      assertAnchor()
      return { ...context, documentaryUnlinkReason: intent.reason }
    }
    const changedTarget = prior && (prior.metadata.kind !== metadata.kind || JSON.stringify(implementsTargets(prior.metadata)) !== JSON.stringify(targets))
    if (origin && changedTarget && !(sameOrigin && intent)) {
      throw new Error('MEMBERSHIP_UNLINK_REQUIRED')
    }
    if (origin && !sameOrigin && intent) throw new Error('MEMBERSHIP_ORIGIN_REQUIRED')
    if (origin && !sameOrigin) return context
    const handoffIntent = metadata.kind === 'IMPLEMENTATION_HANDOFF' && targets.length > 0 && Boolean(anchor) && (!prior || changedTarget)
    const kind = intent ? 'EXPLICIT_TARGET' : previous?.documentaryMembership ?? (handoffIntent ? 'HANDOFF_IMPLEMENTS' : undefined)
    if (!kind) return context
    assertAnchor()
    if (metadata.kind === 'EXECUTABLE_PLAN' || targets.length > 1 || targets.some(target => target !== anchor!.planArtifactId) ||
      (intent && (intent.planArtifactId !== anchor!.planArtifactId || intent.expectedPlanRevision !== anchor!.planRevision))) throw new Error('MEMBERSHIP_TARGET_CONFLICT')
    return { ...context, documentaryMembership: kind }
  }
  createPublished(input: CreateArtifactInput, requestDigest: string, receiptContext?: PublicationReceiptContext, intent?: DocumentaryMembershipIntent) {
    return this.db.transaction(() => {
      const context = this.qualifyPublication(input.metadata, receiptContext, intent)
      const artifact = this.createInsideTransaction(input)
      return { artifact, publicationReceipt: this.publicationReceipts.issue(artifact, 'PUBLISH', requestDigest, context) }
    }).immediate()
  }
  updatePublished(input: UpdateArtifactInput, requestDigest: string, receiptContext?: PublicationReceiptContext, intent?: DocumentaryMembershipIntent) {
    return this.db.transaction(() => {
      const context = this.qualifyPublication(input.metadata, receiptContext, intent, this.get(input.artifactId))
      const artifact = this.update(input)
      return { artifact, publicationReceipt: this.publicationReceipts.issue(artifact, 'UPDATE', requestDigest, context) }
    }).immediate()
  }
  repairPublished(artifactId: string, expectedRevision: number, requestDigest: string, principalId: string, receiptContext?: PublicationReceiptContext) {
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT revision FROM artifacts WHERE artifact_id=?').get(artifactId) as { revision: number } | undefined
      if (!current) throw new Error('ARTIFACT_NOT_FOUND')
      if (current.revision !== expectedRevision) throw new ArtifactRevisionConflictError(artifactId, current.revision)
      const latest = this.db.prepare('SELECT revision FROM artifact_revisions WHERE artifact_id=? ORDER BY revision DESC LIMIT 1').get(artifactId) as { revision: number } | undefined
      if (!latest) throw new Error('CANONICAL_SOURCE_UNAVAILABLE')
      const canonical = this.getRevision(artifactId, latest.revision)!, initial = this.getRevision(artifactId, 1)!
      if (!initial) throw new Error('CANONICAL_SOURCE_UNAVAILABLE')
      const metadata = /^(?:\uFEFF)?---\r?\n/.test(canonical.rawMarkdown) ? parseArtifactMarkdown(canonical.rawMarkdown, true).metadata : canonical.metadata
      if (canonical.metadata.kind === 'VISUAL_REFERENCE') metadata.media = canonical.metadata.media
      const context = this.qualifyPublication(metadata, receiptContext, undefined, canonical)
      this.db.prepare(`UPDATE artifacts SET revision=?, metadata_json=?, name=?, description=?, kind=?, status=?, created_at=?, updated_at=?, raw_markdown=?, content_hash=?, provenance_json=? WHERE artifact_id=? AND revision=?`)
        .run(canonical.revision, JSON.stringify(metadata), metadata.name, metadata.description ?? null, metadata.kind, metadata.status ?? null, initial.createdAt, canonical.updatedAt,
          canonical.rawMarkdown, computeContentHash(canonical.rawMarkdown), JSON.stringify(canonical.provenance), artifactId, expectedRevision)
      if (canonical.metadata.kind === 'VISUAL_REFERENCE') this.getVisual(artifactId)
      const { deliveryContext: _anchor, sessionWitness: _witness, ...canonicalProvenance } = canonical.provenance
      const provenance = { ...canonicalProvenance, ...(context?.deliveryContext ? { deliveryContext: normalizeMetadataValue(context.deliveryContext) } : {}),
        technicalRepair: { principalId, requestDigest, source: 'IMMUTABLE_REVISION', sourceRevision: canonical.revision, sourceContentHash: canonical.contentHash } }
      const artifact: Artifact = { ...canonical, metadata, createdAt: initial.createdAt, revision: canonical.revision + 1,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(canonical.updatedAt) + 1)).toISOString(), contentHash: computeContentHash(canonical.rawMarkdown), provenance }
      this.db.prepare('UPDATE artifacts SET revision=?, updated_at=?, provenance_json=? WHERE artifact_id=?').run(artifact.revision, artifact.updatedAt, JSON.stringify(provenance), artifactId)
      this.writeIndexes(artifact)
      return { artifact, publicationReceipt: this.publicationReceipts.issue(artifact, 'UPDATE', requestDigest, context) }
    }).immediate()
  }
  createVisualPublished(input: CreateArtifactInput, data: Buffer, media: VisualMedia, requestDigest: string) {
    return this.db.transaction(() => {
      const artifact = this.createVisual(input, data, media)
      return { artifact, publicationReceipt: this.publicationReceipts.issue(artifact, 'PUBLISH', requestDigest) }
    }).immediate()
  }
  private readonly tagIndex: ArtifactTags
  private readonly tokenCache: ArtifactTokenCache
  tags() { return this.tagIndex.list() }
  resolveBuilderGroup(filter: ListArtifactsFilter) {
    return this.db.transaction(() => {
      const members: ArtifactDiscoveryRecord[] = []
      let cursor: string | undefined
      let bytes = 0
      do {
        const page = this.list({ ...filter, cursor, limit: 100, includeRawMarkdownTokenCount: false })
        bytes += Buffer.byteLength(JSON.stringify(page.artifacts), 'utf8')
        if (bytes > 2 * 1024 * 1024) throw new Error('BUNDLE_LIMIT: metadata excede 2 MiB; nenhum membro foi truncado')
        members.push(...page.artifacts)
        cursor = page.nextCursor
      } while (cursor)
      return members
    })()
  }
  builderEntries(selected: import('../../shared/types/continuum-ui-types').ContinuumSelectedArtifact[]) {
    if (!Array.isArray(selected) || !selected.length || Buffer.byteLength(JSON.stringify(selected), 'utf8') > 2 * 1024 * 1024) throw new Error('INVALID_SELECTION')
    const entries: Array<{ artifactId: string; revision: number; contentHash: string }> = []
    const ids = new Set<string>()
    for (let offset = 0; offset < selected.length; offset += 100) {
      const batch = selected.slice(offset, offset + 100)
      for (const item of batch) {
        if (!item || ids.has(item.artifactId)) throw new Error('INVALID_SELECTION')
        ids.add(item.artifactId)
      }
      entries.push(...this.selectionEntries(batch))
    }
    return entries
  }
  resolveSelection(filter: ListArtifactsFilter) {
    return this.db.transaction(() => {
      const page = this.list({ ...filter, cursor: undefined, limit: 100, includeRawMarkdownTokenCount: false })
      if (page.nextCursor) throw new Error('SELECTION_LIMIT: mais de 100 resultados; refine os filtros')
      return page.artifacts
    })()
  }
  selectionEntries(selected: import('../../shared/types/continuum-ui-types').ContinuumSelectedArtifact[]) {
    if (!Array.isArray(selected) || !selected.length || selected.length > 100 || new Set(selected.map(item => item?.artifactId)).size !== selected.length || selected.some(item => !item || typeof item.artifactId !== 'string' || !Number.isInteger(item.expectedRevision) || item.expectedRevision < 1)) throw new Error('INVALID_SELECTION')
    const entries = this.db.prepare(`SELECT artifact_id AS artifactId, revision, content_hash AS contentHash FROM artifacts WHERE artifact_id IN (${selected.map(() => '?').join(',')})`).all(...selected.map(item => item.artifactId)) as Array<{ artifactId: string; revision: number; contentHash: string }>
    for (const item of selected) {
      const entry = entries.find(entry => entry.artifactId === item.artifactId)
      if (!entry || entry.revision !== item.expectedRevision) throw new ArtifactRevisionConflictError(item.artifactId, entry?.revision ?? 0)
    }
    return entries
  }
  tagTokenMembers(slugs: string[]) {
    if (!Array.isArray(slugs) || !slugs.length || slugs.length > 20 || new Set(slugs).size !== slugs.length) throw new Error('INVALID_TAG_SELECTION')
    for (const slug of slugs) this.tagIndex.require(slug)
    return this.db.prepare(`SELECT m.slug, a.artifact_id AS artifactId, a.revision, a.content_hash AS contentHash
      FROM artifact_tags m JOIN artifacts a ON a.artifact_id = m.artifact_id
      WHERE m.slug IN (${slugs.map(() => '?').join(',')}) ORDER BY m.slug, a.artifact_id`).all(...slugs) as Array<{ slug: string; artifactId: string; revision: number; contentHash: string }>
  }
  saveTag(tag: ContinuumTagDefinition, create: boolean) { this.tagIndex.save(tag, create) }
  deleteTag(slug: string) { this.tagIndex.delete(slug) }
  requireTag(slug: string) { this.tagIndex.require(slug) }
  createQuickTag(name: string, selected?: ContinuumTagAssignment[], description?: string) {
    const definition = { ...quickTag(name), description: tagDescription(description) }
    return this.db.transaction(() => {
      const existing = this.tags().find(tag => tag.slug === definition.slug)
      if (existing && existing.name.normalize('NFKC').toLocaleLowerCase('en') !== definition.name.normalize('NFKC').toLocaleLowerCase('en')) throw new Error('TAG_IDENTITY_CONFLICT: escolha outro nome')
      if (!existing) this.saveTag(definition, true)
      const artifacts = selected === undefined ? [] : this.assignTag(definition.slug, selected, true)
      return { state: existing ? 'EXISTING' as const : 'CREATED' as const, tag: this.tags().find(tag => tag.slug === definition.slug)!, artifacts }
    }).immediate()
  }
  assignTag(slug: string, selected: ContinuumTagAssignment[], assigned: boolean): Artifact[] {
    this.tagIndex.require(slug)
    if (!Array.isArray(selected) || !selected.length || selected.length > 100 || new Set(selected.map(item => item.artifactId)).size !== selected.length || typeof assigned !== "boolean") throw new Error("INVALID_TAG_SELECTION")
    return this.db.transaction(() => selected.map(item => {
      const current = this.get(item.artifactId)
      if (!current) throw new Error("ARTIFACT_NOT_FOUND")
      if (current.revision !== item.expectedRevision) throw new ArtifactRevisionConflictError(item.artifactId, current.revision)
      const prior = artifactTags(current.metadata.tags)
      const tags = assigned ? [...new Set([...prior, slug])] : prior.filter(tag => tag !== slug)
      if (JSON.stringify(tags) === JSON.stringify(prior)) return current
      const rawMarkdown = editArtifactTags(current.rawMarkdown, tags)
      return this.update({ artifactId: item.artifactId, expectedRevision: item.expectedRevision, rawMarkdown, metadata: parseArtifactMarkdown(rawMarkdown, true).metadata })
    })).immediate()
  }
  private structureSecret?: string
  inspectStructure(query: StructureQuery) { return new ArtifactNavigation(this).inspect(query) }
  readSection(query: SectionQuery) { return new ArtifactNavigation(this).read(query) }
  structureKey(): string {
    if (this.structureSecret) return this.structureSecret
    const existing = this.db.prepare('SELECT secret FROM artifact_structure_key WHERE id = 1').get() as { secret: string } | undefined
    if (existing) return this.structureSecret = existing.secret
    this.db.prepare('INSERT OR IGNORE INTO artifact_structure_key VALUES (1, ?)').run(randomBytes(32).toString('hex'))
    return this.structureSecret = (this.db.prepare('SELECT secret FROM artifact_structure_key WHERE id = 1').get() as { secret: string }).secret
  }
  private readonly db: Database.Database
  private readonly searchProjection: ArtifactSearchProjection
  private readonly graphIndex: ArtifactGraph
  suggestions(query: ContinuumSuggestionQuery) { return new ArtifactSuggestions(this.db, this.repositoryId).query(query) }
  graph(query: ContinuumGraphQuery = {}, options: { indexOnly?: boolean } = {}) { return this.graphIndex.query(query, filter => this.list(filter), options) }
  backfillReferences(limit = 100) { return this.graphIndex.backfill(limit) }
  facets(): ContinuumFacet[] {
    const rows = this.db.prepare(`WITH eligible AS (
      SELECT m.key, m.value_json,
        CASE WHEN m.key = 'date' THEN metadata_year(m.value_json) END AS year,
        CASE WHEN m.key = 'date' THEN metadata_month(m.value_json) END AS month
      FROM artifact_metadata m JOIN artifacts a ON a.artifact_id = m.artifact_id
      WHERE m.key NOT IN ('name', 'description', 'relations')
        AND json_type(m.value_json) IN ('text', 'integer', 'real', 'true', 'false')
        AND NOT (m.key = 'status' AND a.kind = 'OBSERVATION' AND m.value_json = '"VERIFIED_AT_BINDING"')
    ) SELECT key, CASE WHEN year IS NULL THEN value_json END AS value_json, year, month, count(*) AS count
      FROM eligible GROUP BY key, year, month, CASE WHEN year IS NULL THEN value_json END
      ORDER BY key, year DESC, month DESC, value_json`).all() as { key: string; value_json: string; year: number | null; month: number | null; count: number }[]
    const groups = new Map<string, ContinuumFacet>()
    for (const row of rows) {
      let group = groups.get(row.key)
      if (!group) { group = { key: row.key, values: [] }; groups.set(row.key, group) }
      if (row.year === null) group.values.push({ value: JSON.parse(row.value_json) as ContinuumScalar, count: row.count })
      else {
        group.years ??= []
        let year = group.years.find(entry => entry.year === row.year)
        if (!year) { year = { year: row.year, count: 0, months: [] }; group.years.push(year) }
        year.count += row.count
        year.months.push({ month: row.month!, count: row.count })
      }
    }
    return [...groups.values()]
  }
  constructor(dbPath: string, readonly repositoryId: string) {
    if (!repositoryId?.trim()) throw new Error('INVALID_ARGUMENT: canonical repositoryId is required')
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    const period = (json: unknown) => metadataPeriod(JSON.parse(String(json)))
    this.db.function('metadata_year', { deterministic: true }, json => period(json)?.year ?? null)
    this.db.function('metadata_month', { deterministic: true }, json => period(json)?.month ?? null)
    try {
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('foreign_keys = ON')
      this.db.exec(`CREATE TABLE IF NOT EXISTS repository_scope (id INTEGER PRIMARY KEY CHECK(id = 1), repository_id TEXT NOT NULL)`)
      const scope = this.db.prepare('SELECT repository_id FROM repository_scope WHERE id = 1').get() as { repository_id: string } | undefined
      if (scope && scope.repository_id !== repositoryId) throw new Error('REPOSITORY_SCOPE_MISMATCH: Store belongs to another repository')
      this.db.prepare('INSERT OR IGNORE INTO repository_scope VALUES (1, ?)').run(repositoryId)
      this.ensureSchema()
      this.publicationReceipts = new PublicationReceipts(this.db, repositoryId)
      this.publicationAssociations = new PublicationAssociations(this.db, repositoryId, id => this.publicationReceipts.read(id))
      this.tokenCache = new ArtifactTokenCache(this.db)
      this.tagIndex = new ArtifactTags(this.db)
      this.graphIndex = new ArtifactGraph(this.db, repositoryId)
      this.searchProjection = new ArtifactSearchProjection(this.db)
      this.searchProjection.schedule()
    } catch (error) { this.db.close(); throw error }
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_structure_key (id INTEGER PRIMARY KEY CHECK(id = 1), secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_structure (
        artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id), content_hash TEXT NOT NULL,
        version INTEGER NOT NULL, outline_json TEXT, integrity TEXT, failed INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 1),
        metadata_json TEXT NOT NULL, name TEXT NOT NULL, description TEXT, kind TEXT NOT NULL, status TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, raw_markdown TEXT NOT NULL,
        content_hash TEXT NOT NULL, provenance_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_order ON artifacts(updated_at DESC, artifact_id DESC);
      CREATE INDEX IF NOT EXISTS artifacts_creation_order ON artifacts(created_at DESC, artifact_id DESC);
      CREATE INDEX IF NOT EXISTS artifacts_kind ON artifacts(kind, updated_at DESC, artifact_id DESC);
      CREATE INDEX IF NOT EXISTS artifacts_status ON artifacts(status, updated_at DESC, artifact_id DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search USING fts5(name, description, content='artifacts', content_rowid='rowid', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS artifacts_search_insert AFTER INSERT ON artifacts BEGIN
        INSERT INTO artifact_search(rowid, name, description) VALUES (new.rowid, new.name, new.description);
      END;
      CREATE TRIGGER IF NOT EXISTS artifacts_search_update AFTER UPDATE ON artifacts BEGIN
        INSERT INTO artifact_search(artifact_search, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
        INSERT INTO artifact_search(rowid, name, description) VALUES (new.rowid, new.name, new.description);
      END;
      CREATE TABLE IF NOT EXISTS artifact_revisions (
        artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL, PRIMARY KEY(artifact_id, revision)
      );
      CREATE TRIGGER IF NOT EXISTS revisions_no_update BEFORE UPDATE ON artifact_revisions
        BEGIN SELECT RAISE(ABORT, 'Immutable revision'); END;
      CREATE TRIGGER IF NOT EXISTS revisions_no_delete BEFORE DELETE ON artifact_revisions
        BEGIN SELECT RAISE(ABORT, 'Immutable revision'); END;
      CREATE TABLE IF NOT EXISTS artifact_relations (
        source_id TEXT NOT NULL REFERENCES artifacts(artifact_id), target_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
        kind TEXT NOT NULL, PRIMARY KEY(source_id, target_id, kind), CHECK(source_id <> target_id)
      );
      CREATE INDEX IF NOT EXISTS relations_target ON artifact_relations(target_id, kind, source_id);
      CREATE TABLE IF NOT EXISTS artifact_metadata (
        artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), key TEXT NOT NULL, value_json TEXT NOT NULL,
        PRIMARY KEY(artifact_id, key)
      );
      CREATE INDEX IF NOT EXISTS metadata_lookup ON artifact_metadata(key, value_json, artifact_id);
      CREATE TABLE IF NOT EXISTS transport_imports (
        source TEXT NOT NULL, artifact_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(source, artifact_id)
      );
      CREATE TABLE IF NOT EXISTS legacy_migrations (source TEXT PRIMARY KEY, completed_at TEXT NOT NULL);
    ${TOKEN_CACHE_SCHEMA}
      CREATE TABLE IF NOT EXISTS repository_locators (locator TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS visual_blobs (
        sha256 TEXT PRIMARY KEY, data BLOB NOT NULL, descriptor_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_media (
        artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id), sha256 TEXT NOT NULL REFERENCES visual_blobs(sha256)
      );
      CREATE TRIGGER IF NOT EXISTS media_no_update BEFORE UPDATE ON artifact_media
        BEGIN SELECT RAISE(ABORT, 'Immutable media association'); END;
      CREATE TRIGGER IF NOT EXISTS media_no_delete BEFORE DELETE ON artifact_media
        BEGIN SELECT RAISE(ABORT, 'Immutable media association'); END;
      CREATE TABLE IF NOT EXISTS execution_identities (
        artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id),
        execution_id TEXT NOT NULL,
        assigned_revision INTEGER NOT NULL CHECK(assigned_revision >= 1),
        source TEXT NOT NULL CHECK(source IN ('PLAN_METADATA', 'BACKEND_ASSIGNED')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS execution_identities_exec ON execution_identities(execution_id);
      CREATE TABLE IF NOT EXISTS execution_activations (
        activation_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        repository_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        worktree_generation TEXT NOT NULL,
        branch_ref TEXT NOT NULL,
        branch_generation TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        plan_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
        plan_revision INTEGER NOT NULL CHECK(plan_revision >= 1),
        plan_content_hash TEXT NOT NULL,
        binding_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
        binding_revision INTEGER NOT NULL CHECK(binding_revision >= 1),
        binding_content_hash TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK(scope_kind IN ('CHECKOUT', 'REMOTE_DELEGATED')),
        status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'REVOKED', 'CLOSED')),
        activated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_reason TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS execution_activations_active_worktree
        ON execution_activations(worktree_id) WHERE status = 'ACTIVE';
      CREATE INDEX IF NOT EXISTS execution_activations_exec
        ON execution_activations(execution_id, status);
      CREATE INDEX IF NOT EXISTS execution_activations_binding
        ON execution_activations(binding_artifact_id, worktree_id);
    `)
  }

  private decode(row: ArtifactRow): Artifact {
    const executionIdentity = this.getExecutionIdentity(row.artifact_id)
    const provenance = JSON.parse(row.provenance_json) as Record<string, MetadataValue>
    return { artifactId: row.artifact_id, revision: row.revision, metadata: JSON.parse(row.metadata_json),
      createdAt: row.created_at, updatedAt: row.updated_at, rawMarkdown: row.raw_markdown,
      contentHash: row.content_hash,
      provenance: executionIdentity ? { ...provenance, executionIdentity: executionIdentity as unknown as MetadataValue } : provenance }
  }

  getExecutionIdentity(artifactId: string): ExecutionIdentityRecord | null {
    const row = this.db.prepare('SELECT execution_id, source, assigned_revision, created_at FROM execution_identities WHERE artifact_id = ?').get(artifactId) as
      { execution_id: string; source: 'PLAN_METADATA' | 'BACKEND_ASSIGNED'; assigned_revision: number; created_at: string } | undefined
    return row ? { executionId: row.execution_id, source: row.source, assignedRevision: row.assigned_revision, createdAt: row.created_at } : null
  }

  resolvePlanExecutionId(artifact: Artifact): string | undefined {
    const identity = this.getExecutionIdentity(artifact.artifactId)
    const declared = typeof artifact.metadata.executionId === 'string' && artifact.metadata.executionId.trim()
      ? artifact.metadata.executionId.trim() : undefined
    if (identity?.source === 'PLAN_METADATA' && declared && identity.executionId !== declared) throw new Error('EXECUTION_SOURCE_MISMATCH')
    if (identity && this.db.prepare('SELECT 1 FROM execution_identities WHERE execution_id = ? AND artifact_id <> ?').get(identity.executionId, artifact.artifactId)) {
      throw new Error('EXECUTION_IDENTITY_CONFLICT')
    }
    return identity?.executionId
  }

  outline(artifact: Artifact): OutlineSection[] {
    return this.db.transaction(() => {
      const current = this.get(artifact.artifactId)
      if (!current || current.revision !== artifact.revision) throw new ArtifactRevisionConflictError(artifact.artifactId, current?.revision ?? 0)
      if (computeContentHash(current.rawMarkdown) !== current.contentHash) throw new ArtifactContentIntegrityError()
      const cached = this.db.prepare('SELECT * FROM artifact_structure WHERE artifact_id = ?').get(artifact.artifactId) as
        { content_hash: string; version: number; outline_json: string | null; integrity: string | null; failed: number } | undefined
      if (cached?.content_hash === artifact.contentHash && cached.version === STRUCTURE_VERSION) {
        if (cached.failed) throw new Error('STRUCTURE_UNAVAILABLE')
        if (cached.outline_json && computeContentHash(cached.outline_json) === cached.integrity) {
          try { return JSON.parse(cached.outline_json) as OutlineSection[] } catch { /* Rebuild a damaged projection. */ }
        }
      }
      let outline: OutlineSection[]
      try { outline = extractOutline(artifact.rawMarkdown) } catch {
        this.db.prepare('INSERT OR REPLACE INTO artifact_structure VALUES (?, ?, ?, NULL, NULL, 1)').run(artifact.artifactId, artifact.contentHash, STRUCTURE_VERSION)
        return null
      }
      const json = JSON.stringify(outline)
      this.db.prepare('INSERT OR REPLACE INTO artifact_structure VALUES (?, ?, ?, ?, ?, 0)').run(artifact.artifactId, artifact.contentHash, STRUCTURE_VERSION, json, computeContentHash(json))
      return outline
    }).immediate() ?? (() => { throw new Error('STRUCTURE_UNAVAILABLE') })()
  }

  private validate(input: CreateArtifactInput, legacy: boolean, visual = false): CreateArtifactInput {
    const sourceTags = /^(?:\uFEFF)?---\r?\n/.test(input.rawMarkdown) ? parseArtifactMarkdown(input.rawMarkdown, true).metadata.tags : undefined
    if (JSON.stringify(artifactTags(sourceTags)) !== JSON.stringify(artifactTags(input.metadata.tags))) throw new Error('TAGS_SOURCE_MISMATCH')
    if (input.metadata.media !== undefined || (!visual && input.metadata.kind === 'VISUAL_REFERENCE')) throw new Error('RESERVED_VISUAL_METADATA')
    if (typeof input.artifactId !== 'string' || !input.artifactId.trim()) throw new Error('INVALID_ARGUMENT: artifactId is required')
    if (legacy) {
      if (typeof input.rawMarkdown !== 'string') throw new Error('INVALID_ARGUMENT: legacy Markdown must be a string')
    } else validateMarkdown(input.rawMarkdown)
    for (const timestamp of [input.createdAt, input.updatedAt]) if (timestamp !== undefined && !Number.isFinite(Date.parse(timestamp))) throw new Error('INVALID_ARGUMENT: invalid timestamp')
    if (input.contentHash !== undefined && input.contentHash !== computeContentHash(input.rawMarkdown)) throw new ArtifactContentIntegrityError()
    return { ...input, metadata: validateMetadata(input.metadata, legacy) }
  }

  private writeIndexes(artifact: Artifact): void {
    this.db.prepare('DELETE FROM artifact_relations WHERE source_id = ?').run(artifact.artifactId)
    const relationInsert = this.db.prepare('INSERT INTO artifact_relations(source_id, target_id, kind) VALUES (?, ?, ?)')
    for (const relation of relationsOf(artifact.metadata)) {
      if (relation.artifactId === artifact.artifactId) throw new Error('INVALID_RELATION: self relation')
      if (!this.db.prepare('SELECT 1 FROM artifacts WHERE artifact_id = ?').get(relation.artifactId)) throw new Error(`INVALID_RELATION: target "${relation.artifactId}" does not exist in this repository`)
      relationInsert.run(artifact.artifactId, relation.artifactId, relation.kind)
    }
    this.db.prepare('DELETE FROM artifact_metadata WHERE artifact_id = ?').run(artifact.artifactId)
    const insert = this.db.prepare('INSERT INTO artifact_metadata(artifact_id, key, value_json) VALUES (?, ?, ?)')
    for (const [key, value] of Object.entries(artifact.metadata)) if (value !== undefined) insert.run(artifact.artifactId, key, canonicalJson(value as MetadataValue))
    this.db.prepare('INSERT INTO artifact_revisions(artifact_id, revision, snapshot_json) VALUES (?, ?, ?)').run(artifact.artifactId, artifact.revision, JSON.stringify(artifact))
    this.tagIndex.project(artifact.artifactId, artifact.metadata.tags)
    this.graphIndex.project(artifact)
    this.searchProjection.schedule()
  }

  private createInsideTransaction(input: CreateArtifactInput, legacy = false, media?: VisualMedia): Artifact {
    input = this.validate(input, legacy, !!media)
    if (media) input = { ...input, metadata: { ...input.metadata, kind: 'VISUAL_REFERENCE', media: { ...media } } }
    if (this.db.prepare('SELECT 1 FROM artifacts WHERE artifact_id = ?').get(input.artifactId)) throw new ArtifactIdentityConflictError(input.artifactId)
    const now = new Date().toISOString()
    const artifact: Artifact = { artifactId: input.artifactId, revision: 1, metadata: input.metadata,
      rawMarkdown: input.rawMarkdown, contentHash: computeContentHash(input.rawMarkdown), createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now, provenance: input.provenance ?? {} }
    this.db.prepare(`INSERT INTO artifacts(artifact_id, revision, metadata_json, name, description, kind, status,
      created_at, updated_at, raw_markdown, content_hash, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(artifact.artifactId, 1, JSON.stringify(artifact.metadata), artifact.metadata.name, artifact.metadata.description ?? null,
        artifact.metadata.kind, artifact.metadata.status ?? null, artifact.createdAt, artifact.updatedAt,
        artifact.rawMarkdown, artifact.contentHash, JSON.stringify(artifact.provenance))
    this.writeIndexes(artifact)
    return artifact
  }
  create(input: CreateArtifactInput): Artifact { return this.db.transaction(() => this.createInsideTransaction(input)).immediate() }

  createExecutionBinding(input: CreateArtifactInput): Artifact {
    return this.db.transaction(() => {
      const metadata = input.metadata
      const source = this.get(String(metadata.sourceArtifactId))
      if (!source || source.metadata.kind !== 'EXECUTABLE_PLAN' || this.resolvePlanExecutionId(source) !== metadata.executionId || metadata.repositoryId !== this.repositoryId) throw new Error('EXECUTION_SOURCE_MISMATCH')
      const prior = this.get(input.artifactId)
      if (prior) {
        const keys = ['bindingRole', 'repositoryId', 'executionId', 'sourceArtifactId', 'branchRef', 'branchGeneration']
        if (prior.provenance.executionBranchBinding !== true || keys.some(key => prior.metadata[key] !== metadata[key])) throw new Error('EXECUTION_BINDING_CONFLICT')
        return prior
      }
      return this.createInsideTransaction({ ...input, provenance: { executionBranchBinding: true } })
    }).immediate()
  }

  private decodeActivation(row: {
    activation_id: string; revision: number; repository_id: string; worktree_id: string; worktree_generation: string
    branch_ref: string; branch_generation: string; execution_id: string; plan_artifact_id: string; plan_revision: number
    plan_content_hash: string; binding_artifact_id: string; binding_revision: number; binding_content_hash: string
    scope_kind: ExecutionActivationScopeKind; status: ExecutionActivationStatus; activated_at: string; updated_at: string
    revoked_at: string | null; revoked_reason: string | null
  }): ExecutionActivationRecord {
    return {
      activationId: row.activation_id,
      revision: row.revision,
      repositoryId: row.repository_id,
      worktreeId: row.worktree_id,
      worktreeGeneration: row.worktree_generation,
      branchRef: row.branch_ref,
      branchGeneration: row.branch_generation,
      executionId: row.execution_id,
      planArtifactId: row.plan_artifact_id,
      planRevision: row.plan_revision,
      planContentHash: row.plan_content_hash,
      bindingArtifactId: row.binding_artifact_id,
      bindingRevision: row.binding_revision,
      bindingContentHash: row.binding_content_hash,
      scopeKind: row.scope_kind,
      status: row.status,
      activatedAt: row.activated_at,
      updatedAt: row.updated_at,
      ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
      ...(row.revoked_reason ? { revokedReason: row.revoked_reason } : {})
    }
  }

  getActiveActivation(worktreeId: string): ExecutionActivationRecord | null {
    const row = this.db.prepare("SELECT * FROM execution_activations WHERE worktree_id = ? AND status = 'ACTIVE'").get(worktreeId) as
      Parameters<ArtifactStore['decodeActivation']>[0] | undefined
    return row ? this.decodeActivation(row) : null
  }

  getActivationForBinding(bindingArtifactId: string, worktreeId: string): ExecutionActivationRecord | null {
    const row = this.db.prepare('SELECT * FROM execution_activations WHERE binding_artifact_id = ? AND worktree_id = ? ORDER BY updated_at DESC, activation_id DESC LIMIT 1')
      .get(bindingArtifactId, worktreeId) as Parameters<ArtifactStore['decodeActivation']>[0] | undefined
    return row ? this.decodeActivation(row) : null
  }

  revokeActivation(input: {
    worktreeId: string
    worktreeGeneration?: string
    executionId?: string
    expectedActivationRevision?: number
    status?: 'REVOKED' | 'CLOSED'
    reason?: string
  }): ExecutionActivationRecord {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM execution_activations WHERE worktree_id = ? AND status = 'ACTIVE'").get(input.worktreeId) as
        Parameters<ArtifactStore['decodeActivation']>[0] | undefined
      if (!row) throw new Error('EXECUTION_ACTIVATION_NOT_FOUND')
      if (row.repository_id !== this.repositoryId) throw new Error('REPOSITORY_CONTEXT_CHANGED')
      if (input.worktreeGeneration !== undefined && row.worktree_generation !== input.worktreeGeneration) throw new Error('WORKTREE_STALE')
      if (input.executionId !== undefined && row.execution_id !== input.executionId) throw new Error('EXECUTION_SOURCE_MISMATCH')
      if (input.expectedActivationRevision !== undefined && row.revision !== input.expectedActivationRevision) {
        throw new Error(`REVISION_CONFLICT: activation is at revision ${row.revision}`)
      }
      const nextStatus: 'REVOKED' | 'CLOSED' = input.status === 'CLOSED' ? 'CLOSED' : 'REVOKED'
      const now = new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString()
      const reason = input.reason?.trim() || (nextStatus === 'CLOSED' ? 'EXECUTION_CLOSED' : 'EXECUTION_REVOKED')
      const updated = this.db.prepare(`UPDATE execution_activations SET status = ?, revision = ?, updated_at = ?, revoked_at = ?, revoked_reason = ?
        WHERE activation_id = ? AND revision = ? AND status = 'ACTIVE'`)
        .run(nextStatus, row.revision + 1, now, now, reason, row.activation_id, row.revision)
      if (updated.changes !== 1) throw new Error('REVISION_CONFLICT')
      const after = this.db.prepare('SELECT * FROM execution_activations WHERE activation_id = ?').get(row.activation_id) as Parameters<ArtifactStore['decodeActivation']>[0]
      return this.decodeActivation(after)
    }).immediate()
  }

  bootstrapExecutionBinding(input: {
    planArtifactId: string
    expectedPlanRevision?: number
    executionId?: string
    snapshot: ExecutionBranchSnapshot
    scopeKind?: ExecutionActivationScopeKind
    activate?: boolean
    expectedActivationRevision?: number
    buildBinding: (executionId: string, plan: Artifact) => CreateArtifactInput
  }): { plan: Artifact; binding: Artifact; executionId: string; activation?: ExecutionActivationRecord; reused: boolean } {
    return this.db.transaction(() => {
      const plan = this.get(input.planArtifactId)
      if (!plan || plan.metadata.kind !== 'EXECUTABLE_PLAN') throw new Error('EXECUTION_SOURCE_MISMATCH')
      if (input.snapshot.repositoryId !== this.repositoryId) throw new Error('EXECUTION_SOURCE_MISMATCH')
      if (input.expectedPlanRevision !== undefined && plan.revision !== input.expectedPlanRevision) {
        throw new ArtifactRevisionConflictError(plan.artifactId, plan.revision)
      }
      const existingIdentity = this.getExecutionIdentity(plan.artifactId)
      const knownId = this.resolvePlanExecutionId(plan)
      if (input.executionId !== undefined && input.executionId !== knownId) throw new Error('EXECUTION_SOURCE_MISMATCH')
      if (input.activate === false && !knownId) throw new Error('EXECUTION_SOURCE_MISMATCH')
      const now = new Date().toISOString()
      const executionId = knownId ?? ('exec-' + randomUUID())
      if (!existingIdentity) {
        this.db.prepare('INSERT INTO execution_identities(artifact_id, execution_id, assigned_revision, source, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(plan.artifactId, executionId, plan.revision, 'BACKEND_ASSIGNED', now)
      }
      const bindingInput = input.buildBinding(executionId, plan)
      if (bindingInput.metadata.repositoryId !== this.repositoryId || bindingInput.metadata.executionId !== executionId || bindingInput.metadata.sourceArtifactId !== plan.artifactId) {
        throw new Error('EXECUTION_SOURCE_MISMATCH')
      }
      let binding = this.get(bindingInput.artifactId)
      let bindingCreated = false
      if (binding) {
        const keys = ['bindingRole', 'repositoryId', 'executionId', 'sourceArtifactId', 'branchRef', 'branchGeneration']
        if (binding.provenance.executionBranchBinding !== true || keys.some(key => binding!.metadata[key] !== bindingInput.metadata[key])) {
          throw new Error('EXECUTION_BINDING_CONFLICT')
        }
      } else {
        binding = this.createInsideTransaction({ ...bindingInput, provenance: { executionBranchBinding: true } })
        bindingCreated = true
      }
      const resolvedPlan = this.get(plan.artifactId)!
      if (input.activate === false) {
        return { plan: resolvedPlan, binding, executionId, reused: !bindingCreated }
      }
      const active = this.db.prepare("SELECT * FROM execution_activations WHERE worktree_id = ? AND status = 'ACTIVE'")
        .get(input.snapshot.worktreeId) as Parameters<ArtifactStore['decodeActivation']>[0] | undefined
      if (active) {
        if (active.execution_id !== executionId || active.plan_artifact_id !== plan.artifactId) {
          throw new Error('EXECUTION_ACTIVATION_CONFLICT')
        }
        if (input.expectedActivationRevision !== undefined && active.revision !== input.expectedActivationRevision) {
          throw new Error(`REVISION_CONFLICT: activation is at revision ${active.revision}`)
        }
        if (active.worktree_generation === input.snapshot.worktreeGeneration &&
          active.branch_ref === input.snapshot.branchRef &&
          active.branch_generation === input.snapshot.branchGeneration &&
          active.plan_revision === plan.revision &&
          active.plan_content_hash === plan.contentHash &&
          active.binding_artifact_id === binding.artifactId &&
          active.binding_revision === binding.revision) {
          return { plan: resolvedPlan, binding, executionId, activation: this.decodeActivation(active), reused: true }
        }
        const revokedAt = new Date(Math.max(Date.now(), Date.parse(active.updated_at) + 1)).toISOString()
        this.db.prepare("UPDATE execution_activations SET status = 'REVOKED', revision = ?, updated_at = ?, revoked_at = ?, revoked_reason = ? WHERE activation_id = ? AND revision = ?")
          .run(active.revision + 1, revokedAt, revokedAt, 'SUPERSEDED_BY_CONTINUATION', active.activation_id, active.revision)
      } else if (input.expectedActivationRevision !== undefined) {
        throw new Error('EXECUTION_ACTIVATION_NOT_FOUND')
      }
      const activationId = 'act-' + randomUUID()
      const scopeKind: ExecutionActivationScopeKind = input.scopeKind ?? 'CHECKOUT'
      this.db.prepare(`INSERT INTO execution_activations(
        activation_id, revision, repository_id, worktree_id, worktree_generation, branch_ref, branch_generation,
        execution_id, plan_artifact_id, plan_revision, plan_content_hash, binding_artifact_id, binding_revision,
        binding_content_hash, scope_kind, status, activated_at, updated_at, revoked_at, revoked_reason
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, NULL, NULL)`)
        .run(activationId, this.repositoryId, input.snapshot.worktreeId, input.snapshot.worktreeGeneration,
          input.snapshot.branchRef, input.snapshot.branchGeneration, executionId, plan.artifactId, plan.revision,
          plan.contentHash, binding.artifactId, binding.revision, binding.contentHash, scopeKind, now, now)
      const created = this.db.prepare('SELECT * FROM execution_activations WHERE activation_id = ?').get(activationId) as Parameters<ArtifactStore['decodeActivation']>[0]
      return { plan: resolvedPlan, binding, executionId, activation: this.decodeActivation(created), reused: false }
    }).immediate()
  }

  createVisual(input: CreateArtifactInput, data: Buffer, media: VisualMedia): Artifact {
    if (input.metadata.kind !== 'VISUAL_REFERENCE') throw new Error('RESERVED_VISUAL_METADATA')
    const dimensions = inspectWebP(data)
    if (media.sha256 !== mediaHash(data) || media.bytes !== data.length || dimensions.width !== media.width || dimensions.height !== media.height || media.mimeType !== 'image/webp' || media.lossless !== true || media.animated !== false) throw new Error('VISUAL_INTEGRITY_ERROR')
    return this.db.transaction(() => {
      const artifact = this.createInsideTransaction(input, false, media)
      this.db.prepare('INSERT OR IGNORE INTO visual_blobs VALUES (?, ?, ?)').run(media.sha256, data, JSON.stringify(media))
      this.db.prepare('INSERT INTO artifact_media VALUES (?, ?)').run(artifact.artifactId, media.sha256)
      this.getVisual(artifact.artifactId)
      return artifact
    }).immediate()
  }

  getVisual(artifactId: string): VisualArtifact {
    const artifact = this.get(artifactId)
    if (!artifact) throw new Error('ARTIFACT_NOT_FOUND')
    const row = this.db.prepare(`SELECT b.sha256, b.data, b.descriptor_json FROM artifact_media m
      JOIN visual_blobs b ON b.sha256 = m.sha256 WHERE m.artifact_id = ?`).get(artifactId) as { sha256: string; data: Buffer; descriptor_json: string } | undefined
    if (!row) throw new Error('VISUAL_MEDIA_NOT_FOUND')
    try {
      const media = JSON.parse(row.descriptor_json) as VisualMedia
      const dimensions = inspectWebP(row.data)
      if (artifact.metadata.kind !== 'VISUAL_REFERENCE' || media.mimeType !== 'image/webp' || media.lossless !== true || media.animated !== false || media.sha256 !== row.sha256 || mediaHash(row.data) !== row.sha256 || media.bytes !== row.data.length || dimensions.width !== media.width || dimensions.height !== media.height || canonicalJson(artifact.metadata.media as MetadataValue) !== canonicalJson(media as unknown as MetadataValue)) throw new Error()
      return { artifact, media, data: row.data }
    } catch { throw new Error('VISUAL_INTEGRITY_ERROR') }
  }

  update(input: UpdateArtifactInput): Artifact {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('INVALID_ARGUMENT: expectedRevision must be an integer >= 1')
    return this.db.transaction(() => {
      const current = this.get(input.artifactId)
      if (!current) throw new Error('ARTIFACT_NOT_FOUND: ' + input.artifactId)
      if (current.provenance.executionBranchBinding === true) throw new Error('IMMUTABLE_EXECUTION_BINDING')
      if (current.revision !== input.expectedRevision) throw new ArtifactRevisionConflictError(input.artifactId, current.revision)
      const visual = current.metadata.kind === 'VISUAL_REFERENCE'
      if (visual && input.metadata.kind !== 'VISUAL_REFERENCE') throw new Error('IMMUTABLE_VISUAL_KIND')
      const checked = this.validate(input, false, visual)
      if (visual) checked.metadata = { ...checked.metadata, media: current.metadata.media }
      const existingIdentity = this.getExecutionIdentity(input.artifactId)
      if (existingIdentity && checked.metadata.kind !== 'EXECUTABLE_PLAN' ||
        existingIdentity?.source === 'PLAN_METADATA' && checked.metadata.executionId !== undefined && checked.metadata.executionId !== existingIdentity.executionId) {
        throw new Error('EXECUTION_SOURCE_MISMATCH')
      }
      const { executionIdentity: _omittedIdentity, deliveryContext: _anchor, sessionWitness: _witness, ...currentProvenance } = current.provenance
      const artifact: Artifact = { ...current, metadata: checked.metadata, rawMarkdown: checked.rawMarkdown,
        provenance: { ...currentProvenance, ...input.provenance },
        revision: current.revision + 1, updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString(),
        contentHash: computeContentHash(checked.rawMarkdown) }
      this.db.prepare(`UPDATE artifacts SET revision = ?, metadata_json = ?, name = ?, description = ?, kind = ?, status = ?,
        updated_at = ?, raw_markdown = ?, content_hash = ?, provenance_json = ? WHERE artifact_id = ? AND revision = ?`)
        .run(artifact.revision, JSON.stringify(artifact.metadata), artifact.metadata.name, artifact.metadata.description ?? null,
          artifact.metadata.kind, artifact.metadata.status ?? null, artifact.updatedAt, artifact.rawMarkdown,
          artifact.contentHash, JSON.stringify(artifact.provenance), artifact.artifactId, input.expectedRevision)
      this.writeIndexes(artifact)
      return existingIdentity ? { ...artifact, provenance: { ...artifact.provenance, executionIdentity: existingIdentity as unknown as MetadataValue } } : artifact
    }).immediate()
  }
  get(artifactId: string): Artifact | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(artifactId) as ArtifactRow | undefined
    return row ? this.decode(row) : null
  }
  getRevision(artifactId: string, revision: number): Artifact | null {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('INVALID_ARTIFACT_REVISION')
    const row = this.db.prepare('SELECT snapshot_json FROM artifact_revisions WHERE artifact_id=? AND revision=?').get(artifactId, revision) as { snapshot_json: string } | undefined
    if (!row) return null
    const artifact = JSON.parse(row.snapshot_json) as Artifact
    if (artifact.artifactId !== artifactId || artifact.revision !== revision || computeContentHash(artifact.rawMarkdown) !== artifact.contentHash) throw new Error('ARTIFACT_REVISION_INTEGRITY')
    const executionIdentity = this.getExecutionIdentity(artifactId)
    return executionIdentity ? { ...artifact, provenance: { ...artifact.provenance, executionIdentity: executionIdentity as unknown as MetadataValue } } : artifact
  }

  private catalogConditions(filter: ListArtifactsFilter, kinds?: readonly string[]) {
    if (filter.tag !== undefined) validateTagSlug(filter.tag)
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (kinds?.length) {
      clauses.push(`a.kind IN (${kinds.map(() => '?').join(',')})`)
      params.push(...kinds)
    }
    if (filter.tag !== undefined) { clauses.push('a.artifact_id IN (SELECT artifact_id FROM artifact_tags WHERE slug = ?)'); params.push(filter.tag) }
    for (const key of ['kind', 'status'] as const) if (filter[key] !== undefined) { clauses.push(`a.${key} = ?`); params.push(filter[key]!) }
    if (filter.query) {
      if ([...filter.query].length >= 3) { clauses.push('a.rowid IN (SELECT rowid FROM artifact_search WHERE artifact_search MATCH ?)'); params.push('"' + filter.query.replace(/"/g, '""') + '"') }
      clauses.push('(instr(lower(a.name), lower(?)) > 0 OR instr(lower(coalesce(a.description, \'\')), lower(?)) > 0)')
      params.push(filter.query, filter.query)
    }
    for (const [key, value] of Object.entries(filter.metadata ?? {})) {
      if (key === 'executionId' && typeof value === 'string') {
        clauses.push('(a.artifact_id IN (SELECT artifact_id FROM artifact_metadata WHERE key = ? AND value_json = ?) OR a.artifact_id IN (SELECT artifact_id FROM execution_identities WHERE execution_id = ?))')
        params.push(key, canonicalJson(normalizeMetadataValue(value)), value)
      } else {
        clauses.push('a.artifact_id IN (SELECT artifact_id FROM artifact_metadata WHERE key = ? AND value_json = ?)')
        params.push(key, canonicalJson(normalizeMetadataValue(value)))
      }
    }
    for (const [key, period] of Object.entries(filter.periods ?? {})) {
      clauses.push(`a.artifact_id IN (SELECT artifact_id FROM artifact_metadata WHERE key = ? AND metadata_year(value_json) = ?${period.month !== undefined ? ' AND metadata_month(value_json) = ?' : ''})`)
      params.push(key, period.year)
      if (period.month !== undefined) params.push(period.month)
    }
    for (const [key, operator] of [['updatedAfter', '>='], ['updatedBefore', '<=']] as const) {
      if (filter[key]) {
        if (!Number.isFinite(Date.parse(filter[key]!))) throw new Error('INVALID_ARGUMENT: invalid ' + key)
        clauses.push(`a.updated_at ${operator} ?`); params.push(new Date(filter[key]!).toISOString())
      }
    }
    if (filter.relatedToArtifactId) {
      if (!this.db.prepare('SELECT 1 FROM artifacts WHERE artifact_id = ?').get(filter.relatedToArtifactId)) throw new Error('ARTIFACT_NOT_FOUND: ' + filter.relatedToArtifactId)
      const direction = filter.direction ?? 'both'
      const parts: string[] = []
      for (const [selection, match] of direction === 'outbound' ? [['target_id', 'source_id']] : direction === 'inbound' ? [['source_id', 'target_id']] : [['target_id', 'source_id'], ['source_id', 'target_id']]) {
        parts.push(`SELECT ${selection} FROM artifact_relations WHERE ${match} = ?${filter.relationKind ? ' AND kind = ?' : ''}`)
        params.push(filter.relatedToArtifactId)
        if (filter.relationKind) params.push(filter.relationKind)
      }
      clauses.push(`a.artifact_id IN (${parts.join(' UNION ')})`)
    } else if (filter.direction || filter.relationKind) throw new Error('INVALID_ARGUMENT: relation filters require relatedToArtifactId')
    return { clauses, params }
  }

  searchHealth() { return { repositoryId: this.repositoryId, ...this.searchProjection.health() } }

  searchArtifacts(input: unknown) {
    const query = artifactSearchQuery(input)
    const { kind, status, tag, metadata, updatedAfter, updatedBefore } = query
    const { clauses, params } = this.catalogConditions({ kind, status, tag, metadata, updatedAfter, updatedBefore })
    const navigation = new ArtifactNavigation(this)
    const key = this.structureKey()
    return this.db.transaction(() => searchArtifacts(this.db, this.repositoryId, navigation, key,
      this.searchProjection.available, query, clauses, params))()
  }

  list(filter: ListArtifactsFilter = {}, options: { kinds?: readonly string[] } = {}): ArtifactPage {
    if (filter.sortBy !== undefined && filter.sortBy !== 'createdAt' && filter.sortBy !== 'updatedAt') throw new Error('INVALID_ARGUMENT: invalid sortBy')
    if (filter.includeTags !== undefined && typeof filter.includeTags !== 'boolean') throw new Error('INVALID_ARGUMENT: includeTags must be boolean')
    const timestampKey = filter.sortBy === 'createdAt' ? 'createdAt' : 'updatedAt'
    const timestampColumn = timestampKey === 'createdAt' ? 'created_at' : 'updated_at'
    validatePeriods(filter.periods, filter.metadata)
    const limit = filter.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_ARGUMENT: limit must be 1-100')
    if (filter.direction && !['inbound', 'outbound', 'both'].includes(filter.direction)) throw new Error('INVALID_ARGUMENT: invalid direction')
    if (filter.metadataKeys && (filter.metadataKeys.length > 20 || filter.metadataKeys.some(key => typeof key !== 'string' || !key.trim() || ['__proto__', 'constructor', 'prototype'].includes(key)))) throw new Error('INVALID_ARGUMENT: invalid metadataKeys')
    const { clauses, params } = this.catalogConditions(filter, options.kinds)
    const { cursor: omittedCursor, limit: omittedLimit, metadataKeys: omittedKeys, includeRawMarkdownTokenCount, sortBy, includeTags, ...legacySelection } = filter
    const selection = { ...legacySelection, ...(sortBy === 'createdAt' ? { sortBy } : {}), ...(options.kinds ? { kinds: options.kinds } : {}) }
    const signature = computeContentHash(this.repositoryId + ':' + canonicalJson(normalizeMetadataValue(selection)))
    if (filter.cursor) {
      let cursor: { createdAt?: string; updatedAt?: string; artifactId: string; signature: string }
      try { cursor = JSON.parse(Buffer.from(filter.cursor, 'base64url').toString('utf8')) } catch { throw new Error('INVALID_ARGUMENT: invalid cursor') }
      if (!cursor || cursor.signature !== signature || typeof cursor[timestampKey] !== 'string' || typeof cursor.artifactId !== 'string') throw new Error('INVALID_ARGUMENT: cursor does not match repository or filters')
      clauses.push(`(a.${timestampColumn} < ? OR (a.${timestampColumn} = ? AND a.artifact_id < ?))`); params.push(cursor[timestampKey]!, cursor[timestampKey]!, cursor.artifactId)
    }
    const rows = this.db.prepare(`SELECT a.artifact_id, a.revision, a.content_hash, a.name, a.description, a.kind, a.status, a.updated_at,
      ${timestampKey === 'createdAt' ? 'a.created_at,' : ''}
      (SELECT count(*) FROM artifact_relations r WHERE r.source_id = a.artifact_id OR r.target_id = a.artifact_id) AS relation_count
      FROM artifacts a ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
      ORDER BY a.${timestampColumn} DESC, a.artifact_id DESC LIMIT ?`).all(...params, limit + 1) as DiscoveryRow[]
    const more = rows.length > limit
    const selected = rows.slice(0, limit)
    const tagsByArtifact = new Map<string, string[]>()
    if (includeTags && selected.length) {
      const memberships = this.db.prepare(`SELECT artifact_id, slug FROM artifact_tags WHERE artifact_id IN (${selected.map(() => '?').join(',')}) ORDER BY artifact_id, slug`)
        .all(...selected.map(row => row.artifact_id)) as { artifact_id: string; slug: string }[]
      for (const { artifact_id, slug } of memberships) {
        const tags = tagsByArtifact.get(artifact_id) ?? []
        tags.push(slug); tagsByArtifact.set(artifact_id, tags)
      }
    }
    const artifacts: ArtifactDiscoveryRecord[] = selected.map(row => {
      const record: ArtifactDiscoveryRecord = { revision: row.revision, artifactId: row.artifact_id, name: row.name, kind: row.kind,
        updatedAt: row.updated_at, relationCount: row.relation_count,
        ...(timestampKey === 'createdAt' ? { createdAt: row.created_at } : {}),
        ...(includeTags ? { tags: tagsByArtifact.get(row.artifact_id) ?? [] } : {}),
        ...(row.description !== null ? { description: row.description } : {}), ...(row.status !== null ? { status: row.status } : {}) }
      if (filter.metadataKeys?.length) {
        record.metadata = Object.create(null) as Record<string, MetadataValue>
        const find = this.db.prepare('SELECT value_json FROM artifact_metadata WHERE artifact_id = ? AND key = ?')
        for (const key of filter.metadataKeys) {
          const value = find.get(row.artifact_id, key) as { value_json: string } | undefined
          if (value) record.metadata[key] = JSON.parse(value.value_json)
          else if (key === 'executionId') {
            const identity = this.getExecutionIdentity(row.artifact_id)
            if (identity) record.metadata[key] = identity.executionId
          }
        }
      }
      return record
    })
    const last = selected[selected.length - 1]
    const nextCursor = more ? Buffer.from(JSON.stringify({ [timestampKey]: last[timestampColumn], artifactId: last.artifact_id, signature })).toString('base64url') : undefined
    if (includeRawMarkdownTokenCount === true && selected.length > 0) {
      const entries = selected.map(row => ({ artifactId: row.artifact_id, revision: row.revision, contentHash: row.content_hash }))
      const counts = this.measureTokenCountBatch(entries)
      const tokenizer = counts.size > 0 ? [...counts.values()][0] : undefined
      for (const record of artifacts) {
        const result = counts.get(record.artifactId)
        if (result !== undefined) record.rawMarkdownTokenCount = result.rawMarkdownTokenCount
      }
      return { artifacts, ...(nextCursor ? { nextCursor } : {}), ...(tokenizer ? { tokenizerId: tokenizer.tokenizerId, tokenizerEncoding: tokenizer.tokenizerEncoding } : {}) }
    }
    return { artifacts, ...(nextCursor ? { nextCursor } : {}) }
  }

  importArtifact(source: string, input: CreateArtifactInput): Artifact {
    input = this.validate(input, input.metadata.description === undefined)
    const fingerprint = computeContentHash(canonicalJson(normalizeMetadataValue(input)))
    return this.db.transaction(() => {
      const receipt = this.db.prepare('SELECT fingerprint FROM transport_imports WHERE source = ? AND artifact_id = ?').get(source, input.artifactId) as { fingerprint: string } | undefined
      if (receipt) { if (receipt.fingerprint !== fingerprint) throw new ArtifactIdentityConflictError(input.artifactId); return this.get(input.artifactId)! }
      const existing = this.get(input.artifactId)
      let artifact: Artifact
      if (existing) {
        const original = this.db.prepare('SELECT snapshot_json FROM artifact_revisions WHERE artifact_id = ? AND revision = 1').get(input.artifactId) as { snapshot_json: string }
        const initial = JSON.parse(original.snapshot_json) as Artifact
        const { ingestedAt, ...initialProvenance } = initial.provenance
        const { ingestedAt: incomingIngestedAt, ...incomingProvenance } = input.provenance ?? {}
        if (initial.rawMarkdown !== input.rawMarkdown || initial.createdAt !== input.createdAt ||
          canonicalJson(initial.metadata as MetadataValue) !== canonicalJson(input.metadata as MetadataValue) ||
          canonicalJson(initialProvenance) !== canonicalJson(incomingProvenance)) throw new ArtifactIdentityConflictError(input.artifactId)
        artifact = existing
      } else artifact = this.createInsideTransaction(input, input.metadata.description === undefined)
      this.db.prepare('INSERT INTO transport_imports VALUES (?, ?, ?)').run(source, input.artifactId, fingerprint)
      return artifact
    }).immediate()
  }
  measureTokenCount(artifactId: string, revision: number, contentHash: string, rawMarkdown: string) {
    const current = this.get(artifactId)
    if (!current || current.revision !== revision || current.contentHash !== contentHash) {
      throw new ArtifactRevisionConflictError(artifactId, current?.revision ?? 0)
    }
    if (computeContentHash(rawMarkdown) !== contentHash) {
      throw new ArtifactContentIntegrityError()
    }
    return this.tokenCache.measure(artifactId, revision, contentHash, rawMarkdown)
  }

  measureTokenCountBatch(entries: Array<{ artifactId: string; revision: number; contentHash: string }>) {
    return this.db.transaction(() => {
      const currentRows = this.db.prepare(
        `SELECT artifact_id, revision, content_hash FROM artifacts WHERE artifact_id IN (${entries.map(() => '?').join(',')})`
      ).all(...entries.map(e => e.artifactId)) as { artifact_id: string; revision: number; content_hash: string }[]

      const currentMap = new Map(currentRows.map(r => [r.artifact_id, r]))
      for (const entry of entries) {
        const current = currentMap.get(entry.artifactId)
        if (!current || current.revision !== entry.revision || current.content_hash !== entry.contentHash) {
          throw new ArtifactRevisionConflictError(entry.artifactId, current?.revision ?? 0)
        }
      }

      const loadMarkdown = (misses: Array<{ artifactId: string; revision: number; contentHash: string }>) => {
        const map = new Map<string, string>()
        if (misses.length === 0) return map
        const missRows = this.db.prepare(
          `SELECT artifact_id, revision, content_hash, raw_markdown FROM artifacts WHERE artifact_id IN (${misses.map(() => '?').join(',')})`
        ).all(...misses.map(m => m.artifactId)) as { artifact_id: string; revision: number; content_hash: string; raw_markdown: string }[]
        const missMap = new Map(missRows.map(r => [r.artifact_id, r]))
        for (const miss of misses) {
          const row = missMap.get(miss.artifactId)
          if (!row || row.revision !== miss.revision || row.content_hash !== miss.contentHash) {
            throw new ArtifactRevisionConflictError(miss.artifactId, row?.revision ?? 0)
          }
          if (computeContentHash(row.raw_markdown) !== miss.contentHash) {
            throw new ArtifactContentIntegrityError()
          }
          map.set(miss.artifactId, row.raw_markdown)
        }
        return map
      }

      return this.tokenCache.measureBatch(entries, loadMarkdown)
    }).immediate()
  }

  migrationComplete(source: string): boolean { return !!this.db.prepare('SELECT 1 FROM legacy_migrations WHERE source = ?').get(source) }
  completeMigration(source: string): void { this.db.prepare('INSERT OR IGNORE INTO legacy_migrations VALUES (?, ?)').run(source, new Date().toISOString()) }
  registerLocator(locator: string): void { this.db.prepare('INSERT OR IGNORE INTO repository_locators VALUES (?)').run(locator) }
  hasLocator(locator: string): boolean { return !!this.db.prepare('SELECT 1 FROM repository_locators WHERE locator = ?').get(locator) }
  close(): void {
    this.searchProjection.stop()
    if (this.db.open) this.db.close()
  }
}
