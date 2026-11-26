import { createHash, randomUUID } from 'node:crypto'
import { deliveryAnchor, deliveryContextRequest, resolveEffectiveDeliveryContext, sameDeliveryRequest, type DeliveryContextRequest, type DeliveryAnchor, type DeliveryProjectionPage, type ExecutionActivationScopeKind, type ObserveDelivery } from '../../shared/types/delivery-context-types'
import type { ExecutionBranchSnapshot } from '../../shared/types/execution-branch-types'
import type { ContinuumGraphQuery } from '../../shared/types/continuum-graph-types'
import type { ContinuumSuggestionQuery } from '../../shared/types/continuum-suggestion-types'
import sharp from 'sharp'
import type { Artifact, ArtifactReceipt, CreateArtifactInput, IContinuumService, ListArtifactsFilter, ArtifactPage, IArtifactGraphReader, IArtifactSuggestionReader } from './continuum-types'
import type { TransportEnvelope } from './artifact-envelope'
import { ArtifactStore } from './artifact-store'
import type { PublicationReceiptContext } from './publication-receipts'
import { canonicalJson, normalizeMetadataValue, parseArtifactMarkdown } from './artifact-metadata'
import { canonicalizePublication } from './artifact-publication'
import type { ArtifactPublicationFields, ArtifactSemanticFields, PublicationReceipt } from './continuum-types'
import { publicationRequestDigest } from '../../shared/types/publication-provenance-types'
import type { PublicationAssociation } from '../../shared/types/publication-provenance-types'
import { legacyInput } from './legacy-artifact-migrator'
import { validateVisualMedia } from './visual-media'
import type { IVisualContinuumService, VisualArtifactReceipt } from './continuum-types'
import { artifactTags, type ContinuumTagMutation, type ContinuumTagAssignment } from '../../shared/types/continuum-tag-types'
import { ContextBundle } from './context-bundle'
import { lifecyclePolicy, lifecycleProjection, type LifecycleDependencies } from './artifact-lifecycle-policy'
import { lifecycleDigest, lifecycleReasonFor, lifecycleReceipt, transitionLifecycle, type LifecycleRequest } from './artifact-lifecycle'
import { assertArtifactAgent, authenticatedAgentPrincipal, authorizeArtifactAgent, type AgentAuthority } from './agent-authority'
import { getCanonicalTokenizer } from '../core/tokenizer'
import type { ContinuumTagTokens } from '../../shared/types/continuum-ui-types'

