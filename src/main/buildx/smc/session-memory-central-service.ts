import type {
  AppendSmcEntryInput,
  CreateSmcSessionInput,
  ListSmcEntriesOptions,
  ListSmcSessionsOptions,
  SmcEntryPage,
  SmcEntryRecord,
  SmcSessionRecord
} from '../../../shared/types/buildx/session-memory-central-types'
import type {
  DefineUnitFlowUnitInput,
  RegisterUnitFlowPlanInput,
  UnitFlowEligibilityResult,
  UnitFlowPlanRecord,
  UnitFlowUnitHeaderRecord,
  UnitFlowUnitRecord,
  UnitFlowUnitStateRecord
} from '../../../shared/types/buildx/unitflow-types'
import type {
  BuildXWorkspaceBindingRecord,
  SaveWorkspaceBindingInput
} from '../../../shared/types/buildx/workspace-types'
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

  registerPlan(repositoryId: string, sessionId: string, input: RegisterUnitFlowPlanInput): UnitFlowPlanRecord {
    return this.getStore(repositoryId).registerPlan(sessionId, input)
  }

  getActivePlan(repositoryId: string, sessionId: string): UnitFlowPlanRecord | null {
    return this.getStore(repositoryId).getActivePlan(sessionId)
  }

  getPlan(repositoryId: string, planId: string): UnitFlowPlanRecord | null {
    return this.getStore(repositoryId).getPlan(planId)
  }

  definePlanUnits(
    repositoryId: string,
    sessionId: string,
    planId: string,
    units: DefineUnitFlowUnitInput[]
  ): UnitFlowUnitRecord[] {
    return this.getStore(repositoryId).definePlanUnits(sessionId, planId, units)
  }

  listPlanUnits(
    repositoryId: string,
    sessionId: string,
    planId: string
  ): UnitFlowUnitHeaderRecord[] {
    return this.getStore(repositoryId).listPlanUnits(sessionId, planId)
  }

  getPlanUnit(
    repositoryId: string,
    sessionId: string,
    planId: string,
    unitId: string
  ): UnitFlowUnitRecord | null {
    return this.getStore(repositoryId).getPlanUnit(sessionId, planId, unitId)
  }

  getUnitState(
    repositoryId: string,
    sessionId: string,
    planId: string,
    unitId: string
  ): UnitFlowUnitStateRecord | null {
    return this.getStore(repositoryId).getUnitState(sessionId, planId, unitId)
  }

  getNextEligibleUnit(
    repositoryId: string,
    sessionId: string,
    planId: string
  ): UnitFlowEligibilityResult {
    return this.getStore(repositoryId).getNextEligibleUnit(sessionId, planId)
  }

  saveWorkspaceBinding(
    repositoryId: string,
    sessionId: string,
    input: SaveWorkspaceBindingInput
  ): BuildXWorkspaceBindingRecord {
    return this.getStore(repositoryId).saveWorkspaceBinding(sessionId, input)
  }

  getWorkspaceBinding(
    repositoryId: string,
    sessionId: string
  ): BuildXWorkspaceBindingRecord | null {
    return this.getStore(repositoryId).getWorkspaceBinding(sessionId)
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
