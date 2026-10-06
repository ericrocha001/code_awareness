import { join } from 'node:path'
import { ArtifactStore } from './artifact-store'
import { ArtifactInbox } from './artifact-inbox'
import { ArtifactIngestor, type IngestionReport } from './artifact-ingestor'
import { deriveRepositoryKey } from './repository-key'
import { ContinuumService } from './continuum-service'
import { migrateLegacyStore } from './legacy-artifact-migrator'

export interface ContinuumRepository { id: string; localCheckout: { path: string } | null }
export interface RepositoryContinuumCatalog { findByPath(path: string): ContinuumRepository | null }
export interface ActiveRepositorySession {
  readonly repositoryId: string
  readonly repositoryPath: string
  readonly dbPath: string
}
interface LiveRepositorySession extends ActiveRepositorySession {
  readonly store: ArtifactStore
  readonly service: ContinuumService
  readonly ingestor: ArtifactIngestor
}
export class RepositoryContinuumSession {
  private currentSession: LiveRepositorySession | null = null
  constructor(private readonly storageBaseDir: string, private readonly catalog: RepositoryContinuumCatalog) {}

  activate(repositoryPath: string): IngestionReport {
    const repository = this.catalog.findByPath(repositoryPath)
    if (!repository) throw new Error('REPOSITORY_NOT_FOUND: checkout is absent from the Repository Catalog')
    if (this.currentSession?.repositoryId === repository.id && this.currentSession.repositoryPath === repositoryPath) return this.currentSession.ingestor.ingestPending()
    this.deactivate()
    const locator = deriveRepositoryKey(repositoryPath)
    const dbPath = join(this.storageBaseDir, 'repositories', Buffer.from(repository.id).toString('base64url'), 'continuum.db')
    const store = new ArtifactStore(dbPath, repository.id)
    try {
      store.registerLocator(locator)
      let ingestor: ArtifactIngestor | undefined
      const service = new ContinuumService(store, () => ingestor?.ingestPending())
      migrateLegacyStore(join(this.storageBaseDir, locator, 'continuum.db'), locator, store, service)
      ingestor = new ArtifactIngestor(new ArtifactInbox(repositoryPath), service, locator)
      const report = ingestor.ingestPending()
      this.currentSession = { repositoryId: repository.id, repositoryPath, dbPath, store, service, ingestor }
      return report
    } catch (error) { store.close(); throw error }
  }
  deactivate(): void { const previous = this.currentSession; this.currentSession = null; previous?.store.close() }
  getActiveService(): ContinuumService | null { return this.currentSession?.service ?? null }
  getActiveSession(): ActiveRepositorySession | null { return this.currentSession }
  getStorageBaseDir(): string { return this.storageBaseDir }
  dispose(): void { this.deactivate() }
}