export class ContinuumService implements IContinuumService, IVisualContinuumService, IArtifactGraphReader, IArtifactSuggestionReader {
  private readonly preparedMembership = new WeakMap<DeliveryAnchor, NonNullable<PublicationReceiptContext['activation']>>()
  get repositoryId() { return this.store.repositoryId }
  private async prepareAuthorityDelivery(authority: AgentAuthority | undefined, observeDelivery?: ObserveDelivery): Promise<PublicationReceiptContext | undefined> {
    if (!authority) return undefined
    const resolved = await this.resolveExecutionContext(authority, undefined, observeDelivery)
    const anchor = resolved.anchor
    return anchor || authority.sessionWitness
      ? { ...(anchor ? { deliveryContext: anchor, activation: this.preparedMembership.get(anchor) } : {}), ...(authority.sessionWitness ? { sessionWitness: authority.sessionWitness } : {}) }
      : undefined
  }
  async transitionLifecycle(request: LifecycleRequest, connected: () => boolean = () => true, authority?: AgentAuthority, observeDelivery?: ObserveDelivery) {
    const assertContext = () => { this.assertActive(); if (!connected()) throw new Error('IPC_CLOSED'); if (authority) assertArtifactAgent(authority, this.store.repositoryId) }
    assertContext(); this.reconcile?.(); assertContext()
    const receiptContext = request.action === 'ASSESS' ? undefined : await this.prepareAuthorityDelivery(authority, observeDelivery)
    const result = await transitionLifecycle(this.store, this.lifecycleDependencies, request, assertContext, authority, undefined, receiptContext)
    if (result.state === 'PERSISTED' && !result.replayed) this.changed()
    return result
  }
  createTag(request: { name: string; description?: string; selected?: ContinuumTagAssignment[] }) {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    if (request.selected && request.selected.length !== 1) throw new Error('TAG_SELECTION_LIMIT: one explicitly requested Artifact per call')
    const result = this.store.createQuickTag(request.name, request.selected, request.description)
    this.changed()
    return { state: 'PERSISTED' as const, creation: result.state, tag: result.tag, artifacts: result.artifacts.map(artifact => this.receipt(artifact)) }
  }
  assignTag(request: { slug: string; selected: ContinuumTagAssignment[]; operation: 'add' | 'remove' }) {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    if (request.selected.length !== 1 || !['add', 'remove'].includes(request.operation)) throw new Error('TAG_SELECTION_LIMIT: one explicitly requested Artifact per call')
    const artifacts = this.store.assignTag(request.slug, request.selected, request.operation === 'add')
    this.changed()
    return { state: 'PERSISTED' as const, slug: request.slug, artifacts: artifacts.map(artifact => this.receipt(artifact)) }
  }
  async createContextBundle(request: { tag: string; action: 'preview' | 'copy' | 'markdown' | 'zip' }, connected: () => boolean = () => true) {
    this.assertActive()
    const bundle = ContextBundle.prepare(this, { repositoryId: this.store.repositoryId, slug: request.tag })
    const assertContext = () => { this.assertActive(); if (!connected()) throw new Error('IPC_CLOSED'); bundle.assertFresh() }
    assertContext()
    if (!bundle.preview.members.length) throw new Error('BUNDLE_EMPTY')
    const result = request.action === 'preview' ? { outcome: 'preview' as const, snapshotId: bundle.preview.snapshotId }
      : await (await import('./bundle-export.js')).exportAgentContextBundle(bundle, request.action, assertContext)
    const { repositoryId, slug, markdownBytes, tokenCount, tokenizerEncoding, hasVisuals, members } = bundle.preview
    return { ...result, repositoryId, slug, count: members.length, markdownBytes, tokenCount, tokenizerEncoding, hasVisuals }
  }
  tags() { this.assertActive(); this.reconcile?.(); this.assertActive(); return this.store.tags() }
  assertRepository(repositoryId: string) { this.assertActive(); if (repositoryId !== this.store.repositoryId) throw new Error('REPOSITORY_CONTEXT_CHANGED') }
  assertSelection(selected: import('../../shared/types/continuum-ui-types').ContinuumSelectedArtifact[]) { this.assertActive(); this.store.selectionEntries(selected) }
  assertBuilderSelection(selected: import('../../shared/types/continuum-ui-types').ContinuumSelectedArtifact[]) { this.assertActive(); this.store.builderEntries(selected) }
  async resolveBuilderComponent(repositoryId: string, source: import('../../shared/types/continuum-builder-types').BundleComponentSource, refresh = false) {
    this.assertRepository(repositoryId)
    this.reconcile?.()
    if (!source || !['artifact', 'query'].includes(source.kind) || Buffer.byteLength(JSON.stringify(source), 'utf8') > 2 * 1024 * 1024) throw new Error('INVALID_BUNDLE_COMPONENT')
    if (source.kind === 'query' && (!source.filter || typeof source.filter !== 'object' || Array.isArray(source.filter) || Object.keys(source.filter).some(key => !['tag', 'query', 'metadata', 'periods'].includes(key)))) throw new Error('INVALID_BUNDLE_QUERY')
    if (source.kind === 'artifact' && (!Array.isArray(source.selected) || !source.selected.length)) throw new Error('INVALID_SELECTION')
    const members = source.kind === 'query' ? this.store.resolveBuilderGroup(source.filter)
      : source.selected.map(item => {
        if (!refresh) this.store.selectionEntries([item])
        const current = this.store.get(item.artifactId)
        if (!current) throw new Error('ARTIFACT_NOT_FOUND: ' + item.artifactId)
        return { artifactId: current.artifactId, revision: current.revision, name: current.metadata.name, kind: current.metadata.kind, status: current.metadata.status, updatedAt: current.updatedAt, relationCount: current.metadata.relations?.length ?? 0 }
      })
    if (!members.length) {
      if (refresh) return { id: randomUUID(), source: structuredClone(source), members: [] }
      throw new Error('BUNDLE_EMPTY')
    }
    const selected = members.map(item => ({ artifactId: item.artifactId, expectedRevision: item.revision! }))
    const counts = new Map((await this.selectionTokens(selected, true)).map(item => [item.artifactId, item.rawMarkdownTokenCount]))
    this.assertRepository(repositoryId)
    return { id: randomUUID(), source: source.kind === 'artifact' ? { kind: 'artifact' as const, selected } : structuredClone(source), members: members.map(item => ({ ...item, rawMarkdownTokenCount: counts.get(item.artifactId) })) }
  }
  resolveSelection(filter: ListArtifactsFilter) {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    return this.store.resolveSelection(filter)
  }
  async selectionTokens(selected: import('../../shared/types/continuum-ui-types').ContinuumSelectedArtifact[], builder = false) {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    const entries = builder ? this.store.builderEntries(selected) : this.store.selectionEntries(selected)
    const artifacts: Array<{ artifactId: string; rawMarkdownTokenCount: number }> = []
    for (let offset = 0; offset < entries.length; offset += 30) {
      await new Promise<void>(resolve => setImmediate(resolve)); this.assertActive()
      for (const [artifactId, result] of this.store.measureTokenCountBatch(entries.slice(offset, offset + 30))) artifacts.push({ artifactId, rawMarkdownTokenCount: result.rawMarkdownTokenCount })
    }
    this.assertActive(); if (builder) this.store.builderEntries(selected); else this.store.selectionEntries(selected)
    return artifacts
  }
  async tagTokenTotals(slugs: string[]): Promise<ContinuumTagTokens[]> {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    const members = this.store.tagTokenMembers(slugs)
    const tags = this.store.tags().filter(tag => slugs.includes(tag.slug))
    const unique = [...new Map(members.map(member => [member.artifactId, member])).values()]
    const counts = new Map<string, number>()
    const tokenizer = getCanonicalTokenizer()
    for (let offset = 0; offset < unique.length; offset += 30) {
      await new Promise<void>(resolve => setImmediate(resolve))
      this.assertActive()
      for (const [id, result] of this.store.measureTokenCountBatch(unique.slice(offset, offset + 30))) counts.set(id, result.rawMarkdownTokenCount)
    }
    this.assertActive()
    if (JSON.stringify(members) !== JSON.stringify(this.store.tagTokenMembers(slugs)) ||
      JSON.stringify(tags) !== JSON.stringify(this.store.tags().filter(tag => slugs.includes(tag.slug))) ||
      tokenizer.id !== getCanonicalTokenizer().id || tokenizer.encoding !== getCanonicalTokenizer().encoding) throw new Error('TAG_CONTEXT_CHANGED')
    return slugs.map(slug => {
      const sources = members.filter(member => member.slug === slug)
      if (sources.some(member => !counts.has(member.artifactId))) throw new Error('TOKEN_COUNT_UNAVAILABLE')
      return { slug, count: sources.length, rawMarkdownTokenCount: sources.reduce((sum, member) => sum + counts.get(member.artifactId)!, 0), tokenizerId: tokenizer.id, tokenizerEncoding: tokenizer.encoding }
    })
  }
  mutateTags(request: ContinuumTagMutation) {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    if (request.repositoryId !== this.store.repositoryId) throw new Error('REPOSITORY_CONTEXT_CHANGED')
    if (request.intent === 'quick-create') {
      if (Object.keys(request).some(key => !['repositoryId', 'intent', 'name', 'selected'].includes(key))) throw new Error('INVALID_TAG_OPERATION')
      this.store.createQuickTag(request.name, request.selected)
    }
    else if (request.intent === 'create' || request.intent === 'edit') this.store.saveTag(request.tag, request.intent === 'create')
    else if (request.intent === 'delete') this.store.deleteTag(request.slug)
    else if (request.intent === 'assign') {
      if (request.confirmed !== true) throw new Error('TAG_CONFIRMATION_REQUIRED')
      this.store.assignTag(request.slug, request.selected, request.assigned)
    } else throw new Error('INVALID_TAG_OPERATION')
    this.changed()
    return this.store.tags()
  }
  private assertAgentTags(metadata: { tags?: unknown }, prior?: { tags?: unknown }) {
    if (JSON.stringify(metadata.tags) !== JSON.stringify(prior?.tags)) throw new Error('HUMAN_TAG_AUTHORSHIP_REQUIRED: generic Markdown routes cannot change tags; use dedicated tag operations on explicit user request')
  }
  publishHuman(rawMarkdown: string, confirmedTags = false): ArtifactReceipt {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    const publication = canonicalizePublication(rawMarkdown)
    const { metadata } = publication
    this.assertDocumentaryMetadata(metadata)
    const tags = artifactTags(metadata.tags)
    tags.forEach(slug => this.store.requireTag(slug))
    if (tags.length && !confirmedTags) throw new Error('TAGS_CONFIRMATION_REQUIRED: ' + tags.join(', '))
    const receipt = this.publishedReceipt(this.store.createPublished({ artifactId: 'artifact-' + randomUUID(), ...publication, provenance: this.publicationProvenance() }, publicationRequestDigest('PUBLISH', { rawMarkdown })))
    this.changed(); return receipt
  }
  searchHealth() {
    this.assertActive()
    return this.store.searchHealth()
  }

