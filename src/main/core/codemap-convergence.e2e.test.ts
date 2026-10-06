import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeMapService } from './code-map-service'
import type { CompressionPort } from './compression-port'
import { createCodeMapSystemFixture } from './codemap-system-fixture'
import { createRepositoryModel, RepositoryModel } from './repository-model'
import { RepositorySynchronizer } from './repository-synchronizer'
import { repositoryEventBus, type RepositoryFileEvent } from './repository-events'
import { telemetryService, type TelemetryEntry } from './telemetry-service'
import { WatcherService } from './watcher-service'

const compression = {} as CompressionPort
const paths = ['src/core/BaseService.ts', 'src/core/AdminService.ts', 'src/core/UserService.ts']

describe('CodeMap convergence', () => {
  afterEach(() => vi.restoreAllMocks())

  it('converges three offline changes before symbol backfill with one causal chain', async () => {
    const fixture = createCodeMapSystemFixture()
    const watcher = new WatcherService()
    const service = new CodeMapService(watcher, compression)
    const events: RepositoryFileEvent[] = []
    const completed = (event: RepositoryFileEvent) => { events.push(event) }
    const logs: TelemetryEntry[] = []
    const unsubscribe = telemetryService.subscribe(entry => logs.push(entry))
    repositoryEventBus.onFileIndexed(completed)
    try {
      await service.openRepository(fixture.repoPath)
      await service.awaitMaintenance(fixture.repoPath)
      await service.indexRepository(fixture.repoPath)
      service.closeRepository(fixture.repoPath)
      paths.forEach((path, index) => fixture.write(path, `export class Offline${index} {}\n`))
      logs.length = 0
      await service.openRepository(fixture.repoPath)
      await service.awaitMaintenance(fixture.repoPath)
      expect(service.getModifiedFilesCount(fixture.repoPath)).toBe(0)
      expect(events.map(event => event.relativePath).sort()).toEqual([...paths].sort())
      expect(service.getElements(fixture.repoPath).filter(e => e.kind === 'class' && e.name.startsWith('Offline'))).toHaveLength(3)
      const detection = logs.find(entry => entry.event === 'RECONCILE_STARTED')!
      const completion = logs.filter(entry => entry.event === 'FILE_CONVERGED')
      expect(completion).toHaveLength(3)
      expect(completion.every(entry => entry.correlationId === detection.correlationId)).toBe(true)
      expect(logs.findIndex(entry => entry.event === 'BACKFILL_SYMBOL_REFERENCES_STARTED'))
        .toBeGreaterThan(logs.map(entry => entry.event).lastIndexOf('FILE_CONVERGED'))
      expect(service.getFiles(fixture.repoPath).every(file => file.status === 'indexed')).toBe(true)
    } finally {
      unsubscribe()
      repositoryEventBus.off('file:indexed', completed)
      service.closeAll()
      watcher.stop()
      await fixture.cleanup()
    }
  }, 60_000)

  it.each([false, true])('attempts persisted modified recovery once per open, failure=%s', async (failure) => {
    const fixture = createCodeMapSystemFixture()
    const model = createRepositoryModel(fixture.repoPath)
    const watcher = new WatcherService()
    const service = new CodeMapService(watcher, compression)
    const logs: TelemetryEntry[] = []
    const unsubscribe = telemetryService.subscribe(entry => logs.push(entry))
    try {
      await model.indexRepository()
      fixture.write(paths[0], 'export class PersistedRecovery {}\n')
      model.markFileModified(paths[0])
      model.close()
      const spy = vi.spyOn(RepositoryModel.prototype, 'updateFileContent')
      if (failure) spy.mockRejectedValue(new Error('recovery failure'))
      await service.openRepository(fixture.repoPath)
      await service.awaitMaintenance(fixture.repoPath)
      const recoveryCid = logs.find(entry => entry.event === 'SYNC_BATCH_STARTED')!.correlationId
      expect(spy.mock.calls.filter(([path, cid]) => path === paths[0] && cid === recoveryCid)).toHaveLength(1)
      expect(service.getModifiedFilesCount(fixture.repoPath)).toBe(failure ? 1 : 0)
      expect(service.getFiles(fixture.repoPath).find(file => file.relativePath === paths[0])?.status)
        .toBe(failure ? 'modified' : 'indexed')
    } finally {
      unsubscribe()
      service.closeAll()
      watcher.stop()
      model.close()
      await fixture.cleanup()
    }
  }, 60_000)

  it('periodic scan consumes new divergences but never retries a failing historical backlog', async () => {
    const fixture = createCodeMapSystemFixture()
    const model = createRepositoryModel(fixture.repoPath)
    let synchronizer: RepositorySynchronizer | undefined
    const events: RepositoryFileEvent[] = []
    const completed = (event: RepositoryFileEvent) => events.push(event)
    repositoryEventBus.onFileIndexed(completed)
    try {
      await model.indexRepository()
      synchronizer = new RepositorySynchronizer(model, model.getRepositoryId())
      fixture.write(paths[0], 'export class PeriodicCurrent {}\n')
      fixture.write(paths[1], 'export class FailingPending {}\n')
      const realUpdate = model.updateFileContent.bind(model)
      const update = vi.spyOn(model, 'updateFileContent').mockImplementation((path, cid, change) => {
        if (path === paths[1]) return Promise.reject(new Error('persistent failure'))
        return realUpdate(path, cid, change)
      })
      const scan = () => (synchronizer as unknown as { runPeriodicScan(): Promise<void> }).runPeriodicScan()
      await scan()
      expect(events.map(event => event.relativePath)).toEqual([paths[0]])
      expect(model.getFileByRelativePath(paths[0])?.status).toBe('indexed')
      expect(model.getFileByRelativePath(paths[1])?.status).toBe('modified')
      expect(synchronizer.getModifiedFilesCount()).toBe(1)
      await scan()
      await scan()
      expect(update.mock.calls.filter(([path]) => path === paths[1])).toHaveLength(1)
      update.mockRestore()
      expect(await synchronizer.synchronizeModified()).toEqual({ filesUpdated: 1, errors: [] })
      expect(synchronizer.getModifiedFilesCount()).toBe(0)
      expect(events.map(event => event.relativePath)).toEqual([paths[0], paths[1]])
    } finally {
      repositoryEventBus.off('file:indexed', completed)
      synchronizer?.dispose()
      model.close()
      await fixture.cleanup()
    }
  }, 60_000)

  it('emits watcher confirmation before completion and publishes no success on failure', async () => {
    const fixture = createCodeMapSystemFixture()
    const model = createRepositoryModel(fixture.repoPath)
    let synchronizer: RepositorySynchronizer | undefined
    const order: string[] = []
    const confirmed = () => order.push('confirmed')
    const indexed = () => order.push('indexed')
    repositoryEventBus.onFileConfirmed(confirmed)
    repositoryEventBus.onFileIndexed(indexed)
    try {
      await model.indexRepository()
      synchronizer = new RepositorySynchronizer(model, model.getRepositoryId())
      fixture.write(paths[0], 'export class WatcherCurrent {}\n')
      repositoryEventBus.emitFileModified(model.getRepositoryId(), paths[0])
      await synchronizer.waitForIdle()
      expect(order).toEqual(['confirmed', 'indexed'])
      order.length = 0
      fixture.write(paths[0], 'export class WatcherPending {}\n')
      vi.spyOn(model, 'updateFileContent').mockRejectedValue(new Error('watcher failure'))
      repositoryEventBus.emitFileModified(model.getRepositoryId(), paths[0])
      await synchronizer.waitForIdle()
      expect(order).toEqual(['confirmed'])
      expect(synchronizer.getModifiedFilesCount()).toBe(1)
      expect(model.getFileByRelativePath(paths[0])?.status).toBe('modified')
    } finally {
      repositoryEventBus.off('file:confirmed', confirmed)
      repositoryEventBus.off('file:indexed', indexed)
      synchronizer?.dispose()
      model.close()
      await fixture.cleanup()
    }
  }, 60_000)
})
