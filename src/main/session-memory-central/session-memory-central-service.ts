import type {
  AppendSmcEntryInput,
  CreateSmcSessionInput,
  ListSmcEntriesOptions,
  ListSmcSessionsOptions,
  SmcEntryPage,
  SmcEntryRecord,
  SmcSessionRecord
} from '../../shared/types/session-memory-central-types'
import { smcDatabasePath, validateRepositoryId } from './session-memory-central-paths'
import { SessionMemoryCentralStore } from './session-memory-central-store'

export class SessionMemoryCentralService {
  private readonly stores = new Map<string, SessionMemoryCentralStore>()

  constructor(readonly storageBaseDir: string) {
    if (!storageBaseDir || typeof storageBaseDir !== 'string' || !storageBaseDir.trim()) {
      throw new Error('STORAGE_BASE_DIR_REQUIRED: Canonical storage base directory must be provided.')
    }
  }

  getStore(repositoryId: string): SessionMemoryCentralStore {
    const validRepoId = validateRepositoryId(repositoryId)
    const existing = this.stores.get(validRepoId)
    if (existing && existing.isOpen()) {
      return existing
    }

    const dbPath = smcDatabasePath(this.storageBaseDir, validRepoId)
    const store = new SessionMemoryCentralStore(dbPath, validRepoId)
    this.stores.set(validRepoId, store)
    return store
  }

  createSession(repositoryId: string, input?: CreateSmcSessionInput): SmcSessionRecord {
    return this.getStore(repositoryId).createSession(input)
  }

  getSession(repositoryId: string, sessionId: string): SmcSessionRecord | null {
    return this.getStore(repositoryId).getSession(sessionId)
  }

  listSessions(repositoryId: string, options?: ListSmcSessionsOptions): SmcSessionRecord[] {
    return this.getStore(repositoryId).listSessions(options)
  }

  appendEntry(repositoryId: string, sessionId: string, input: AppendSmcEntryInput): SmcEntryRecord {
    return this.getStore(repositoryId).appendEntry(sessionId, input)
  }

  getEntry(repositoryId: string, sessionId: string, entryId: string): SmcEntryRecord | null {
    return this.getStore(repositoryId).getEntry(sessionId, entryId)
  }

  listEntries(repositoryId: string, sessionId: string, options?: ListSmcEntriesOptions): SmcEntryPage {
    return this.getStore(repositoryId).listEntries(sessionId, options)
  }

  closeStore(repositoryId: string): void {
    const validRepoId = validateRepositoryId(repositoryId)
    const store = this.stores.get(validRepoId)
    if (store) {
      store.close()
      this.stores.delete(validRepoId)
    }
  }

  close(): void {
    for (const store of this.stores.values()) {
      try {
        store.close()
      } catch {
        // Ignora erros no encerramento de stores individuais
      }
    }
    this.stores.clear()
  }
}
