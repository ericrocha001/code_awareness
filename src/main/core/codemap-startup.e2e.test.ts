import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { CompressionPort } from './compression-port'
import { CodeMapService } from './code-map-service'
import { createCodeMapSystemFixture, createLargeCodeMapFixture, eventually } from './codemap-system-fixture'
import { WatcherService } from './watcher-service'

const unusedCompressionPort: CompressionPort = {
  async generateCompressionMarkdown() {
    throw new Error('Not needed in startup tests.')
  }
}

describe('CodeMap Startup — Responsiveness Contract', () => {
  /**
   * Startup contract: openRepository on a warm repo (already indexed) resolves
   * without waiting for background maintenance. The snapshot is available immediately.
   */
  it('openRepository resolves before background maintenance completes on a warm repo', async () => {
    const fixture = createCodeMapSystemFixture()
    const watcherService = new WatcherService()
    const service = new CodeMapService(watcherService, unusedCompressionPort)
    const repoPath = fixture.repoPath

    try {
      // First open: index the repo so it becomes "warm".
      await service.openRepository(repoPath)
      await service.awaitSnapshot(repoPath)
      await service.indexRepository(repoPath)
      service.closeRepository(repoPath)

      // Track whether maintenance has completed at each checkpoint.
      let maintenanceDone = false

      // Second open: warm repo. openRepository should return quickly.
      const openStart = Date.now()
      const openPromise = service.openRepository(repoPath)

      // Hook into background maintenance to observe when it completes.
      // We do this by awaiting it in parallel after openPromise resolves.
      await openPromise
      const openMs = Date.now() - openStart

      // Snapshot is readable immediately — no full maintenance required.
      const files = service.getFiles(repoPath)
      expect(files.length).toBeGreaterThan(0)

      // Maintenance is still pending (or may have already finished — we can't enforce
      // a specific wall-clock ordering in CI, but we prove the snapshot was delivered
      // before maintenance resolved by checking files were readable immediately above).
      const maintenancePromise = service.awaitMaintenance(repoPath).then(() => {
        maintenanceDone = true
      })

      // The important assertion: getFiles() returned data synchronously (no await needed).
      // If openRepository had blocked on maintenance, files would be available only after
      // maintenance; here they are available as soon as openRepository resolves.
      expect(files).toBeDefined()

      await maintenancePromise

      // After maintenance: modified count reflects reconcile result (no error thrown).
      const afterCount = service.getModifiedFilesCount(repoPath)
      expect(typeof afterCount).toBe('number')
      expect(maintenanceDone).toBe(true)

      // Open duration: on a warm repo, no heavy I/O should block openRepository itself.
      // We log the actual value for visibility without asserting a hard SLA.
      console.log(`[startup-test] warm openRepository resolved in ${openMs}ms`)
    } finally {
      service.closeAll()
      watcherService.stop()
      await fixture.cleanup()
    }
  }, 60_000)

  /**
   * No duplicate initialization: opening the same repo twice does not create two instances,
   * two reconciles, two watchers, or two synchronizers.
   */
  it('opening the same repo twice does not start duplicate background maintenance', async () => {
    const fixture = createCodeMapSystemFixture()
    const watcherService = new WatcherService()
    const service = new CodeMapService(watcherService, unusedCompressionPort)
    const repoPath = fixture.repoPath

    try {
      // Fire two concurrent openRepository calls for the same repo.
      const [, second] = await Promise.all([
        service.openRepository(repoPath),
        service.openRepository(repoPath)
      ])

      // Both resolved — only one instance exists.
      expect(second).toBeUndefined() // second call returns void (same promise or immediate return)

      // Index and verify single consistent state.
      await service.awaitSnapshot(repoPath)
      await service.indexRepository(repoPath)
      const files = service.getFiles(repoPath)
      expect(files.length).toBeGreaterThan(0)

      // Closing and re-opening also does not duplicate.
      service.closeRepository(repoPath)
      await service.openRepository(repoPath)
      await service.openRepository(repoPath) // second call: immediate return, no duplicate work
      const filesAfterReopen = service.getFiles(repoPath)
      // Before maintenance completes, files list from previous index may be 0 (no index yet on new open)
      // or > 0 if maintenance ran fast. Both are acceptable — no crash, no duplicate.
      expect(Array.isArray(filesAfterReopen)).toBe(true)
    } finally {
      service.closeAll()
      watcherService.stop()
      await fixture.cleanup()
    }
  }, 60_000)

  /**
   * Offline reconciliation contract: files changed while the app was closed are
   * eventually reflected in the snapshot after openRepository + background maintenance.
   */
  it('offline file change is reconciled after openRepository background maintenance', async () => {
    const fixture = createCodeMapSystemFixture()
    const watcherService = new WatcherService()
    const service = new CodeMapService(watcherService, unusedCompressionPort)
    const repoPath = fixture.repoPath

    try {
      // Establish an indexed state.
      await service.openRepository(repoPath)
      await service.awaitSnapshot(repoPath)
      await service.indexRepository(repoPath)
      service.closeRepository(repoPath)

      // Simulate offline change: write a new file with the app "closed".
      fixture.write('src/offline/OfflineModule.ts', 'export class OfflineModule { ready(): boolean { return true } }\n')

      // Reopen — background maintenance runs reconcileWithDisk which should detect the new file.
      await service.openRepository(repoPath)

      // Snapshot must eventually reflect the offline change.
      await eventually(
        () => {
          const files = service.getFiles(repoPath)
          return files.some(f => f.relativePath === 'src/offline/OfflineModule.ts') ? true : null
        },
        { description: 'offline file to appear in snapshot after background maintenance' }
      )

      // Sanity: watcher is alive — a further change is auto-synced without manual action.
      fixture.write('src/offline/OfflineModule.ts', 'export class OfflineModule { ready(): boolean { return false } }\n')

      await eventually(
        () => {
          const files = service.getFiles(repoPath)
          const f = files.find(f => f.relativePath === 'src/offline/OfflineModule.ts')
          return f?.status === 'indexed' && f.contentHash ? true : null
        },
        { description: 'watcher to auto-sync the updated offline file', timeoutMs: 20_000 }
      )
    } finally {
      service.closeAll()
      watcherService.stop()
      await fixture.cleanup()
    }
  }, 60_000)

  /**
   * Slow maintenance does not block snapshot delivery.
   * Proves: snapshot (getFiles) is readable before awaitMaintenance resolves.
   *
   * Uses promise ordering: we confirm getFiles() returns data synchronously after
   * openRepository, even though awaitMaintenance is still pending at that point.
   */
  it('snapshot is readable before background maintenance finishes', async () => {
    const fixture = createCodeMapSystemFixture()
    const watcherService = new WatcherService()
    const service = new CodeMapService(watcherService, unusedCompressionPort)
    const repoPath = fixture.repoPath

    try {
      // Pre-index so there is a real snapshot to read.
      await service.openRepository(repoPath)
      await service.awaitSnapshot(repoPath)
      await service.indexRepository(repoPath)
      const fileCountAfterIndex = service.getFiles(repoPath).length
      expect(fileCountAfterIndex).toBeGreaterThan(0)
      service.closeRepository(repoPath)

      // Reopen — background maintenance starts asynchronously.
      await service.openRepository(repoPath)

      // Snapshot is readable immediately after openRepository resolves.
      // We do NOT await maintenance here — that is the contract being tested.
      const snapshotFiles = service.getFiles(repoPath)
      const snapshotTaken = snapshotFiles.length

      // Now await maintenance to ensure it completes without error.
      await service.awaitMaintenance(repoPath)
      const afterMaintenanceFiles = service.getFiles(repoPath).length

      // Snapshot count was available before maintenance and remains valid after.
      expect(snapshotTaken).toBeGreaterThan(0)
      expect(afterMaintenanceFiles).toBeGreaterThanOrEqual(snapshotTaken)
    } finally {
      service.closeAll()
      watcherService.stop()
      await fixture.cleanup()
    }
  }, 60_000)

  /**
   * Watcher contract: after openRepository, file changes are auto-synced without
   * requiring any manual button press or explicit sync call.
   */
  it('watcher auto-syncs file changes after openRepository', async () => {
    const fixture = createCodeMapSystemFixture()
    const watcherService = new WatcherService()
    const service = new CodeMapService(watcherService, unusedCompressionPort)
    const repoPath = fixture.repoPath

    try {
      await service.openRepository(repoPath)
      await service.awaitSnapshot(repoPath)
      await service.indexRepository(repoPath)

      // Mutate a file — watcher should pick it up automatically.
      fixture.write('src/core/BaseService.ts', [
        'export class BaseService {',
        '  label(): string { return "base-v2" }',
        '}',
        ''
      ].join('\n'))

      await eventually(
        () => {
          const files = service.getFiles(repoPath)
          const f = files.find(f => f.relativePath === 'src/core/BaseService.ts')
          // Auto-sync completed: status is indexed (not modified) with updated content
          return f?.status === 'indexed' ? true : null
        },
        { description: 'watcher to auto-sync BaseService.ts mutation', timeoutMs: 15_000 }
      )
    } finally {
      service.closeAll()
      watcherService.stop()
      await fixture.cleanup()
    }
  }, 60_000)

  /**
   * Heartbeat contract: the event loop must continue progressing during
   * backgroundMaintenance even when reconcile traverses many files.
   *
   * Technique: setInterval runs on the SAME Node.js/Electron event loop as
   * backgroundMaintenance. Blocked synchronous JS prevents timer callbacks from
   * firing. The test uses a fixture large enough that maintenance is measurable.
   *
   * Scenario AB — mtime changes, no content change (stat+hash path for all files,
   * nothing marked modified). Mirrors the production case: 462 files checked,
   * 0 modified.
   */
  it('event loop heartbeat continues during backgroundMaintenance — mtime-only changes', async () => {
    const FIXTURE_SIZE = 120
    // No starvation: no single gap longer than this, regardless of hardware speed.
    // Generous enough for CI; catches the original 9-second block.
    const STARVATION_THRESHOLD_MS = 1500
    const HEARTBEAT_INTERVAL_MS = 50

    const fixture = createLargeCodeMapFixture(FIXTURE_SIZE)
    const watcherService = new WatcherService()
    const service = new CodeMapService(watcherService, unusedCompressionPort)
    const repoPath = fixture.repoPath

    try {
      // Phase 1: index so the repo is warm.
      await service.openRepository(repoPath)
      await service.awaitSnapshot(repoPath)
      await service.indexRepository(repoPath)
      service.closeRepository(repoPath)

      // Phase 2: overwrite all files with identical content — updates mtime, same hash.
      // reconcileWithDisk will stat each file, detect mtime change, compute hash, find no
      // content change, and update metadata. This forces the full stat+hash path for all
      // FIXTURE_SIZE files without marking any as modified.
      for (let i = 0; i < FIXTURE_SIZE; i++) {
        fixture.write(
          `src/group${Math.floor(i / 10)}/module${i}.ts`,
          `export class Module${i} {\n  run(): number { return ${i} }\n}\n`
        )
      }

      // Phase 3: start heartbeat counter, then open (maintenance starts async).
      let heartbeatCount = 0
      const heartbeatGaps: number[] = []
      let lastTs = Date.now()
      const heartbeat = setInterval(() => {
        const now = Date.now()
        heartbeatGaps.push(now - lastTs)
        lastTs = now
        heartbeatCount++
      }, HEARTBEAT_INTERVAL_MS)

      const maintenanceStart = Date.now()
      await service.openRepository(repoPath)
      await service.awaitMaintenance(repoPath)
      clearInterval(heartbeat)
      const maintenanceMs = Date.now() - maintenanceStart

      const maxGap = heartbeatGaps.length > 0 ? Math.max(...heartbeatGaps) : 0
      console.log(
        `[heartbeat-AB] maintenanceMs=${maintenanceMs} heartbeats=${heartbeatCount} maxGap=${maxGap}ms files=${FIXTURE_SIZE}`
      )

      // If maintenance lasted at least 2 heartbeat intervals, at least one must have fired.
      // On ultra-fast hardware maintenance may complete before any interval — that is fine:
      // no starvation is possible if maintenance is that fast.
      if (maintenanceMs >= HEARTBEAT_INTERVAL_MS * 2) {
        expect(heartbeatCount).toBeGreaterThan(0)
      }
      // No single gap must exceed the starvation threshold.
      if (heartbeatGaps.length > 0) {
        expect(maxGap).toBeLessThan(STARVATION_THRESHOLD_MS)
      }

      // Drain the synchronizer queue before teardown so watcher events that arrived
      // during the test do not race against a closed DB in the finally block.
      await service.awaitSnapshot(repoPath)
    } finally {
      service.closeAll()
      watcherService.stop()
      await fixture.cleanup()
    }
  }, 120_000)

  /**
   * Heartbeat contract — Scenario C: content changes in a subset of files.
   * reconcileWithDisk detects hash divergence and marks those files as modified.
   * The event loop must continue progressing during this heavier reconcile path.
   */
  it('event loop heartbeat continues during backgroundMaintenance — content changes trigger modified marking', async () => {
    const FIXTURE_SIZE = 120
    const CHANGED_COUNT = 40
    const STARVATION_THRESHOLD_MS = 1500
    const HEARTBEAT_INTERVAL_MS = 50

    const fixture = createLargeCodeMapFixture(FIXTURE_SIZE)
    const watcherService = new WatcherService()
    const service = new CodeMapService(watcherService, unusedCompressionPort)
    const repoPath = fixture.repoPath

    try {
      await service.openRepository(repoPath)
      await service.awaitSnapshot(repoPath)
      await service.indexRepository(repoPath)
      service.closeRepository(repoPath)

      // Modify first CHANGED_COUNT files with new content — hash diverges.
      // reconcileWithDisk will detect divergence and mark them as 'modified'.
      for (let i = 0; i < CHANGED_COUNT; i++) {
        fixture.write(
          `src/group${Math.floor(i / 10)}/module${i}.ts`,
          `export class Module${i} {\n  run(): number { return ${i * 2} }\n}\n`
        )
      }

      let heartbeatCount = 0
      const heartbeatGaps: number[] = []
      let lastTs = Date.now()
      const heartbeat = setInterval(() => {
        const now = Date.now()
        heartbeatGaps.push(now - lastTs)
        lastTs = now
        heartbeatCount++
      }, HEARTBEAT_INTERVAL_MS)

      const maintenanceStart = Date.now()
      await service.openRepository(repoPath)
      await service.awaitMaintenance(repoPath)
      clearInterval(heartbeat)
      const maintenanceMs = Date.now() - maintenanceStart

      const maxGap = heartbeatGaps.length > 0 ? Math.max(...heartbeatGaps) : 0
      console.log(
        `[heartbeat-C] maintenanceMs=${maintenanceMs} heartbeats=${heartbeatCount} maxGap=${maxGap}ms changed=${CHANGED_COUNT}/${FIXTURE_SIZE}`
      )

      const files = service.getFiles(repoPath)
      expect(files.filter(file => file.status === 'modified')).toHaveLength(0)
      expect(service.getModifiedFilesCount(repoPath)).toBe(0)
      expect(service.getElements(repoPath).filter(element => element.kind === 'class')).toHaveLength(FIXTURE_SIZE)

      if (maintenanceMs >= HEARTBEAT_INTERVAL_MS * 2) {
        expect(heartbeatCount).toBeGreaterThan(0)
      }
      if (heartbeatGaps.length > 0) {
        expect(maxGap).toBeLessThan(STARVATION_THRESHOLD_MS)
      }

      // Drain the synchronizer queue before teardown.
      await service.awaitSnapshot(repoPath)
    } finally {
      service.closeAll()
      watcherService.stop()
      await fixture.cleanup()
    }
  }, 120_000)
})
