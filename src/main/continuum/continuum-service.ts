import { randomUUID } from 'node:crypto'
import type { Artifact, ArtifactReceipt, CreateArtifactInput, IContinuumService, ListArtifactsFilter, ArtifactPage } from './continuum-types'
import type { TransportEnvelope } from './artifact-envelope'
import { ArtifactStore } from './artifact-store'
import { parseArtifactMarkdown } from './artifact-metadata'
import { legacyInput } from './legacy-artifact-migrator'

export class ContinuumService implements IContinuumService {
  private readonly listeners = new Set<() => void>()
  onChanged(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(): void { for (const listener of this.listeners) { try { listener() } catch (error) { console.error('[Continuum] Change notification failed:', error) } } }
  facets() { this.reconcile?.(); return this.store.facets() }
  constructor(private readonly store: ArtifactStore, private readonly reconcile?: () => void) {}
  private receipt(artifact: Artifact): ArtifactReceipt { return { success: true, artifactId: artifact.artifactId, revision: artifact.revision, updatedAt: artifact.updatedAt } }
  publish(rawMarkdown: string): ArtifactReceipt {
    this.reconcile?.()
    const { metadata } = parseArtifactMarkdown(rawMarkdown)
    const receipt = this.receipt(this.store.create({ artifactId: 'artifact-' + randomUUID(), metadata, rawMarkdown }))
    this.changed()
    return receipt
  }
  update(artifactId: string, expectedRevision: number, rawMarkdown: string): ArtifactReceipt {
    this.reconcile?.()
    const { metadata } = parseArtifactMarkdown(rawMarkdown)
    const receipt = this.receipt(this.store.update({ artifactId, expectedRevision, rawMarkdown, metadata }))
    this.changed()
    return receipt
  }
  get(artifactId: string): Artifact | null { this.reconcile?.(); return this.store.get(artifactId) }
  list(filter: ListArtifactsFilter = {}): ArtifactPage { this.reconcile?.(); return this.store.list(filter) }
  importArtifact(source: string, input: CreateArtifactInput): ArtifactReceipt {
    const existing = this.store.get(input.artifactId)
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
