import { BrowserWindow, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AcademyCreateInput, AcademyPackage, AcademyUpdateInput } from '../../shared/types/academy-types'
import type { AcademyService } from '../academy/academy-service'

export function registerAcademyHandlers(service: AcademyService): void {
  const changed = (kind: 'catalog' | 'distribution' | 'git' | 'publication') => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('academy:changed', { kind }) }
  service.onCanonicalChange?.(() => changed('catalog'))
  service.onDistributionChange?.(changed)
  ipcMain.handle('academy:snapshot', () => service.snapshot())
  ipcMain.handle('academy:bootstrap', (_event, initializationId: string) => {
    if (typeof initializationId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(initializationId)) throw new Error('INVALID_ARGUMENT')
    return service.getAcademyBootstrapState(initializationId)
  })
  ipcMain.handle('academy:git-check', () => service.gitSync?.verifyRemote() ?? service.getAcademyBootstrapState('unconfigured').git)
  ipcMain.handle('academy:get', (_event, id: string) => service.get(id))
  ipcMain.handle('academy:history', (_event, id: string) => service.history(id))
  ipcMain.handle('academy:create', (_event, input: Omit<AcademyCreateInput, 'origin'>) => service.saveNewSkill({ ...input, origin: 'UI' }))
  ipcMain.handle('academy:update', (_event, input: Omit<AcademyUpdateInput, 'origin'>) => service.saveSkill({ ...input, origin: 'UI' }))
  ipcMain.handle('academy:git-draft', (_event, name: string) => service.gitSync?.getDraft(name))
  ipcMain.handle('academy:local-cutover', (_event, confirmed: boolean) => service.gitSync?.completeLocalCutover(confirmed))
  ipcMain.handle('academy:approve-public', (_event, id: string, version: number, confirmed: boolean) => service.approvePublicSkill(id, version, confirmed))
  ipcMain.handle('academy:approve-public-batch', (_event, items: Array<{ skillId: string; expectedVersion: number }>, confirmed: boolean) => service.approvePublicSkills(items, confirmed))
  ipcMain.handle('academy:publication-preference', () => service.getPublicationPreference())
  ipcMain.handle('academy:publication-preference-set', (_event, enabled: boolean, confirmed: boolean) => service.setPublicationPreference(enabled, confirmed))
  ipcMain.handle('academy:delete-global', (_event, id: string, version: number, confirmed: boolean) => service.deleteGlobalSkill(id, version, confirmed))
  ipcMain.handle('academy:git-publish', (_event, expected: { localHead: string; remoteHead: string | null }) => {
    if (!expected || !/^[a-f0-9]{40,64}$/.test(expected.localHead) || !expected.remoteHead || !/^[a-f0-9]{40,64}$/.test(expected.remoteHead)) throw new Error('PUBLICATION_REVIEW_REQUIRED')
    return service.gitSync?.publish(expected)
  })
  ipcMain.handle('academy:git-candidate', (_event, input) => service.gitSync?.publishCandidate(input))
  ipcMain.handle('academy:git-delete-draft', (_event, input) => service.gitSync?.deleteDraft(input))
  ipcMain.handle('academy:git-automation', (_event, input) => service.gitSync?.configureAutomation(input))
  ipcMain.handle('academy:git-refresh', () => service.gitSync?.refreshAutomatically())
  ipcMain.handle('academy:git-migration', (_event, head: string, hash: string, confirmed: boolean) => service.gitSync?.completeMigration(head, hash, confirmed))
  ipcMain.handle('academy:git-conflict-review', (_event, path: string) => service.gitSync?.reviewGitConflict(path))
  ipcMain.handle('academy:git-conflict-resolve', (_event, input) => service.gitSync?.resolveGitConflict(input))
  ipcMain.handle('academy:archive', (_event, id: string, expectedVersion: number) => service.archive(id, expectedVersion))
  ipcMain.handle('academy:set-enabled', (_event, id: string, enabled: boolean, expectedStateRevision: number) => service.setEnabled(id, enabled, expectedStateRevision))
  ipcMain.handle('academy:restore', (_event, id: string, expectedVersion: number) => service.restore(id, expectedVersion))
  ipcMain.handle('academy:destination-enabled', (_event, id: string, enabled: boolean) => service.setDestinationEnabled(id, enabled))
  ipcMain.handle('academy:import-destination', async (_event, id: string) => {
    const destination = service.store.listDestinations().find((item) => item.id === id)
    if (!destination) throw new Error('DESTINATION_NOT_FOUND')
    return service.import(join(destination.path, '.skills'), destination.id)
  })
  ipcMain.handle('academy:conflict-review', (_event, id: string, reconciledPackage?: AcademyPackage) => service.reviewConflict(id, reconciledPackage))
  ipcMain.handle('academy:conflict-batch-preview', () => service.previewConflictBatch())
  ipcMain.handle('academy:conflict-batch-resolve', (_event, token: string, confirmed: boolean) => service.resolveConflictBatch(token, confirmed))
  ipcMain.handle('academy:resolve-conflict', (_event, id: string, resolution: 'CANONICAL' | 'DIVERGENT', reconciledPackage?: AcademyPackage, approval?: { token: string; confirmed: boolean }) => service.resolveConflict(id, resolution, reconciledPackage, approval))
  ipcMain.handle('academy:distribution-health', () => service.getDistributionHealth())
  ipcMain.handle('academy:distribution-states', (_event, skillId?: string) => service.listDistributionStates(skillId))
  ipcMain.handle('academy:delivery-status', (_event, skillId: string, expectedVersion?: number) => service.getDeliveryStatus(skillId, expectedVersion))
  ipcMain.handle('academy:distribution-reconcile', (_event, destinationId?: string) => service.reconcileDistribution(destinationId))
  ipcMain.handle('academy:openai-bootstrap', (_event, publishedVersion?: string) => service.bootstrapOpenAiPlugin(undefined, publishedVersion))
  ipcMain.handle('academy:openai-state', () => service.getOpenAiPublicationState())
  ipcMain.handle('academy:manifest-version-preview', (_event, kind?: 'PATCH' | 'MINOR' | 'MAJOR') => {
    if (kind !== undefined && !['PATCH', 'MINOR', 'MAJOR'].includes(kind)) throw new Error('INVALID_ARGUMENT')
    return service.previewManifestVersion(kind)
  })
  ipcMain.handle('academy:manifest-version-save', (_event, input: { preview: import('../../shared/types/academy-publication-types').AcademyManifestPreview; confirmed: boolean }) => {
    if (!service.gitSync) throw new Error('GIT_SYNC_NOT_CONFIGURED')
    return service.gitSync.saveManifestDraft(input)
  })
  ipcMain.handle('academy:package-distribution-state', () => service.getPackageDistributionState())
  ipcMain.handle('academy:openai-releases', () => service.listOpenAiReleases())
  ipcMain.handle('academy:openai-prepare', (_event, input?: import('../../shared/types/academy-git-source-types').AcademyGitBuildRequest) => {
    const request = input ?? { mode: 'LATEST' }
    if (request.mode === 'LATEST' && request.force !== undefined && typeof request.force !== 'boolean') throw new Error('INVALID_ARGUMENT')
    if (request.mode !== 'LATEST' && (request.mode !== 'REBUILD' || !/^[a-f0-9]{40,64}$/.test(request.sourceCommitSha))) throw new Error('INVALID_ARGUMENT')
    return service.prepareOpenAiRelease(request)
  })
  ipcMain.handle('academy:openai-confirm-upload', (_event, releaseId: string, artifactHash: string) => service.confirmOpenAiUpload(releaseId, artifactHash))
  ipcMain.handle('academy:openai-reveal', (_event, releaseId: string) => {
    const release = service.getOpenAiRelease(releaseId)
    if (!release.artifactPath) throw new Error('OPENAI_RELEASE_ARTIFACT_MISSING')
    shell.showItemInFolder(release.artifactPath)
    return true
  })
  ipcMain.handle('academy:gemini-export-state', () => service.getGeminiExportState())
  ipcMain.handle('academy:gemini-export-prepare', () => service.prepareGeminiExport())
  ipcMain.handle('academy:gemini-export-reveal', async () => {
    const path = await service.getGeminiExportArtifactPath()
    if (!path || !existsSync(path)) throw new Error('GEMINI_EXPORT_ARTIFACT_MISSING')
    shell.showItemInFolder(path)
    return path
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
  ipcMain.handle('academy:git-resolve-conflict', async (_event, expectedRemoteHead: string | null, expectedDesiredTree: string) => {
    if (!service.gitSync) throw new Error('GIT_SYNC_NOT_CONFIGURED')
    if ((expectedRemoteHead !== null && !/^[a-f0-9]{40,64}$/.test(expectedRemoteHead)) || typeof expectedDesiredTree !== 'string') throw new Error('INVALID_ARGUMENT')
    return service.gitSync.resolveManagedConflict(expectedRemoteHead, expectedDesiredTree)
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
