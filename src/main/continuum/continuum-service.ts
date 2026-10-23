import { createHash, randomUUID } from 'node:crypto'
import type { ExecutionBranchSnapshot } from '../../shared/types/execution-branch-types'
import type { ContinuumGraphQuery } from '../../shared/types/continuum-graph-types'
import type { ContinuumSuggestionQuery } from '../../shared/types/continuum-suggestion-types'
import sharp from 'sharp'
import type { Artifact, ArtifactReceipt, CreateArtifactInput, IContinuumService, ListArtifactsFilter, ArtifactPage, IArtifactGraphReader, IArtifactSuggestionReader } from './continuum-types'
import type { TransportEnvelope } from './artifact-envelope'
import { ArtifactStore } from './artifact-store'
import { parseArtifactMarkdown } from './artifact-metadata'
import { legacyInput } from './legacy-artifact-migrator'
import { validateVisualMedia } from './visual-media'
import type { IVisualContinuumService, VisualArtifactReceipt } from './continuum-types'
import { artifactTags, type ContinuumTagMutation } from '../../shared/types/continuum-tag-types'

export class ContinuumService implements IContinuumService, IVisualContinuumService, IArtifactGraphReader, IArtifactSuggestionReader {
  tags() { this.assertActive(); this.reconcile?.(); this.assertActive(); return this.store.tags() }
  mutateTags(request: ContinuumTagMutation) {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    if (request.intent === 'create' || request.intent === 'edit') this.store.saveTag(request.tag, request.intent === 'create')
    else if (request.intent === 'delete') this.store.deleteTag(request.slug)
    else if (request.intent === 'assign') {
      if (request.confirmed !== true) throw new Error('TAG_CONFIRMATION_REQUIRED')
      this.store.assignTag(request.slug, request.selected, request.assigned)
    } else throw new Error('INVALID_TAG_OPERATION')
    this.changed()
    return this.store.tags()
  }
  private assertAgentTags(metadata: { tags?: unknown }, prior?: { tags?: unknown }) {
    if (JSON.stringify(metadata.tags) !== JSON.stringify(prior?.tags)) throw new Error('HUMAN_TAG_AUTHORSHIP_REQUIRED: agents may query tags but cannot create, change or remove them')
  }
  publishHuman(rawMarkdown: string, confirmedTags = false): ArtifactReceipt {
    this.assertActive(); this.reconcile?.(); this.assertActive()
    const { metadata } = parseArtifactMarkdown(rawMarkdown)
    const tags = artifactTags(metadata.tags)
    tags.forEach(slug => this.store.requireTag(slug))
    if (tags.length && !confirmedTags) throw new Error('TAGS_CONFIRMATION_REQUIRED: ' + tags.join(', '))
    const receipt = this.receipt(this.store.create({ artifactId: 'artifact-' + randomUUID(), metadata, rawMarkdown }))
    this.changed(); return receipt
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
  constructor(private readonly store: ArtifactStore, private readonly reconcile?: () => void, private readonly isActive: () => boolean = () => true) {}
  assertActive(): void { if (!this.isActive()) throw new Error('REPOSITORY_CONTEXT_CHANGED') }
  suggestions(query: ContinuumSuggestionQuery) {
    this.assertActive()
    this.reconcile?.()
    this.assertActive()
    const result = this.store.suggestions(query)
    this.assertActive()
    return result
  }
  graph(query: ContinuumGraphQuery = {}) {
    this.assertActive()
    this.reconcile?.()
    const result = this.store.graph(query)
    this.assertActive()
    return result
  }
  async publishVisual(rawMarkdown: string, input: Uint8Array): Promise<VisualArtifactReceipt> {
    this.assertActive()
    this.reconcile?.()
    const { metadata } = parseArtifactMarkdown(rawMarkdown)
    this.assertAgentTags(metadata)
    if (metadata.kind !== 'VISUAL_REFERENCE' || metadata.media !== undefined) throw new Error('RESERVED_VISUAL_METADATA')
    const data = Buffer.from(input)
    const media = await validateVisualMedia(data)
    this.assertActive()
    const artifact = this.store.createVisual({ artifactId: 'artifact-' + randomUUID(), rawMarkdown, metadata }, data, media)
    this.changed()
    return { ...this.receipt(artifact), media }
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
  async bindExecutionBranch(executionId: string, sourceArtifactId: string, observe: () => Promise<ExecutionBranchSnapshot>) {
    this.assertActive()
    if (!executionId.trim() || executionId.length > 512 || /[\0\r\n]/.test(executionId)) throw new Error('INVALID_ARGUMENT')
    const checkSource = () => {
      this.assertActive()
      const source = this.get(sourceArtifactId)
      if (!source || source.metadata.kind !== 'EXECUTABLE_PLAN' || source.metadata.executionId !== executionId) throw new Error('EXECUTION_SOURCE_MISMATCH')
    }
    checkSource()
    const before = await observe()
    if (before.branchGeneration === 'UNKNOWN' || !before.branchRef.startsWith('refs/heads/')) throw new Error('BRANCH_IDENTITY_UNAVAILABLE')
    const after = await observe()
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('EXECUTION_BINDING_DRIFT')
    checkSource()
    const artifactId = 'artifact-execution-branch-' + createHash('sha256').update(JSON.stringify([before.repositoryId, executionId, before.branchRef, before.branchGeneration])).digest('hex')
    const observedAt = new Date().toISOString()
    const metadata = { name: `Execução ${executionId} · ${before.branchRef}`, description: 'Declaração explícita vinculada a uma instância Git observada; não comprova atividade, autoria ou conclusão.',
      kind: 'OBSERVATION', date: observedAt, status: 'VERIFIED_AT_BINDING', bindingRole: 'EXECUTION_BRANCH', executionId, repositoryId: before.repositoryId, sourceArtifactId,
      branchRef: before.branchRef, branchGeneration: before.branchGeneration, branchRevision: before.branchRevision, sourceHeadAtBinding: before.head,
      worktreeId: before.worktreeId, worktreeGeneration: before.worktreeGeneration, worktreeFingerprint: before.fingerprint, observedAt,
      evidenceKind: 'AUTHENTICATED_DECLARATION_GIT_VERIFIED', relations: [{ artifactId: sourceArtifactId, kind: 'related-to' }] }
    const rawMarkdown = `---\n${JSON.stringify(metadata, null, 2)}\n---\n\nDeclaração autenticada de execução associada à instância Git observada. A seleção da Worktree não prova posse do processo. A verificação é pontual; não autoriza operações Git nem comprova implementação ou validação.\n`
    const artifact = this.store.createExecutionBinding({ artifactId, metadata, rawMarkdown })
    this.changed()
    return { ...this.receipt(artifact), state: 'PERSISTED' as const, executionId, branchRef: artifact.metadata.branchRef, branchGeneration: artifact.metadata.branchGeneration }
  }
  publish(rawMarkdown: string): ArtifactReceipt {
    this.reconcile?.()
    const { metadata } = parseArtifactMarkdown(rawMarkdown)
    this.assertAgentTags(metadata)
    const receipt = this.receipt(this.store.create({ artifactId: 'artifact-' + randomUUID(), metadata, rawMarkdown }))
    this.changed()
    return receipt
  }
  update(artifactId: string, expectedRevision: number, rawMarkdown: string): ArtifactReceipt {
    this.reconcile?.()
    const { metadata } = parseArtifactMarkdown(rawMarkdown)
    this.assertAgentTags(metadata, this.store.get(artifactId)?.metadata)
    const receipt = this.receipt(this.store.update({ artifactId, expectedRevision, rawMarkdown, metadata }))
    this.changed()
    return receipt
  }
  get(artifactId: string): Artifact | null { this.reconcile?.(); return this.store.get(artifactId) }
  list(filter: ListArtifactsFilter = {}): ArtifactPage { this.reconcile?.(); return this.store.list(filter) }
  importArtifact(source: string, input: CreateArtifactInput): ArtifactReceipt {
    const existing = this.store.get(input.artifactId)
    if (!existing) {
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
    return this.importArtifact(source, { artifactId: envelope.artifactId, rawMarkdown: envelope.rawMarkdown, metadata,
      createdAt: envelope.createdAt, contentHash: envelope.contentHash })
  }
}
