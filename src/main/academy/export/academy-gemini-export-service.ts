import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AcademyGeminiExportReceipt,
  AcademyGeminiExportState
} from '../../../shared/types/academy-types'
import type { AcademyStore } from '../academy-store'
import {
  buildCanonicalGeminiSnapshot,
  buildGeminiCoverage,
  executeGeminiExport,
  geminiInclusion,
  hashGeminiSnapshot,
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
    const coverage = buildGeminiCoverage(this.store, this.latestReceipt)
    const canonicalSnapshot = buildCanonicalGeminiSnapshot(this.store)
    const canonicalSnapshotHash = hashGeminiSnapshot(canonicalSnapshot)
    const artifactAvailable = Boolean(this.latestReceipt && existsSync(this.latestReceipt.artifactPath))
    const drifted = !this.latestReceipt || this.latestReceipt.snapshotHash !== canonicalSnapshotHash || !artifactAvailable

    return {
      latestExport: this.latestReceipt,
      coverage,
      canonicalSnapshotHash,
      drifted,
      artifactAvailable,
      lastError: this.lastError
    }
  }

  async prepareExport(): Promise<AcademyGeminiExportReceipt> {
    const canonicalSnapshot = buildCanonicalGeminiSnapshot(this.store)
    const snapshotHash = hashGeminiSnapshot(canonicalSnapshot)

    const pending = this.flights.get(snapshotHash)
    if (pending) {
      return pending
    }

    const flight = (async () => {
      await this.executionTail.catch(() => {})

      this.lastError = null

      const currentSnapshot = buildCanonicalGeminiSnapshot(this.store)
      const currentSnapshotHash = hashGeminiSnapshot(currentSnapshot)

      const eligible = this.store
        .list()
        .filter((skill) => geminiInclusion(this.store, skill).status === 'INCLUDED')
        .sort((a, b) => a.name.localeCompare(b.name))

      const task: AcademyGeminiExportTask = {
        kind: 'gemini-export',
        exportDirectory: this.exportDirectory,
        masterZipPath: this.masterZipPath,
        receiptPath: this.receiptPath,
        downloadsPath: this.downloadsPath,
        snapshotHash: currentSnapshotHash,
        skills: eligible.map((skill) => {
          const detail = this.store.get(skill.id)
          return {
            id: skill.id,
            name: skill.name,
            packageHash: detail.current.packageHash,
            package: detail.current.package
          }
        })
      }

      try {
        let receipt: AcademyGeminiExportReceipt
        if (this.executor && this.executor.hasWorker()) {
          const result = await this.executor.run(task)
          receipt = result.receipt!
        } else {
          const result = await executeGeminiExport(task)
          receipt = result.receipt!
        }

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
    void flight.finally(() => {
      this.flights.delete(snapshotHash)
    })

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
