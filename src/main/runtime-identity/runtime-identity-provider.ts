import { randomUUID } from 'node:crypto'
import { captureSourceOrigin, findCanonicalWorktreeId } from './source-origin'
import type {
  FreshnessState,
  RuntimeFreshnessResult,
  RuntimeIdentityInfo,
  RuntimeIdentityPayload,
  RuntimeIdentitySummary,
  SourceDivergence,
  SourceSnapshot,
  RuntimeSourceOrigin
} from './runtime-identity-types'
import { FileSnapshotMap, SourceFingerprintCollector, SourceFingerprintOptions } from './source-fingerprint'

export interface RuntimeIdentityProviderOptions extends SourceFingerprintOptions {
  instanceId?: string
  startedAt?: string
  appVersion?: string
  mode?: 'development' | 'production'
  protocolVersion?: string
  collector?: SourceFingerprintCollector
  packaged?: boolean
  maxListSample?: number
}

const DEFAULT_PROTOCOL_VERSION = '2025-11-25'
const DEFAULT_MAX_LIST_SAMPLE = 20

export class RuntimeIdentityProvider {
  private originBindingStarted = false
  private sourceOrigin: RuntimeSourceOrigin
  readonly sourceOriginReady: Promise<void>
  private readonly instanceId: string
  private readonly startedAt: string
  private readonly appVersion: string
  private readonly mode: 'development' | 'production'
  private readonly protocolVersion: string
  private readonly collector: SourceFingerprintCollector
  private readonly startupSnapshot: FileSnapshotMap
  private readonly maxListSample: number

  constructor(options: RuntimeIdentityProviderOptions = {}) {
    this.instanceId = options.instanceId ?? `inst-${randomUUID()}`
    this.startedAt = options.startedAt ?? new Date().toISOString()
    this.appVersion = options.appVersion ?? '1.0.0'
    this.mode = options.mode ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development')
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION
    this.collector = options.collector ?? new SourceFingerprintCollector(options)
    this.maxListSample = options.maxListSample ?? DEFAULT_MAX_LIST_SAMPLE

    this.startupSnapshot = this.collector.captureSnapshot()
    this.sourceOrigin = {
      status: options.packaged ? 'NOT_APPLICABLE' : 'UNAVAILABLE',
      sourceRootPath: options.packaged ? null : this.collector.getSourceRootPath(),
      worktree: null, capturedAt: this.startupSnapshot.capturedAt
    }
    this.sourceOriginReady = options.packaged ? Promise.resolve() :
      captureSourceOrigin(this.collector.getSourceRootPath()).then(origin => { this.sourceOrigin = origin })
  }

  async bindSourceOrigin(repositories: ReadonlyArray<{ repositoryId: string; rootPath: string }>): Promise<void> {
    if (this.originBindingStarted) return
    this.originBindingStarted = true
    await this.sourceOriginReady
    const worktree = this.sourceOrigin.worktree
    if (worktree) worktree.worktreeId = await findCanonicalWorktreeId(worktree.rootPath, repositories)
  }

  getInstanceId(): string {
    return this.instanceId
  }

  getStartedAt(): string {
    return this.startedAt
  }

  getStartupSnapshot(): SourceSnapshot {
    return {
      fingerprint: this.startupSnapshot.fingerprint,
      fileCount: this.startupSnapshot.fileCount,
      capturedAt: this.startupSnapshot.capturedAt
    }
  }

  getRuntimeInfo(): RuntimeIdentityInfo {
    return {
      instanceId: this.instanceId,
      startedAt: this.startedAt,
      appVersion: this.appVersion,
      mode: this.mode,
      protocolVersion: this.protocolVersion
    }
  }

  evaluateFreshness(): { currentSnapshot: SourceSnapshot; freshness: RuntimeFreshnessResult } {
    let currentMap: FileSnapshotMap
    try {
      currentMap = this.collector.captureSnapshot()
    } catch {
      return {
        currentSnapshot: {
          fingerprint: 'error',
          fileCount: 0,
          checkedAt: new Date().toISOString()
        } as unknown as SourceSnapshot,
        freshness: { state: 'UNVERIFIABLE' }
      }
    }

    const currentSnapshot: SourceSnapshot = {
      fingerprint: currentMap.fingerprint,
      fileCount: currentMap.fileCount,
      capturedAt: currentMap.capturedAt
    }

    if (currentMap.fingerprint === this.startupSnapshot.fingerprint) {
      return {
        currentSnapshot,
        freshness: { state: 'MATCH' }
      }
    }

    // Identify divergence
    const modified: string[] = []
    const added: string[] = []
    const removed: string[] = []

    for (const [path, startupHash] of this.startupSnapshot.files.entries()) {
      const currentHash = currentMap.files.get(path)
      if (currentHash === undefined) {
        removed.push(path)
      } else if (currentHash !== startupHash) {
        modified.push(path)
      }
    }

    for (const path of currentMap.files.keys()) {
      if (!this.startupSnapshot.files.has(path)) {
        added.push(path)
      }
    }

    const totalChanged = modified.length + added.length + removed.length
    const truncated =
      modified.length > this.maxListSample ||
      added.length > this.maxListSample ||
      removed.length > this.maxListSample

    const divergence: SourceDivergence = {
      changedFileCount: totalChanged,
      modifiedFiles: modified.slice(0, this.maxListSample),
      addedFiles: added.slice(0, this.maxListSample),
      removedFiles: removed.slice(0, this.maxListSample),
      truncated,
      recommendedAction: 'RESTART_RUNTIME'
    }

    return {
      currentSnapshot,
      freshness: {
        state: 'SOURCE_CHANGED_SINCE_START',
        divergence
      }
    }
  }

  getIdentityPayload(): RuntimeIdentityPayload {
    const { currentSnapshot, freshness } = this.evaluateFreshness()
    return {
      sourceOrigin: structuredClone(this.sourceOrigin),
      runtime: this.getRuntimeInfo(),
      startupSource: this.getStartupSnapshot(),
      currentSource: currentSnapshot,
      freshness
    }
  }

  getSummary(): RuntimeIdentitySummary {
    const { currentSnapshot, freshness } = this.evaluateFreshness()
    const summary: RuntimeIdentitySummary = {
      instanceId: this.instanceId,
      startedAt: this.startedAt,
      freshness: freshness.state,
      startupFingerprint: this.startupSnapshot.fingerprint,
      currentFingerprint: currentSnapshot.fingerprint
    }

    if (freshness.divergence) {
      summary.changedFileCount = freshness.divergence.changedFileCount
      summary.recommendedAction = freshness.divergence.recommendedAction
    }

    return summary
  }
}
