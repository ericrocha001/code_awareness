import { join } from 'node:path'
import { ArtifactStore } from './artifact-store'
import { ArtifactInbox } from './artifact-inbox'
import { ArtifactIngestor, type IngestionReport } from './artifact-ingestor'
import { deriveRepositoryKey } from './repository-key'
import type { IArtifactReader, ListArtifactsFilter } from './continuum-types'

export interface ActiveProjectSession {
  readonly projectPath: string
  readonly projectKey: string
  readonly dbPath: string
  readonly store: ArtifactStore
}

export class ProjectContinuumSession {
  private readonly storageBaseDir: string
  private currentSession: ActiveProjectSession | null = null

  constructor(storageBaseDir: string) {
    this.storageBaseDir = storageBaseDir
  }

  activate(projectPath: string): IngestionReport | null {
    if (!projectPath || typeof projectPath !== 'string') {
      return null
    }

    const projectKey = deriveRepositoryKey(projectPath)

    // Idempotent: if already active for this exact project, do not re-open store
    if (this.currentSession && this.currentSession.projectKey === projectKey) {
      try {
        const inbox = new ArtifactInbox(projectPath)
        const ingestor = new ArtifactIngestor(inbox, this.currentSession.store)
        return ingestor.ingestPending()
      } catch (error) {
        console.error('[ContinuumSession] Re-ingestion failed for active project:', error)
        return null
      }
    }

    // Changing project: close previous store
    this.deactivate()

    let store: ArtifactStore | null = null
    try {
      const dbPath = join(this.storageBaseDir, projectKey, 'continuum.db')
      store = new ArtifactStore(dbPath)

      const inbox = new ArtifactInbox(projectPath)
      const ingestor = new ArtifactIngestor(inbox, store)
      const report = ingestor.ingestPending()

      this.currentSession = {
        projectPath,
        projectKey,
        dbPath,
        store
      }

      return report
    } catch (error) {
      console.error('[ContinuumSession] Failed to activate project continuum:', error)
      if (store) {
        try {
          store.close()
        } catch {
          // Ignore close error during failure cleanup
        }
      }
      this.currentSession = null
      return null
    }
  }

  deactivate(): void {
    if (this.currentSession) {
      try {
        this.currentSession.store.close()
      } catch (error) {
        console.error('[ContinuumSession] Error closing store on deactivation:', error)
      }
      this.currentSession = null
    }
  }

  getActiveStore(): ArtifactStore | null {
    return this.currentSession?.store ?? null
  }

  getActiveReader(): IArtifactReader | null {
    if (!this.currentSession) return null
    const store = this.currentSession.store
    return {
      get: (id: string) => store.get(id),
      list: (filter?: ListArtifactsFilter) => store.list(filter)
    }
  }

  getActiveSession(): ActiveProjectSession | null {
    return this.currentSession
  }

  getStorageBaseDir(): string {
    return this.storageBaseDir
  }

  dispose(): void {
    this.deactivate()
  }
}
