import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AcademyGeminiExportReceipt,
  AcademyGeminiExportState
} from '../../../shared/types/academy-types'
import type { AcademyStore } from '../academy-store'
import {
  buildCanonicalGeminiSnapshot,
  buildGeminiCoverage,
  createGeminiMasterZip,
  createGeminiSkillZip,
  geminiInclusion,
  hashGeminiSnapshot
} from './gemini-export-model'

export class AcademyGeminiExportService {
  readonly exportDirectory: string
  readonly receiptPath: string
  readonly masterZipPath: string

  private latestReceipt: AcademyGeminiExportReceipt | null = null
  private lastError: string | null = null
  private prepareFlight: Promise<AcademyGeminiExportReceipt> | null = null
  private readonly changeListeners = new Set<() => void>()

  constructor(
    private readonly store: AcademyStore,
    academyDatabasePath: string,
    private readonly downloadsPath?: string
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
    if (this.prepareFlight) {
      return this.prepareFlight
    }

    const flight = (async () => {
      try {
        this.lastError = null

        const eligible = this.store
          .list()
          .filter((skill) => geminiInclusion(this.store, skill).status === 'INCLUDED')
          .sort((a, b) => a.name.localeCompare(b.name))

        const skillZips = eligible.map((skill) => {
          const detail = this.store.get(skill.id)
          return createGeminiSkillZip(detail)
        })

        const master = createGeminiMasterZip(skillZips)

        mkdirSync(this.exportDirectory, { recursive: true })
        writeFileSync(this.masterZipPath, master.masterBuffer)

        if (this.downloadsPath && existsSync(this.downloadsPath)) {
          try {
            copyFileSync(this.masterZipPath, join(this.downloadsPath, 'academy-gemini.zip'))
          } catch {
            // Ignore failure to copy to downloads
          }
        }

        const canonicalSnapshot = buildCanonicalGeminiSnapshot(this.store)
        const snapshotHash = hashGeminiSnapshot(canonicalSnapshot)

        const receipt: AcademyGeminiExportReceipt = {
          exportId: randomUUID(),
          exportedAt: new Date().toISOString(),
          snapshotHash,
          artifactPath: this.masterZipPath,
          artifactHash: master.masterHash,
          skillCount: skillZips.length,
          totalBytes: master.totalBytes,
          skills: skillZips.map((s) => ({
            name: s.name,
            zipSha256: s.zipSha256,
            entryCount: s.entryCount,
            byteLength: s.byteLength
          }))
        }

        writeFileSync(this.receiptPath, JSON.stringify(receipt, null, 2), 'utf8')
        this.latestReceipt = receipt
        this.emitChange()

        return receipt
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.emitChange()
        throw error
      } finally {
        this.prepareFlight = null
      }
    })()

    this.prepareFlight = flight
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
