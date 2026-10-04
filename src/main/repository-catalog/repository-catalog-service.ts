import { basename, resolve } from 'node:path'
import type { AppSettings, ProjectInfo } from '../../shared/types'
import type { RepositoryRecord, RepositoryStatus } from '../../shared/types/repository-catalog-types'
import type { GitHubRepositoryIdentity } from '../../shared/types/repository-catalog-types'
import type { WorkspaceService } from '../core/workspace-service'
import type { RepositoryCatalogStore } from './repository-catalog-store'

export interface RepositoryDestinationRegistrar {
  registerDestination(path: string, name: string): Promise<unknown>
}

export class RepositoryCatalogService {
  constructor(
    readonly store: RepositoryCatalogStore,
    private readonly discovery: WorkspaceService,
    private readonly destinations?: RepositoryDestinationRegistrar
  ) {}

  list(includeHidden = false): RepositoryRecord[] { return this.store.list(includeHidden) }

  listAvailable(): RepositoryRecord[] {
    return this.store.list().filter((record) => record.localCheckout?.availability === 'AVAILABLE')
  }

  findByPath(checkoutPath: string): RepositoryRecord | null {
    return this.store.findByNormalizedPath(normalizeRepositoryPath(checkoutPath))
  }

  findByGitHubRepositoryId(repositoryId: string): RepositoryRecord | null {
    return this.store.findByGitHubRepositoryId(repositoryId)
  }

  attachGitHub(repositoryId: string, identity: GitHubRepositoryIdentity): RepositoryRecord {
    return this.store.attachGitHub(repositoryId, identity)
  }

  createRemoteOnly(identity: GitHubRepositoryIdentity): RepositoryRecord {
    return this.store.createRemoteOnly(identity)
  }

  async attachLocalCheckout(repositoryId: string, checkoutPath: string): Promise<RepositoryRecord> {
    const info = await this.discovery.inspectLocalProject(checkoutPath)
    if (!info) throw new Error('LOCAL_CHECKOUT_UNAVAILABLE')
    const record = this.store.attachLocalCheckout(repositoryId, {
      path: resolve(info.path), normalizedPath: normalizeRepositoryPath(info.path), name: info.name,
      availability: 'AVAILABLE', gitState: info.isGit ? 'GIT' : 'NON_GIT'
    })
    await this.registerDestination(record)
    return record
  }

  markGitHubUnavailableExcept(repositoryIds: string[]): void {
    this.store.markGitHubUnavailableExcept(repositoryIds)
  }

  async initialize(settings: AppSettings): Promise<RepositoryRecord[]> {
    await this.migrateLegacy(settings)
    return this.refresh(settings)
  }

  async importLocal(checkoutPath: string): Promise<RepositoryRecord> {
    const info = await this.discovery.inspectLocalProject(checkoutPath)
    if (!info) throw new Error('LOCAL_CHECKOUT_UNAVAILABLE')
    const result = this.upsert(info, 'ACTIVE', true)
    await this.registerDestination(result.record)
    return result.record
  }

  async importRoot(rootPath: string): Promise<RepositoryRecord[]> {
    const discovered = await this.discovery.discoverRootFolder(rootPath)
    for (const info of discovered) {
      const result = this.upsert(info, undefined, false)
      if (result.created && result.record.status === 'ACTIVE') await this.registerDestination(result.record)
    }
    return this.list()
  }

  hide(id: string): RepositoryRecord {
    return this.store.setStatus(id, 'HIDDEN')
  }

  resolveAvailable(id: string): RepositoryRecord {
    const record = this.store.get(id)
    if (record.status !== 'ACTIVE') throw new Error('REPOSITORY_HIDDEN')
    if (!record.localCheckout || record.localCheckout.availability !== 'AVAILABLE') throw new Error('LOCAL_CHECKOUT_UNAVAILABLE')
    return record
  }

  async refresh(settings: AppSettings): Promise<RepositoryRecord[]> {
    for (const rootPath of settings.rootFolders ?? []) await this.importRoot(rootPath)
    for (const record of this.store.list(true)) {
      const checkout = record.localCheckout
      if (!checkout) continue
      const info = await this.discovery.inspectLocalProject(checkout.path)
      this.store.refreshCheckout(
        record.id,
        checkout.path,
        info ? 'AVAILABLE' : 'MISSING',
        info ? (info.isGit ? 'GIT' : 'NON_GIT') : checkout.gitState
      )
    }
    return this.list()
  }

  async migrateLegacy(settings: AppSettings): Promise<void> {
    if (this.store.isLegacyMigrationComplete()) return
    const hidden = new Set((settings.hiddenProjects ?? []).map(normalizeRepositoryPath))
    const discovered = new Map<string, ProjectInfo>()

    for (const checkoutPath of settings.individualProjects ?? []) {
      const info = await this.discovery.inspectLocalProject(checkoutPath)
      const normalized = normalizeRepositoryPath(checkoutPath)
      discovered.set(normalized, info ?? { path: resolve(checkoutPath), name: basename(resolve(checkoutPath)), isGit: false })
    }
    for (const rootPath of settings.rootFolders ?? []) {
      for (const info of await this.discovery.discoverRootFolder(rootPath)) discovered.set(normalizeRepositoryPath(info.path), info)
    }
    for (const checkoutPath of settings.hiddenProjects ?? []) {
      const normalized = normalizeRepositoryPath(checkoutPath)
      if (!discovered.has(normalized)) {
        const info = await this.discovery.inspectLocalProject(checkoutPath)
        discovered.set(normalized, info ?? { path: resolve(checkoutPath), name: basename(resolve(checkoutPath)), isGit: false })
      }
    }

    for (const [normalizedPath, info] of discovered) {
      const status: RepositoryStatus = hidden.has(normalizedPath) ? 'HIDDEN' : 'ACTIVE'
      const available = await this.discovery.inspectLocalProject(info.path)
      const result = this.store.upsertLocalCheckout({
        path: resolve(info.path), normalizedPath, name: info.name, status,
        availability: available ? 'AVAILABLE' : 'MISSING',
        gitState: available?.isGit ? 'GIT' : 'NON_GIT'
      })
      if (result.created && result.record.status === 'ACTIVE' && result.record.localCheckout?.availability === 'AVAILABLE') {
        await this.registerDestination(result.record)
      }
    }
    this.store.markLegacyMigrationComplete()
  }

  toLegacyProjects(): ProjectInfo[] {
    return this.listAvailable().map((record) => ({
      path: record.localCheckout!.path,
      name: record.name,
      isGit: record.localCheckout!.gitState === 'GIT'
    }))
  }

  private upsert(info: ProjectInfo, forcedStatus: RepositoryStatus | undefined, explicit: boolean) {
    const normalizedPath = normalizeRepositoryPath(info.path)
    const existing = this.store.findByNormalizedPath(normalizedPath)
    const status = explicit ? 'ACTIVE' : forcedStatus ?? existing?.status ?? 'ACTIVE'
    return this.store.upsertLocalCheckout({
      path: resolve(info.path), normalizedPath, name: info.name, status,
      availability: 'AVAILABLE', gitState: info.isGit ? 'GIT' : 'NON_GIT'
    })
  }

  private async registerDestination(record: RepositoryRecord): Promise<void> {
    if (!this.destinations || record.status !== 'ACTIVE' || record.localCheckout?.availability !== 'AVAILABLE') return
    await this.destinations.registerDestination(record.localCheckout.path, record.name)
  }
}

export function normalizeRepositoryPath(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}