  searchArtifacts(input: unknown) {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    const result = this.store.searchArtifacts(input)
    this.assertActive(); return result
  }

  inspectStructure(query: import('./artifact-structure').StructureQuery) {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    const result = this.store.inspectStructure(query)
    this.assertActive(); return result
  }
  readSection(query: import('./artifact-structure').SectionQuery) {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    const result = this.store.readSection(query)
    this.assertActive(); return result
  }
  private readonly listeners = new Set<() => void>()
  private thumbnailReads = 0
  onChanged(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(): void { for (const listener of this.listeners) { try { listener() } catch (error) { console.error('[Continuum] Change notification failed:', error) } } }
  facets() { this.reconcile?.(); return this.store.facets() }
  constructor(private readonly store: ArtifactStore, private readonly reconcile?: () => void, private readonly isActive: () => boolean = () => true, private readonly lifecycleDependencies: LifecycleDependencies = {}) {}
  assertActive(): void { if (!this.isActive()) throw new Error('REPOSITORY_CONTEXT_CHANGED') }
  suggestions(query: ContinuumSuggestionQuery) {
    this.assertActive()
    this.reconcile?.()
    this.assertActive()
    const result = this.store.suggestions(query)
    this.assertActive()
    return result
  }
  graph(query: ContinuumGraphQuery = {}, options: { indexOnly?: boolean } = {}) {
    this.assertActive()
    this.reconcile?.()
    const result = this.store.graph(query, options)
    this.assertActive()
    return result
  }
  async publishVisual(rawMarkdown: string, input: Uint8Array): Promise<VisualArtifactReceipt> {
    this.assertActive()
    this.reconcile?.()
    const publication = canonicalizePublication(rawMarkdown, /^(?:\uFEFF)?---(?:\r?\n|$)/.test(rawMarkdown) ? {} : { kind: 'VISUAL_REFERENCE' })
    const { metadata } = publication
    this.assertDocumentaryMetadata(metadata)
    this.assertAgentTags(metadata)
    if (metadata.kind !== 'VISUAL_REFERENCE' || metadata.media !== undefined) throw new Error('RESERVED_VISUAL_METADATA')
    const data = Buffer.from(input)
    const media = await validateVisualMedia(data)
    this.assertActive()
    const published = this.store.createVisualPublished({ artifactId: 'artifact-' + randomUUID(), ...publication, provenance: this.publicationProvenance() }, data, media, publicationRequestDigest('PUBLISH', { rawMarkdown }))
    this.changed()
    return { ...this.publishedReceipt(published), media }
  }
  getVisual(artifactId: string) { this.assertActive(); this.reconcile?.(); return this.store.getVisual(artifactId) }
  async getVisualThumbnail(artifactId: string): Promise<Buffer> {
    if (this.thumbnailReads >= 2) throw new Error('VISUAL_THUMBNAIL_BUSY')
    this.thumbnailReads++
    try {
      const visual = this.getVisual(artifactId)
      const data = await sharp(visual.data, { failOn: 'warning', limitInputPixels: 16_000_000, sequentialRead: true })
        .timeout({ seconds: 5 }).resize({ width: 160, height: 96, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 }).toBuffer()
      this.assertActive()
      if (data.length > 128 * 1024) throw new Error('VISUAL_THUMBNAIL_SIZE_LIMIT')
      return data
    } finally { this.thumbnailReads-- }
  }
  private receipt(artifact: Artifact): ArtifactReceipt { return { success: true, artifactId: artifact.artifactId, revision: artifact.revision, updatedAt: artifact.updatedAt } }
  private publishedReceipt(value: { artifact: Artifact; publicationReceipt: PublicationReceipt }): ArtifactReceipt {
    const publicationExecutionId = value.publicationReceipt.deliveryContext?.executionId
    return { ...this.receipt(value.artifact), publicationReceipt: value.publicationReceipt, ...(publicationExecutionId ? { publicationExecutionId } : {}), replayed: false }
  }
  readPublicationReceipt(receiptId: string): PublicationReceipt | null { this.assertActive(); return this.store.readPublicationReceipt(receiptId) }
  publicationContextAt(artifactId: string, revision: number) {
    this.assertActive()
    return this.store.publicationReceiptAt(artifactId, revision, revision === 1 ? 'PUBLISH' : 'UPDATE')?.deliveryContext
  }
  membershipAt(artifactId: string, revision?: number) { this.assertActive(); return this.store.membershipAt(artifactId, revision) }
  membershipSelection(artifactId: string, revision?: number) { this.assertActive(); return this.store.membershipSelection(artifactId, revision) }
  executionRoot(executionId: string) { this.assertActive(); return this.store.executionRoot(executionId) }
  executionMembers(executionId: string, limit?: number, cursor?: string) { this.assertActive(); return this.store.executionMembers(executionId, limit, cursor) }
  publicationDeliveryPage(after?: string, limit?: number, filter?: import('../../shared/types/delivery-context-types').DeliveryProjectionFilter): DeliveryProjectionPage { this.assertActive(); return this.store.publicationDeliveryPage(after, limit, filter) }
  associatePublication(value: PublicationAssociation) { this.assertActive(); return this.store.associatePublication(value) }
  invalidatePublication(invocationId: string, state: 'UNAVAILABLE' | 'PARTIAL' | 'AMBIGUOUS') { this.assertActive(); this.store.invalidatePublication(invocationId, state) }
  replayPublicationReceipt(receiptId: string): ArtifactReceipt {
    const receipt = this.readPublicationReceipt(receiptId)
    if (!receipt) throw new Error('PUBLICATION_RECEIPT_NOT_FOUND')
    const artifact = this.store.get(receipt.artifactId)!
    if (artifact.revision !== receipt.revision) throw new Error('STALE_PUBLICATION_RECEIPT')
    return { ...this.publishedReceipt({ artifact, publicationReceipt: receipt }), replayed: true }
  }
  async prepareDeliveryContext(authority: AgentAuthority | undefined, request: DeliveryContextRequest, observe: ObserveDelivery, options?: { worktreeId?: string }): Promise<DeliveryAnchor> {
    deliveryContextRequest.parse(request)
    const targetWorktreeId = options?.worktreeId ?? authority?.worktreeId
    if (authority?.worktreeId && options?.worktreeId && authority.worktreeId !== options.worktreeId) throw new Error('DELIVERY_CONTEXT_CONFLICT')
    const check = () => {
      this.assertActive(); assertArtifactAgent(authority, this.repositoryId)
      const binding = this.get(request.bindingArtifactId), plan = this.get(request.planArtifactId)
      const planExecutionId = plan ? this.store.resolvePlanExecutionId(plan) : undefined
      if (!binding || binding.provenance.executionBranchBinding !== true || binding.metadata.bindingRole !== 'EXECUTION_BRANCH' || binding.metadata.repositoryId !== this.repositoryId ||
        binding.metadata.sourceArtifactId !== request.planArtifactId || binding.metadata.executionId !== request.executionId || !plan || plan.metadata.kind !== 'EXECUTABLE_PLAN' || planExecutionId !== request.executionId) throw new Error('DELIVERY_CONTEXT_INVALID')
      if (binding.revision !== request.bindingRevision || plan.revision !== request.planRevision) throw new Error('DELIVERY_CONTEXT_STALE')
      if (targetWorktreeId) {
        const activeActivation = this.store.getActiveActivation(targetWorktreeId)
        if (activeActivation) {
          if (activeActivation.executionId !== request.executionId || activeActivation.planArtifactId !== request.planArtifactId || activeActivation.bindingArtifactId !== request.bindingArtifactId) {
            throw new Error('DELIVERY_CONTEXT_CONFLICT')
          }
          if (activeActivation.planRevision !== request.planRevision || activeActivation.bindingRevision !== request.bindingRevision) {
            throw new Error('DELIVERY_CONTEXT_STALE')
          }
        } else {
          const priorActivation = this.store.getActivationForBinding(request.bindingArtifactId, targetWorktreeId)
          if (priorActivation && priorActivation.status !== 'ACTIVE') {
            throw new Error('DELIVERY_CONTEXT_REVOKED')
          }
        }
      }
      return { binding, plan }
    }
    const initial = check(), before = await observe(), after = await observe(), current = check()
    const metadata = current.binding.metadata
    if (JSON.stringify(before) !== JSON.stringify(after) || before.repositoryId !== this.repositoryId || targetWorktreeId && targetWorktreeId !== before.worktreeId ||
      metadata.worktreeId !== before.worktreeId || metadata.worktreeGeneration !== before.worktreeGeneration || metadata.branchRef !== before.branchRef || metadata.branchGeneration !== before.branchGeneration ||
      initial.binding.contentHash !== current.binding.contentHash || initial.plan.contentHash !== current.plan.contentHash) throw new Error('DELIVERY_CONTEXT_STALE')
    const anchor: DeliveryAnchor = { ...request, schemaVersion: 1, repositoryId: this.repositoryId, planDigest: current.plan.contentHash, bindingDigest: current.binding.contentHash,
      snapshot: before, classification: 'AUTHENTICATED_EXECUTION_CONTEXT' }
    const activation = this.store.getActiveActivation(before.worktreeId)
    if (activation) this.preparedMembership.set(anchor, { id: activation.activationId, revision: activation.revision })
    return anchor
  }

  async resolveExecutionContext(
    authority: AgentAuthority | undefined,
    explicitDeliveryContext?: unknown,
    observeDelivery?: ObserveDelivery,
    options?: { requireGoverned?: boolean; worktreeId?: string }
  ): Promise<{ anchor?: DeliveryAnchor; source: 'EXPLICIT_OR_LAUNCH' | 'DURABLE_ACTIVATION' | 'UNMANAGED' }> {
    this.assertActive()
    if (authority?.deliveryContextError) throw new Error('DELIVERY_CONTEXT_INVALID')
    if (authority?.worktreeId && options?.worktreeId && authority.worktreeId !== options.worktreeId) throw new Error('DELIVERY_CONTEXT_CONFLICT')
    const targetWorktreeId = options?.worktreeId ?? authority?.worktreeId
    const resolved = resolveEffectiveDeliveryContext(explicitDeliveryContext, authority?.deliveryContext, authority?.deliveryContextError)
    if (!resolved.ok) throw new Error(resolved.reason === 'DELIVERY_CONTEXT_CONFLICT' ? 'DELIVERY_CONTEXT_CONFLICT' : 'DELIVERY_CONTEXT_INVALID')
    const obs = observeDelivery ?? (this.lifecycleDependencies.observeDelivery && authority ? () => this.lifecycleDependencies.observeDelivery!(targetWorktreeId) : undefined)
    if (resolved.request) {
      if (!obs) throw new Error('DELIVERY_CONTEXT_INVALID')
      const anchor = await this.prepareDeliveryContext(authority, resolved.request, obs, { worktreeId: targetWorktreeId })
      return { anchor, source: 'EXPLICIT_OR_LAUNCH' }
    }
    if (targetWorktreeId) {
      assertArtifactAgent(authority, this.repositoryId)
      const active = this.store.getActiveActivation(targetWorktreeId)
      if (active) {
        if (!obs) throw new Error('DELIVERY_CONTEXT_INVALID')
        const request: DeliveryContextRequest = {
          bindingArtifactId: active.bindingArtifactId,
          bindingRevision: active.bindingRevision,
          planArtifactId: active.planArtifactId,
          planRevision: active.planRevision,
          executionId: active.executionId
        }
        const anchor = await this.prepareDeliveryContext(authority, request, obs, { worktreeId: targetWorktreeId })
        return { anchor, source: 'DURABLE_ACTIVATION' }
      }
    }
    if (options?.requireGoverned) throw new Error('DELIVERY_CONTEXT_MISSING')
    return { anchor: undefined, source: 'UNMANAGED' }
  }

  getActiveExecutionContext(worktreeId: string) {
    this.assertActive()
    const activation = this.store.getActiveActivation(worktreeId)
    if (!activation) return null
    return {
      activation,
      deliveryContext: {
        bindingArtifactId: activation.bindingArtifactId,
        bindingRevision: activation.bindingRevision,
        planArtifactId: activation.planArtifactId,
        planRevision: activation.planRevision,
        executionId: activation.executionId
      } satisfies DeliveryContextRequest
    }
  }

  revokeExecutionActivation(input: {
    worktreeId: string
    worktreeGeneration?: string
    executionId?: string
    expectedActivationRevision?: number
    status?: 'REVOKED' | 'CLOSED'
    reason?: string
  }) {
    this.assertActive()
    const activation = this.store.revokeActivation(input)
    this.changed()
    return { state: 'PERSISTED' as const, ...activation }
  }

  async bootstrapExecution(
    input: {
      planArtifactId: string
      expectedPlanRevision?: number
      executionId?: string
      scopeKind?: ExecutionActivationScopeKind
      activate?: boolean
      expectedActivationRevision?: number
    },
    observe: () => Promise<ExecutionBranchSnapshot>
  ) {
    this.assertActive()
    if (!input.planArtifactId.trim() || input.planArtifactId.length > 512 || /[\0\r\n]/.test(input.planArtifactId)) throw new Error('INVALID_ARGUMENT')
    if (input.executionId !== undefined && (!input.executionId.trim() || input.executionId.length > 512 || /[\0\r\n]/.test(input.executionId))) throw new Error('INVALID_ARGUMENT')
    if (input.expectedPlanRevision !== undefined && (!Number.isSafeInteger(input.expectedPlanRevision) || input.expectedPlanRevision < 1)) throw new Error('INVALID_ARGUMENT')
    const checkSource = () => {
      this.assertActive()
      const source = this.get(input.planArtifactId)
      if (!source || source.metadata.kind !== 'EXECUTABLE_PLAN') throw new Error('EXECUTION_SOURCE_MISMATCH')
      const knownExecutionId = this.store.resolvePlanExecutionId(source)
      if (input.executionId !== undefined && input.executionId !== knownExecutionId) throw new Error('EXECUTION_SOURCE_MISMATCH')
      if (input.activate === false && !knownExecutionId) throw new Error('EXECUTION_SOURCE_MISMATCH')
      if (input.expectedPlanRevision !== undefined && source.revision !== input.expectedPlanRevision) {
        throw new Error(`REVISION_CONFLICT: Artifact "${source.artifactId}" is at revision ${source.revision}; read again before updating`)
      }
      return source
    }
    const initialSource = checkSource()
    const before = await observe()
    if (before.branchGeneration === 'UNKNOWN' || !before.branchRef.startsWith('refs/heads/')) throw new Error('BRANCH_IDENTITY_UNAVAILABLE')
    if (before.repositoryId !== this.repositoryId) throw new Error('EXECUTION_SOURCE_MISMATCH')
    const after = await observe()
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('EXECUTION_BINDING_DRIFT')
    const currentSource = checkSource()
    if (currentSource.revision !== initialSource.revision || currentSource.contentHash !== initialSource.contentHash) throw new Error('EXECUTION_BINDING_DRIFT')
    const observedAt = new Date().toISOString()
    const result = this.store.bootstrapExecutionBinding({
      planArtifactId: input.planArtifactId,
      expectedPlanRevision: input.expectedPlanRevision ?? currentSource.revision,
      executionId: input.executionId,
      snapshot: before,
      scopeKind: input.scopeKind,
      activate: input.activate,
      expectedActivationRevision: input.expectedActivationRevision,
      buildBinding: (executionId) => {
        const artifactId = 'artifact-execution-branch-' + createHash('sha256').update(JSON.stringify([before.repositoryId, executionId, before.branchRef, before.branchGeneration])).digest('hex')
        const metadata = {
          name: `Execução ${executionId} · ${before.branchRef}`,
          description: 'Declaração explícita vinculada a uma instância Git observada; não comprova atividade, autoria ou conclusão.',
          kind: 'OBSERVATION', date: observedAt, status: 'VERIFIED_AT_BINDING', bindingRole: 'EXECUTION_BRANCH',
          executionId, repositoryId: before.repositoryId, sourceArtifactId: input.planArtifactId,
          branchRef: before.branchRef, branchGeneration: before.branchGeneration, branchRevision: before.branchRevision, sourceHeadAtBinding: before.head,
          worktreeId: before.worktreeId, worktreeGeneration: before.worktreeGeneration, worktreeFingerprint: before.fingerprint, observedAt,
          evidenceKind: 'AUTHENTICATED_DECLARATION_GIT_VERIFIED', relations: [{ artifactId: input.planArtifactId, kind: 'related-to' }]
        }
        const rawMarkdown = `---\n${JSON.stringify(metadata, null, 2)}\n---\n\nDeclaração autenticada de execução associada à instância Git observada. A seleção da Worktree não prova posse do processo. A verificação é pontual; não autoriza operações Git nem comprova implementação ou validação.\n`
        return { artifactId, metadata, rawMarkdown }
      }
    })
    this.changed()
    return {
      ...this.receipt(result.binding),
      state: 'PERSISTED' as const,
      reused: result.reused,
      executionId: result.executionId,
      branchRef: result.binding.metadata.branchRef,
      branchGeneration: result.binding.metadata.branchGeneration,
      planArtifactId: result.plan.artifactId,
      planRevision: result.plan.revision,
      bindingArtifactId: result.binding.artifactId,
      bindingRevision: result.binding.revision,
      ...(result.activation ? {
        activationId: result.activation.activationId,
        activationRevision: result.activation.revision,
        activationStatus: result.activation.status
      } : {}),
      deliveryContext: {
        bindingArtifactId: result.binding.artifactId,
        bindingRevision: result.binding.revision,
        planArtifactId: result.plan.artifactId,
        planRevision: result.plan.revision,
        executionId: result.executionId
      }
    }
  }

  async bindExecutionBranch(executionId: string, sourceArtifactId: string, observe: () => Promise<ExecutionBranchSnapshot>) {
    return this.bootstrapExecution({ planArtifactId: sourceArtifactId, executionId, activate: false }, observe)
  }
  private publicationProvenance() {
    return { publication: { schemaVersion: 1, publisher: 'CONTINUUM_SERVICE', repositoryId: this.store.repositoryId, sessionEvidence: 'UNAVAILABLE' } }
  }
  private assertDocumentaryMetadata(metadata: Artifact['metadata'], prior?: Artifact['metadata']) {
    for (const key of ['artifactId', 'repositoryId', 'revision', 'createdAt', 'updatedAt', 'contentHash', 'provenance', 'nativeArtifact', 'publication', 'lifecycle',
      'executionId', 'executionIdentity', 'publicationExecutionId', 'documentaryMembership', 'documentaryUnlinkReason', 'deliveryContext', 'bindingRole']) {
      if (Object.hasOwn(metadata, key) !== Object.hasOwn(prior ?? {}, key) || canonicalJson(normalizeMetadataValue(metadata[key] ?? null)) !== canonicalJson(normalizeMetadataValue(prior?.[key] ?? null))) throw new Error('AUTHORITATIVE_METADATA_RESERVED: ' + key)
    }
    const nestedIdentity = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return null
      return Object.fromEntries(Object.entries(value).flatMap(([key, field]) => {
        if (['executionId', 'executionIdentity', 'publicationExecutionId', 'documentaryMembership', 'documentaryUnlinkReason', 'deliveryContext'].includes(key)) return [[key, field]]
        const nested = nestedIdentity(field)
        return nested && Object.keys(nested).length ? [[key, nested]] : []
      }))
    }
    if (canonicalJson(normalizeMetadataValue(nestedIdentity(metadata))) !== canonicalJson(normalizeMetadataValue(nestedIdentity(prior ?? {})))) throw new Error('AUTHORITATIVE_METADATA_RESERVED: nested execution identity')
  }
  publish(rawMarkdown: string, fields: ArtifactPublicationFields = {}, authority?: AgentAuthority, preparedAnchor?: DeliveryAnchor): ArtifactReceipt {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    const { membership, ...semanticFields } = fields
    const publication = canonicalizePublication(rawMarkdown, semanticFields)
    const { metadata } = publication
    this.assertDocumentaryMetadata(metadata)
    if (authority) assertArtifactAgent(authority, this.store.repositoryId)
    else this.assertAgentTags(metadata)
    if (authority?.deliveryContextError) throw new Error('DELIVERY_CONTEXT_INVALID')
    let verifiedAnchor: DeliveryAnchor | undefined
    if (preparedAnchor !== undefined) {
      verifiedAnchor = deliveryAnchor.parse(preparedAnchor)
      if (verifiedAnchor.repositoryId !== this.store.repositoryId) throw new Error('DELIVERY_CONTEXT_INVALID')
      if (authority?.deliveryContext && !sameDeliveryRequest(verifiedAnchor, authority.deliveryContext)) throw new Error('DELIVERY_CONTEXT_CONFLICT')
      if (authority?.worktreeId && verifiedAnchor.snapshot.worktreeId !== authority.worktreeId) throw new Error('DELIVERY_CONTEXT_INVALID')
      const binding = this.store.get(verifiedAnchor.bindingArtifactId), plan = this.store.get(verifiedAnchor.planArtifactId)
      if (!binding || !plan || binding.revision !== verifiedAnchor.bindingRevision || plan.revision !== verifiedAnchor.planRevision ||
        binding.contentHash !== verifiedAnchor.bindingDigest || plan.contentHash !== verifiedAnchor.planDigest) throw new Error('DELIVERY_CONTEXT_STALE')
    } else if (authority?.deliveryContext) {
      throw new Error('DELIVERY_CONTEXT_INVALID')
    }
    const receiptContext: PublicationReceiptContext | undefined = verifiedAnchor || authority?.sessionWitness
      ? { ...(verifiedAnchor ? { deliveryContext: verifiedAnchor, activation: preparedAnchor && this.preparedMembership.get(preparedAnchor) } : {}), ...(authority?.sessionWitness ? { sessionWitness: authority.sessionWitness } : {}) }
      : undefined
    const provenance: Record<string, import('./continuum-types').MetadataValue> = {
      ...this.publicationProvenance(),
      ...(verifiedAnchor ? { deliveryContext: normalizeMetadataValue(verifiedAnchor) } : {}),
      ...(authority?.sessionWitness ? { sessionWitness: normalizeMetadataValue(authority.sessionWitness) } : {})
    }
    const receipt = this.publishedReceipt(this.store.createPublished({ artifactId: 'artifact-' + randomUUID(), ...publication, provenance }, publicationRequestDigest('PUBLISH', { rawMarkdown, ...fields }), authority ? receiptContext : undefined, membership))
    this.changed()
    return receipt
  }
  update(artifactId: string, expectedRevision: number, rawMarkdown: string, fields?: ArtifactSemanticFields): ArtifactReceipt {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    const prior = this.store.get(artifactId)
    if (!prior) throw new Error('ARTIFACT_NOT_FOUND: ' + artifactId)
    const publication = canonicalizePublication(rawMarkdown, fields, prior.metadata)
    this.assertDocumentaryMetadata(publication.metadata, prior.metadata)
    if (publication.metadata.status !== prior.metadata.status && (lifecyclePolicy(prior.metadata) || lifecyclePolicy(publication.metadata))) throw new Error('LIFECYCLE_TRANSITION_REQUIRED')
    if (lifecyclePolicy(prior.metadata) && lifecyclePolicy(prior.metadata)?.key !== lifecyclePolicy(publication.metadata)?.key) throw new Error('LIFECYCLE_POLICY_CHANGE_REQUIRES_REVIEW')
    this.assertAgentTags(publication.metadata, prior.metadata)
    const receipt = this.publishedReceipt(this.store.updatePublished({ artifactId, expectedRevision, ...publication, provenance: this.publicationProvenance() }, publicationRequestDigest('UPDATE', { rawMarkdown, artifactId, expectedRevision, ...fields })))
    this.changed()
    return receipt
  }
  async updateAgent(authority: AgentAuthority, artifactId: string, expectedRevision: number, rawMarkdown: string, fields: ArtifactPublicationFields = {},
    lifecycle: Pick<LifecycleRequest, 'evidenceMode' | 'attestation' | 'evidenceRefs' | 'supportingArtifactId'> = { evidenceRefs: [] }, observeDelivery?: ObserveDelivery) {
    const assertContext = () => { this.assertActive(); assertArtifactAgent(authority, this.store.repositoryId) }
    assertContext(); this.reconcile?.(); assertContext()
    const receiptContext = await this.prepareAuthorityDelivery(authority, observeDelivery)
    const prior = this.store.get(artifactId)
    if (!prior) throw new Error('ARTIFACT_NOT_FOUND')
    const requestDigest = lifecycleDigest({ artifactId, expectedRevision, rawMarkdown, fields, lifecycle })
    const correction = prior.provenance.editorialCorrection as { requestDigest?: string } | undefined
    if (correction?.requestDigest === requestDigest && prior.revision === expectedRevision + 1) {
      const publicationReceipt = this.store.publicationReceiptAt(prior.artifactId, prior.revision, 'UPDATE')
      const receipt = publicationReceipt ? this.publishedReceipt({ artifact: prior, publicationReceipt }) : this.receipt(prior)
      return { ...receipt, state: 'PERSISTED' as const, replayed: true, lifecycleReceipt: lifecycleReceipt(prior) }
    }
    if (prior.revision !== expectedRevision) throw new Error('REVISION_CONFLICT')
    const { membership, ...semanticFields } = fields
    const publication = canonicalizePublication(rawMarkdown, semanticFields, prior.metadata)
    this.assertDocumentaryMetadata(publication.metadata, prior.metadata)
    const policy = lifecyclePolicy(prior.metadata), nextPolicy = lifecyclePolicy(publication.metadata)
    const policyChanged = policy?.key !== nextPolicy?.key
    if (policy && policyChanged && !lifecycle.attestation) throw new Error('LIFECYCLE_POLICY_CHANGE_REQUIRES_REVIEW')
    const changedFields = [...new Set([...Object.keys(prior.metadata), ...Object.keys(publication.metadata)])].filter(key => Object.hasOwn(prior.metadata, key) !== Object.hasOwn(publication.metadata, key) || lifecycleDigest(prior.metadata[key] ?? null) !== lifecycleDigest(publication.metadata[key] ?? null))
    const correctedAt = new Date().toISOString()
    const provenance = {
      ...this.publicationProvenance(),
      ...(receiptContext?.deliveryContext ? { deliveryContext: normalizeMetadataValue(receiptContext.deliveryContext) } : {}),
      ...(receiptContext?.sessionWitness ? { sessionWitness: normalizeMetadataValue(receiptContext.sessionWitness) } : {}),
      editorialCorrection: { principalId: authority.principal.principalId, transport: authority.principal.transport,
        baseRevision: expectedRevision, changedFields, requestDigest, correctedAt },
      fieldCorrections: {
        ...(prior.provenance.fieldCorrections as Record<string, import('./continuum-types').MetadataValue> ?? {}),
        ...Object.fromEntries(changedFields.map(key => [key, { origin: 'AGENT_ATTESTED', principalId: authority.principal.principalId, correctedAt, revision: expectedRevision + 1 }]))
      }
    }
    if ((policy || nextPolicy) && (publication.metadata.status !== prior.metadata.status || (lifecycle.attestation && publication.metadata.status && (policyChanged || !lifecycleReceipt(prior))))) {
      const toState = publication.metadata.status
      if (!toState || !lifecycleReasonFor[toState]) throw new Error('POLICY_OR_REASON_MISMATCH')
      const request: LifecycleRequest = { action: 'TRANSITION', artifactId, expectedRevision, toState, reasonCode: lifecycleReasonFor[toState], evidenceRefs: lifecycle.evidenceRefs ?? [],
        ...(lifecycle.supportingArtifactId ? { supportingArtifactId: lifecycle.supportingArtifactId } : {}) }
      const automatic = await transitionLifecycle(this.store, this.lifecycleDependencies, { ...request, action: 'ASSESS' }, assertContext, authority)
      if (!('review' in automatic) || !automatic.review) {
        if (!lifecycle.attestation) return automatic
        Object.assign(request, { evidenceMode: 'REVIEWED_ATTESTATION', evidenceRefs: [], attestation: lifecycle.attestation })
      }
      const result = await transitionLifecycle(this.store, this.lifecycleDependencies, request, assertContext, authority, { rawMarkdown: publication.rawMarkdown, provenance }, receiptContext, membership)
      if (result.state === 'PERSISTED' && !result.replayed) this.changed()
      return result
    }
    assertContext()
    const receipt = this.publishedReceipt(this.store.updatePublished({ artifactId, expectedRevision, ...publication, provenance }, requestDigest, receiptContext, membership))
    this.changed()
    return { ...receipt, state: 'PERSISTED' as const }
  }
  async repairMetadata(authority: AgentAuthority, artifactId: string, expectedRevision: number, observeDelivery?: ObserveDelivery) {
    this.assertActive(); assertArtifactAgent(authority, this.store.repositoryId)
    const requestDigest = lifecycleDigest({ action: 'REPAIR', artifactId, expectedRevision })
    let current: Artifact | null = null
    try { current = this.store.get(artifactId) } catch { /* Canonical repair reads the immutable source even when the live projection cannot decode. */ }
    if ((current?.provenance.technicalRepair as { requestDigest?: string } | undefined)?.requestDigest === requestDigest) return { ...this.receipt(current!), state: 'PERSISTED' as const, replayed: true }
    const receiptContext = current?.metadata.kind === 'EXECUTABLE_PLAN' ? undefined : await this.prepareAuthorityDelivery(authority, observeDelivery)
    this.assertActive(); assertArtifactAgent(authority, this.store.repositoryId)
    const receipt = this.publishedReceipt(this.store.repairPublished(artifactId, expectedRevision, requestDigest, authority.principal.principalId, receiptContext))
    this.changed()
    return { ...receipt, state: 'PERSISTED' as const }
  }
  async reconcileAutomaticMetadata(artifactId: string, expectedRevision: number, proofId: string, fields: Record<string, import('./continuum-types').MetadataValue>) {
    this.assertActive()
    const prior = this.store.get(artifactId)
    if (!prior) throw new Error('ARTIFACT_NOT_FOUND')
    const proof = await this.lifecycleDependencies.proof?.(proofId)
    this.assertActive()
    if (!proof || proof.status !== 'PASSED' || proof.freshness !== 'CURRENT' || proof.commandProfile?.source?.repositoryId !== this.store.repositoryId || !proof.evidenceFor.includes(artifactId) || !Number.isFinite(Date.parse(proof.finishedAt)) || Date.parse(proof.finishedAt) > Date.now()) throw new Error('AUTOMATION_SOURCE_UNVERIFIED')
    if (this.store.get(artifactId)?.revision !== prior.revision) throw new Error('REVISION_CONFLICT')
    const requestDigest = lifecycleDigest({ artifactId, proofId, fields, proof: lifecycleDigest(proof) })
    if ((prior.provenance.metadataAutomation as { requestDigest?: string } | undefined)?.requestDigest === requestDigest) return { ...this.receipt(prior), state: 'PERSISTED' as const, replayed: true }
    if (prior.revision !== expectedRevision || this.store.get(artifactId)?.revision !== expectedRevision) throw new Error('REVISION_CONFLICT')
    const corrections = prior.provenance.fieldCorrections as Record<string, { correctedAt: string }> | undefined
    const observations = prior.provenance.fieldObservations as Record<string, { observedAt: string }> | undefined
    const conflicts = Object.keys(fields).filter(key => (corrections?.[key] && Date.parse(proof.finishedAt) <= Date.parse(corrections[key].correctedAt)) || (observations?.[key] && Date.parse(proof.finishedAt) <= Date.parse(observations[key].observedAt)))
    const applicable = Object.fromEntries(Object.entries(fields).filter(([key]) => !conflicts.includes(key)))
    const metadata = { ...prior.metadata, ...applicable }
    this.assertDocumentaryMetadata(metadata, prior.metadata)
    if (lifecyclePolicy(prior.metadata)?.key !== lifecyclePolicy(metadata)?.key) throw new Error('LIFECYCLE_POLICY_CHANGE_REQUIRES_REVIEW')
    const { dump } = await import('js-yaml')
    const body = parseArtifactMarkdown(prior.rawMarkdown, true).body
    const rawMarkdown = `---\n${dump(metadata, { lineWidth: -1 })}---\n${body}`
    const provenance = { metadataAutomation: { origin: 'AUTO_VERIFIED', proofId, observedAt: proof.finishedAt, requestDigest, conflicts, appliedFields: Object.keys(applicable) },
      fieldObservations: { ...(prior.provenance.fieldObservations as Record<string, import('./continuum-types').MetadataValue> ?? {}), ...Object.fromEntries(Object.keys(applicable).map(key => [key, { observedAt: proof.finishedAt, proofId }])) } }
    const fresh = await this.lifecycleDependencies.proof?.(proofId)
    this.assertActive()
    if (!fresh || lifecycleDigest(fresh) !== lifecycleDigest(proof)) throw new Error('AUTOMATION_SOURCE_CHANGED')
    let result
    if (metadata.status !== prior.metadata.status && lifecyclePolicy(metadata)) {
      const isActive = () => this.isActive()
      const authority = authorizeArtifactAgent(authenticatedAgentPrincipal('AUTOMATION', isActive), this.store.repositoryId, isActive)
      result = await transitionLifecycle(this.store, this.lifecycleDependencies, { action: 'TRANSITION', artifactId, expectedRevision, toState: metadata.status!, reasonCode: lifecycleReasonFor[metadata.status!], evidenceRefs: [proofId] }, () => this.assertActive(), authority, { rawMarkdown, provenance })
    } else result = { ...this.publishedReceipt(this.store.updatePublished({ artifactId, expectedRevision, rawMarkdown, metadata, provenance }, requestDigest)), state: 'PERSISTED' as const }
    if (result.state === 'PERSISTED') this.changed()
    return { ...result, conflicts }
  }
  get(artifactId: string): Artifact | null {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    const artifact = this.store.get(artifactId)
    if (!artifact) return null
    const nativeArtifact = this.store.publicationProvenance(artifactId, artifact.revision)
    const documentaryMembership = this.store.membershipAt(artifactId, artifact.revision)
    return { ...artifact, ...(documentaryMembership ? { documentaryMembership } : {}), ...(nativeArtifact ? { provenance: { ...artifact.provenance, nativeArtifact } } : {}), lifecycle: lifecycleProjection(artifact, lifecycleReceipt(artifact)),
      operationalActivity: this.lifecycleDependencies.activity?.(this.store.repositoryId, artifactId) ?? { state: 'UNKNOWN', source: 'NO_ACTIVE_OPERATION_OBSERVED' } }
  }
  provenanceSnapshot(artifactId: string, revision?: number): Artifact | null {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    const artifact = revision === undefined ? this.store.get(artifactId) : this.store.getRevision(artifactId, revision)
    if (!artifact) return null
    if (createHash('sha256').update(artifact.rawMarkdown).digest('hex') !== artifact.contentHash) throw new Error('ARTIFACT_REVISION_INTEGRITY')
    const nativeArtifact = this.store.publicationProvenance(artifactId, artifact.revision)
    this.assertActive()
    return nativeArtifact ? { ...artifact, provenance: { ...artifact.provenance, nativeArtifact } } : artifact
  }
  list(filter: ListArtifactsFilter = {}): ArtifactPage { this.reconcile?.(); return this.store.list(filter) }
  listIndexedArtifacts(filter: ListArtifactsFilter, kinds: readonly string[]): ArtifactPage {
    this.assertActive()
    return this.store.list(filter, { kinds })
  }
  readIndexedGraph(query: ContinuumGraphQuery) {
    this.assertActive()
    return this.store.graph(query, { indexOnly: true })
  }
  indexedArtifact(artifactId: string) {
    this.assertActive()
    return this.store.indexedArtifact(artifactId)
  }
  importArtifact(source: string, input: CreateArtifactInput): ArtifactReceipt {
    const existing = this.store.get(input.artifactId)
    if (!existing) {
      if (input.provenance && ['executionIdentity', 'executionBranchBinding', 'deliveryContext', 'documentaryMembership'].some(key => Object.hasOwn(input.provenance!, key))) throw new Error('AUTHORITATIVE_METADATA_RESERVED')
      if (/^(?:\uFEFF)?---\r?\n/.test(input.rawMarkdown)) this.assertAgentTags(parseArtifactMarkdown(input.rawMarkdown, true).metadata)
      this.assertAgentTags(input.metadata)
    }
    const receipt = this.receipt(this.store.importArtifact(source, input))
    if (!existing) this.changed()
    return receipt
  }
  ingest(envelope: TransportEnvelope, repositoryKey: string): ArtifactReceipt {
    if (envelope.repositoryKey !== repositoryKey && !this.store.hasLocator(envelope.repositoryKey)) throw new Error('INVALID_ARGUMENT: inbox locator does not match this repository')
    const source = 'inbox:' + envelope.repositoryKey
    if (envelope.protocol === 'continuum-artifact/v1') return this.importArtifact(source, legacyInput(envelope))
    const { metadata } = parseArtifactMarkdown(envelope.rawMarkdown)
    if (!this.store.get(envelope.artifactId)) this.assertDocumentaryMetadata(metadata)
    return this.importArtifact(source, { artifactId: envelope.artifactId, rawMarkdown: envelope.rawMarkdown, metadata,
      createdAt: envelope.createdAt, contentHash: envelope.contentHash })
  }
}
