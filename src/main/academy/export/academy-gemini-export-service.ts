import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AcademyGeminiExportReceipt,
  AcademyGeminiExportState
} from '../../../shared/types/academy-types'
import type { AcademyStore } from '../academy-store'
import {
  evaluateGeminiCatalog,
  executeGeminiExport,
  recordGeminiWorkerExclusion,
  GEMINI_ADAPTATION_PROFILE_VERSION,
  type AcademyGeminiExportTask
} from './gemini-export-model'
import type { AcademyPluginExecutor } from '../publication/academy-plugin-executor'

export class AcademyGeminiExportService {
  readonly exportDirectory: string
  readonly receiptPath: string
  readonly masterZipPath: string

  private latestReceipt: AcademyGeminiExportReceipt | null = null
  private lastError: string | null = null
  private readonly flights = new Map<string, Promise<AcademyGeminiExportReceipt>>()
  private executionTail: Promise<unknown> = Promise.resolve()
  private readonly changeListeners = new Set<() => void>()

  constructor(
    private readonly store: AcademyStore,
    academyDatabasePath: string,
    private readonly downloadsPath?: string,
    private readonly executor?: AcademyPluginExecutor
  ) {
    this.exportDirectory = join(dirname(academyDatabasePath), 'gemini-export')
    this.receiptPath = join(this.exportDirectory, 'latest.json')
    this.masterZipPath = join(this.exportDirectory, 'academy-gemini.zip')
    this.latestReceipt = this.loadReceipt()
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener()
      } catch (err) {
        console.error('[GeminiExport] Error in change listener:', err)
      }
    }
  }

  private loadReceipt(): AcademyGeminiExportReceipt | null {
    try {
      if (!existsSync(this.receiptPath)) return null
      const content = readFileSync(this.receiptPath, 'utf8')
      const parsed = JSON.parse(content) as AcademyGeminiExportReceipt
      if (
        parsed &&
        typeof parsed.exportId === 'string' &&
        typeof parsed.artifactPath === 'string' &&
        typeof parsed.snapshotHash === 'string' &&
        typeof parsed.artifactHash === 'string' &&
        typeof parsed.skillCount === 'number' &&
        Array.isArray(parsed.skills)
      ) {
        return parsed
      }
    } catch {
      // Ignored: corrupt or unreadable cache file
    }
    return null
  }

  getState(): AcademyGeminiExportState {
    const evaluation = evaluateGeminiCatalog(this.store, this.latestReceipt, GEMINI_ADAPTATION_PROFILE_VERSION)
    const artifactAvailable = Boolean(this.latestReceipt && existsSync(this.latestReceipt.artifactPath))
    const profileMatch = this.latestReceipt?.profileVersion === GEMINI_ADAPTATION_PROFILE_VERSION
    const drifted =
      !this.latestReceipt ||
      !profileMatch ||
      this.latestReceipt.snapshotHash !== evaluation.canonicalSnapshotHash ||
      !artifactAvailable

    return {
      latestExport: this.latestReceipt,
      coverage: evaluation.coverage,
      canonicalSnapshotHash: evaluation.canonicalSnapshotHash,
      drifted,
      artifactAvailable,
      lastError: this.lastError
    }
  }

  async prepareExport(taskOverrides?: Partial<AcademyGeminiExportTask>): Promise<AcademyGeminiExportReceipt> {
    const initialEvaluation = evaluateGeminiCatalog(this.store, this.latestReceipt, GEMINI_ADAPTATION_PROFILE_VERSION)
    const snapshotHash = initialEvaluation.canonicalSnapshotHash

    const pending = this.flights.get(snapshotHash)
    if (pending) {
      return pending
    }

    const flight = (async () => {
      await this.executionTail.catch(() => {})

      this.lastError = null

      const currentEvaluation = evaluateGeminiCatalog(this.store, this.latestReceipt, GEMINI_ADAPTATION_PROFILE_VERSION)
      const currentSnapshotHash = currentEvaluation.canonicalSnapshotHash

      const eligible = [...currentEvaluation.eligibleSkills].sort((a, b) => a.name.localeCompare(b.name))
      const profileVersion = GEMINI_ADAPTATION_PROFILE_VERSION

      const task: AcademyGeminiExportTask = {
        kind: 'gemini-export',
        exportDirectory: this.exportDirectory,
        masterZipPath: this.masterZipPath,
        receiptPath: this.receiptPath,
        downloadsPath: this.downloadsPath,
        snapshotHash: currentSnapshotHash,
        profileVersion,
        skills: eligible.map((skill) => {
          const detail = this.store.get(skill.id)
          return {
            id: skill.id,
            name: skill.name,
            version: skill.currentVersion,
            packageHash: detail.current.packageHash,
            package: detail.current.package
          }
        }),
        ...taskOverrides
      }

      try {
        const result =
          this.executor && this.executor.hasWorker()
            ? await this.executor.run(task)
            : await executeGeminiExport(task)

        if (result.excludedSkills?.length) {
          for (const exclusion of result.excludedSkills) {
            recordGeminiWorkerExclusion(this.store, exclusion, task.profileVersion ?? profileVersion)
          }
        }

        const receipt = result.receipt!
        this.latestReceipt = receipt
        this.emitChange()
        return receipt
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.emitChange()
        throw error
      }
    })()

    this.flights.set(snapshotHash, flight)
    this.executionTail = flight.catch(() => {})
    const settleFlight = () => {
      this.flights.delete(snapshotHash)
    }
    void flight.then(settleFlight, settleFlight)

    return flight
  }

  getArtifactPath(): string | null {
    if (this.latestReceipt && existsSync(this.latestReceipt.artifactPath)) {
      return this.latestReceipt.artifactPath
    }
    if (existsSync(this.masterZipPath)) {
      return this.masterZipPath
    }
    return null
  }

  async revealArtifact(): Promise<string> {
    const path = this.getArtifactPath()
    if (!path || !existsSync(path)) {
      throw new Error('GEMINI_EXPORT_ARTIFACT_MISSING')
    }
    return path
  }
}
