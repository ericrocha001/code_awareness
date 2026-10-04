import { ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { AcademyCreateInput, AcademyPackage, AcademyUpdateInput } from '../../shared/types/academy-types'
import type { AcademyService } from '../academy/academy-service'

export function registerAcademyHandlers(service: AcademyService): void {
  ipcMain.handle('academy:snapshot', () => service.snapshot())
  ipcMain.handle('academy:get', (_event, id: string) => service.get(id))
  ipcMain.handle('academy:history', (_event, id: string) => service.history(id))
  ipcMain.handle('academy:create', (_event, input: Omit<AcademyCreateInput, 'origin'>) => service.create({ ...input, origin: 'UI' }))
  ipcMain.handle('academy:update', (_event, input: Omit<AcademyUpdateInput, 'origin'>) => service.update({ ...input, origin: 'UI' }))
  ipcMain.handle('academy:archive', (_event, id: string, expectedVersion: number) => service.archive(id, expectedVersion))
  ipcMain.handle('academy:restore', (_event, id: string, expectedVersion: number) => service.restore(id, expectedVersion))
  ipcMain.handle('academy:destination-enabled', (_event, id: string, enabled: boolean) => service.setDestinationEnabled(id, enabled))
  ipcMain.handle('academy:import-destination', async (_event, id: string) => {
    const destination = service.store.listDestinations().find((item) => item.id === id)
    if (!destination) throw new Error('DESTINATION_NOT_FOUND')
    return service.import(join(destination.path, '.skills'), destination.id)
  })
  ipcMain.handle('academy:resolve-conflict', (_event, id: string, resolution: 'CANONICAL' | 'DIVERGENT', reconciledPackage?: AcademyPackage) => service.resolveConflict(id, resolution, reconciledPackage))
  ipcMain.handle('academy:distribution-health', () => service.getDistributionHealth())
  ipcMain.handle('academy:distribution-states', (_event, skillId?: string) => service.listDistributionStates(skillId))
  ipcMain.handle('academy:distribution-reconcile', (_event, destinationId?: string) => service.reconcileDistribution(destinationId))
  ipcMain.handle('academy:openai-bootstrap', (_event, publishedVersion?: string) => service.bootstrapOpenAiPlugin(undefined, publishedVersion))
  ipcMain.handle('academy:openai-state', () => service.getOpenAiPublicationState())
  ipcMain.handle('academy:package-distribution-state', () => service.getPackageDistributionState())
  ipcMain.handle('academy:openai-releases', () => service.listOpenAiReleases())
  ipcMain.handle('academy:openai-prepare', () => service.prepareOpenAiRelease())
  ipcMain.handle('academy:openai-confirm-upload', (_event, releaseId: string, artifactHash: string) => service.confirmOpenAiUpload(releaseId, artifactHash))
  ipcMain.handle('academy:openai-reveal', (_event, releaseId: string) => {
    const release = service.getOpenAiRelease(releaseId)
    if (!release.artifactPath) throw new Error('OPENAI_RELEASE_ARTIFACT_MISSING')
    shell.showItemInFolder(release.artifactPath)
    return true
  })
  ipcMain.handle('academy:git-status', () => {
    return service.gitSync?.getStatus() ?? {
      profile: null,
      repository: null,
      syncState: 'UNCONFIGURED',
      lastSyncAt: null,
      lastCommitSha: null,
      lastError: null
    }
  })
  ipcMain.handle('academy:git-sync-now', async () => {
    if (!service.gitSync) throw new Error('GIT_SYNC_NOT_CONFIGURED')
    return service.gitSync.syncNow()
  })
  ipcMain.handle('academy:git-bind', async (_event, repositoryCatalogId: string) => {
    if (!service.gitSync) throw new Error('GIT_SYNC_NOT_CONFIGURED')
    return service.gitSync.bindRepository(repositoryCatalogId)
  })
  ipcMain.handle('academy:git-eligible-repos', () => {
    return service.gitSync?.listEligibleRepositories() ?? []
  })
  ipcMain.handle('academy:git-open-repo', async () => {
    const status = service.gitSync?.getStatus()
    if (!status?.repository?.checkoutPath) throw new Error('NO_REPOSITORY_BOUND')
    await shell.openPath(status.repository.checkoutPath)
    return true
  })
}
