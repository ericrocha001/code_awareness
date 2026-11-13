import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AcademyGeminiCoverage,
  AcademyGeminiExportMode,
  AcademyGeminiExportReceipt,
  AcademyGeminiExportState,
  AcademyGeminiFullImportConfirmation,
  AcademyGeminiImportedSkillStatus,
  AcademyGeminiManualAction,
  AcademyGeminiPendingReason,
  AcademyGeminiPendingSkill,
  AcademyGeminiSkillCheckpoint,
  AcademyGeminiSkillExportEntry,
  AcademyImportConfirmationMode,
  AcademyImportConfirmationOrigin,
  AcademyImportConfirmationPreference,
  AcademySkillSummary
} from '../../../shared/types/academy-types'
import { AcademyError } from '../academy-package'
import type { AcademyStore } from '../academy-store'
import {
  clearGeminiEvaluationCache,
  computeGeminiIncrementalFingerprint,
  computeGeminiMcpTriggerFingerprint,
  evaluateGeminiCatalog,
  evaluateGeminiMcpTriggerCatalog,
  getActiveWorkerExclusions,
  recordGeminiWorkerExclusion,
  restoreGeminiReceiptExclusions,
  sha256,
  canonicalJson,
  GEMINI_ADAPTATION_PROFILE_VERSION,
  GEMINI_MCP_STUB_PROFILE_VERSION,
  type AcademyGeminiExportTask,
  type AcademyGeminiExportTaskSkill
} from './gemini-export-model'
import {
  AcademyPluginExecutor,
  type AcademyGeminiWorkerExcludedSkill
} from '../publication/academy-plugin-executor'
import {
  readSharedImportConfirmationPreference,
  writeSharedImportConfirmationPreference
} from '../import-confirmation-preference'

interface PersistedGeminiDistributionState {
  schemaVersion: 1
  mode: AcademyGeminiExportMode
  incrementalCheckpoints: Record<string, AcademyGeminiSkillCheckpoint>
  mcpTriggerCheckpoints: Record<string, AcademyGeminiSkillCheckpoint>
  fullImportConfirmation: AcademyGeminiFullImportConfirmation | null
  workerExclusions: AcademyGeminiWorkerExcludedSkill[]
}

function defaultDistributionState(): PersistedGeminiDistributionState {
  return {
    schemaVersion: 1,
    mode: 'FULL',
    incrementalCheckpoints: {},
    mcpTriggerCheckpoints: {},
    fullImportConfirmation: null,
    workerExclusions: []
  }
}

export interface AcademyGeminiDownloadOptions {
  _failStage?: 'stage-copy' | 'promote'
  _onBeforeConfirm?: () => void | Promise<void>
  renameDirectory?: (source: string, destination: string) => Promise<void>
  renameFile?: (source: string, destination: string) => Promise<void>
}

async function moveFileWithFallback(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination)
  } catch {
    await copyFile(source, destination)
    await unlink(source).catch(() => {})
  }
}

async function moveDirectoryWithFallback(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination)
  } catch {
    await cp(source, destination, { recursive: true })
    await rm(source, { recursive: true, force: true }).catch(() => {})
  }
}

export class AcademyGeminiExportService {
  readonly academyBaseDir: string
  readonly exportDirectory: string
  readonly receiptPath: string
  readonly masterZipPath: string
  readonly incrementalDirectory: string
  readonly incrementalReceiptPath: string
  readonly mcpTriggersDirectory: string
  readonly mcpTriggersReceiptPath: string
  readonly statePath: string

  private readonly executor: AcademyPluginExecutor
  private receipts: Record<AcademyGeminiExportMode, AcademyGeminiExportReceipt | null>
  private distributionState: PersistedGeminiDistributionState
  private lastError: string | null = null
  private readonly flights = new Map<string, Promise<AcademyGeminiExportReceipt>>()
  private executionTail: Promise<unknown> = Promise.resolve()
  private readonly changeListeners = new Set<() => void>()

  constructor(
    private readonly store: AcademyStore,
    academyDatabasePath: string,
    private readonly downloadsPath?: string,
    executor?: AcademyPluginExecutor
  ) {
    this.executor = executor ?? new AcademyPluginExecutor()
    this.academyBaseDir = dirname(academyDatabasePath)
    this.exportDirectory = join(this.academyBaseDir, 'gemini-export')
    this.receiptPath = join(this.exportDirectory, 'latest.json')
    this.masterZipPath = join(this.exportDirectory, 'academy-gemini.zip')
    this.incrementalDirectory = join(this.exportDirectory, 'incremental')
    this.incrementalReceiptPath = join(this.exportDirectory, 'incremental-latest.json')
    this.mcpTriggersDirectory = join(this.exportDirectory, 'mcp-triggers')
    this.mcpTriggersReceiptPath = join(this.exportDirectory, 'mcp-triggers-latest.json')
    this.statePath = join(this.exportDirectory, 'gemini-distribution-state.json')

    clearGeminiEvaluationCache(this.store)
    this.distributionState = this.loadDistributionState()
    this.receipts = {
      FULL: this.loadReceiptFile(this.receiptPath),
      INCREMENTAL: this.loadReceiptFile(this.incrementalReceiptPath),
      MCP_TRIGGERS: this.loadReceiptFile(this.mcpTriggersReceiptPath)
    }

    restoreGeminiReceiptExclusions(this.store, this.receipts.FULL, GEMINI_ADAPTATION_PROFILE_VERSION)
    restoreGeminiReceiptExclusions(this.store, this.receipts.INCREMENTAL, GEMINI_ADAPTATION_PROFILE_VERSION)
    for (const exclusion of this.distributionState.workerExclusions) {
      if (exclusion.profileVersion === GEMINI_ADAPTATION_PROFILE_VERSION) {
        recordGeminiWorkerExclusion(this.store, exclusion, GEMINI_ADAPTATION_PROFILE_VERSION)
      }
    }
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

  private modeReceiptPath(mode: AcademyGeminiExportMode): string {
    if (mode === 'INCREMENTAL') return this.incrementalReceiptPath
    if (mode === 'MCP_TRIGGERS') return this.mcpTriggersReceiptPath
    return this.receiptPath
  }

  private modeDirectoryPath(mode: AcademyGeminiExportMode): string {
    if (mode === 'INCREMENTAL') return this.incrementalDirectory
    if (mode === 'MCP_TRIGGERS') return this.mcpTriggersDirectory
    return this.exportDirectory
  }

  private loadReceiptFile(filePath: string): AcademyGeminiExportReceipt | null {
    try {
      if (!existsSync(filePath)) return null
      const content = readFileSync(filePath, 'utf8')
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

  private writeRawFileAtomic(filePath: string, content: Buffer | string): void {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmpPath, content)
      renameSync(tmpPath, filePath)
    } catch (error) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // ignore
      }
      throw error
    }
  }

  private writeReceiptFileAtomic(filePath: string, receipt: AcademyGeminiExportReceipt): void {
    this.writeRawFileAtomic(filePath, Buffer.from(JSON.stringify(receipt, null, 2), 'utf8'))
  }

  private restoreRawReceiptFile(filePath: string, content: Buffer | null): void {
    if (!content) {
      if (existsSync(filePath)) unlinkSync(filePath)
      return
    }
    this.writeRawFileAtomic(filePath, content)
  }

  private loadDistributionState(): PersistedGeminiDistributionState {
    try {
      if (!existsSync(this.statePath)) return defaultDistributionState()
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<PersistedGeminiDistributionState>
      const mode: AcademyGeminiExportMode =
        parsed.mode === 'INCREMENTAL' || parsed.mode === 'MCP_TRIGGERS' ? parsed.mode : 'FULL'
      return {
        schemaVersion: 1,
        mode,
        incrementalCheckpoints:
          parsed.incrementalCheckpoints && typeof parsed.incrementalCheckpoints === 'object'
            ? { ...parsed.incrementalCheckpoints }
            : {},
        mcpTriggerCheckpoints:
          parsed.mcpTriggerCheckpoints && typeof parsed.mcpTriggerCheckpoints === 'object'
            ? { ...parsed.mcpTriggerCheckpoints }
            : {},
        fullImportConfirmation: parsed.fullImportConfirmation ?? null,
        workerExclusions: Array.isArray(parsed.workerExclusions) ? parsed.workerExclusions : []
      }
    } catch {
      return defaultDistributionState()
    }
  }

  private persistDistributionState(): void {
    mkdirSync(this.exportDirectory, { recursive: true })
    const tmpPath = `${this.statePath}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmpPath, JSON.stringify(this.distributionState, null, 2), 'utf8')
      renameSync(tmpPath, this.statePath)
    } catch (error) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // ignore
      }
      throw error
    }
  }

  private checkpointsForMode(mode: 'INCREMENTAL' | 'MCP_TRIGGERS'): Record<string, AcademyGeminiSkillCheckpoint> {
    return mode === 'MCP_TRIGGERS'
      ? this.distributionState.mcpTriggerCheckpoints
      : this.distributionState.incrementalCheckpoints
  }

  private clearModePreparedArtifacts(mode: 'INCREMENTAL' | 'MCP_TRIGGERS'): void {
    const dirPath = this.modeDirectoryPath(mode)
    const rPath = this.modeReceiptPath(mode)
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true })
    }
    if (existsSync(rPath)) {
      unlinkSync(rPath)
    }
    this.receipts[mode] = null
  }

  getImportConfirmationPreference(): AcademyImportConfirmationPreference {
    return readSharedImportConfirmationPreference(this.academyBaseDir)
  }

  setImportConfirmationPreference(mode: AcademyImportConfirmationMode): AcademyGeminiExportState {
    writeSharedImportConfirmationPreference(this.academyBaseDir, mode)
    this.emitChange()
    return this.getState()
  }

  getMode(): AcademyGeminiExportMode {
    return this.distributionState.mode
  }

  setMode(mode: AcademyGeminiExportMode): AcademyGeminiExportState {
    if (mode !== 'FULL' && mode !== 'INCREMENTAL' && mode !== 'MCP_TRIGGERS') {
      throw new AcademyError('INVALID_GEMINI_EXPORT_MODE', `Modo de exportação Gemini inválido: ${String(mode)}`)
    }
    if (this.distributionState.mode !== mode) {
      this.distributionState.mode = mode
      this.lastError = null
      this.persistDistributionState()
      this.emitChange()
    }
    return this.getState()
  }

  private evaluateModeCatalog(mode: AcademyGeminiExportMode): {
    coverage: AcademyGeminiCoverage
    canonicalSnapshotHash: string
    eligibleSkills: AcademySkillSummary[]
    packageHashes: Map<string, string>
  } {
    if (mode === 'MCP_TRIGGERS') {
      const mcpEval = evaluateGeminiMcpTriggerCatalog(this.store)
      const triggerEntries = mcpEval.eligibleSkills
        .map((skill) => ({
          skillId: skill.id,
          name: skill.name,
          description: skill.description,
          fingerprint: computeGeminiMcpTriggerFingerprint(skill, GEMINI_MCP_STUB_PROFILE_VERSION)
        }))
        .sort((a, b) => a.skillId.localeCompare(b.skillId))
      return {
        coverage: {
          catalog: mcpEval.catalog,
          eligible: mcpEval.eligibleSkills.length,
          includedInLastZip: this.receipts.MCP_TRIGGERS ? this.receipts.MCP_TRIGGERS.skillCount : null,
          awaitingZip: 0,
          notApplicable: mcpEval.notApplicable,
          adaptedCount: 0,
          excluded: mcpEval.excluded
        },
        canonicalSnapshotHash: sha256(
          canonicalJson({
            mode: 'MCP_TRIGGERS',
            profileVersion: GEMINI_MCP_STUB_PROFILE_VERSION,
            entries: triggerEntries
          })
        ),
        eligibleSkills: mcpEval.eligibleSkills,
        packageHashes: mcpEval.packageHashes
      }
    }

    const receiptForCache = mode === 'INCREMENTAL' ? (this.receipts.INCREMENTAL ?? this.receipts.FULL) : this.receipts.FULL
    const fullEval = evaluateGeminiCatalog(this.store, receiptForCache, GEMINI_ADAPTATION_PROFILE_VERSION)
    return {
      coverage: fullEval.coverage,
      canonicalSnapshotHash: fullEval.canonicalSnapshotHash,
      eligibleSkills: fullEval.eligibleSkills,
      packageHashes: fullEval.eligiblePackageHashes
    }
  }

  private computeFingerprintForSkill(
    mode: 'INCREMENTAL' | 'MCP_TRIGGERS',
    skill: AcademySkillSummary,
    packageHashes: Map<string, string>
  ): string {
    if (mode === 'MCP_TRIGGERS') {
      return computeGeminiMcpTriggerFingerprint(
        { id: skill.id, name: skill.name, description: skill.description },
        GEMINI_MCP_STUB_PROFILE_VERSION
      )
    }
    return computeGeminiIncrementalFingerprint(
      {
        id: skill.id,
        name: skill.name,
        currentVersion: skill.currentVersion,
        packageHash: packageHashes.get(skill.id) ?? ''
      },
      GEMINI_ADAPTATION_PROFILE_VERSION
    )
  }

  private describeManualRemovalReason(
    skillId: string,
    checkpointsName: string,
    allSkillsById: Map<string, AcademySkillSummary>,
    excludedById: Map<string, { reason: string; details?: string }>
  ): string {
    const excluded = excludedById.get(skillId)
    if (excluded) {
      if (excluded.reason === 'DISABLED') {
        return `Skill '${checkpointsName}' foi desativada na Academy. Remova manualmente no Gemini Web.`
      }
      if (excluded.reason === 'PRIVATE') {
        return `Skill '${checkpointsName}' tornou-se privada na Academy. Remova manualmente no Gemini Web.`
      }
      if (excluded.reason === 'REMOVED') {
        return `Skill '${checkpointsName}' foi excluída da Academy. Remova manualmente no Gemini Web.`
      }
      return excluded.details ?? `Skill '${checkpointsName}' não é mais compatível com o Gemini Web. Remova manualmente no Gemini Web.`
    }
    const skill = allSkillsById.get(skillId)
    if (skill && skill.scope !== 'GLOBAL') {
      return `Skill '${checkpointsName}' mudou para escopo PROJECT e não entra mais no pacote Gemini. Remova manualmente no Gemini Web.`
    }
    return `Skill '${checkpointsName}' não está mais ativa no catálogo público da Academy. Remova manualmente no Gemini Web.`
  }

  getState(): AcademyGeminiExportState {
    const mode = this.distributionState.mode
    const importConfirmationPreference = this.getImportConfirmationPreference()

    if (mode === 'FULL') {
      const receipt = this.receipts.FULL
      const evaluation = evaluateGeminiCatalog(this.store, receipt, GEMINI_ADAPTATION_PROFILE_VERSION)
      const artifactAvailable = Boolean(receipt && existsSync(receipt.artifactPath))
      const profileMatch = receipt?.profileVersion === GEMINI_ADAPTATION_PROFILE_VERSION
      const drifted =
        !receipt ||
        !profileMatch ||
        receipt.snapshotHash !== evaluation.canonicalSnapshotHash ||
        !artifactAvailable
      const storedConfirm = this.distributionState.fullImportConfirmation
      const validConfirm =
        storedConfirm && receipt && !drifted && storedConfirm.artifactHash === receipt.artifactHash
          ? storedConfirm
          : null

      return {
        mode: 'FULL',
        requiresMcp: false,
        baselineEstablished: Boolean(validConfirm),
        importConfirmationPreference,
        fullImportConfirmation: validConfirm,
        latestExport: receipt,
        coverage: {
          ...evaluation.coverage,
          imported: validConfirm ? receipt?.skillCount ?? 0 : 0,
          upToDate: validConfirm ? receipt?.skillCount ?? 0 : 0,
          pendingExport: drifted ? evaluation.coverage.awaitingZip : 0,
          awaitingImport: !drifted && !validConfirm ? (receipt?.skillCount ?? 0) : 0,
          manualActionsCount: 0
        },
        canonicalSnapshotHash: evaluation.canonicalSnapshotHash,
        pendingSkills: [],
        importedSkills: [],
        manualActions: [],
        drifted,
        artifactAvailable,
        lastError: this.lastError
      }
    }

    const activeProfileVersion =
      mode === 'MCP_TRIGGERS' ? GEMINI_MCP_STUB_PROFILE_VERSION : GEMINI_ADAPTATION_PROFILE_VERSION
    const checkpoints = this.checkpointsForMode(mode)
    const modeReceipt = this.receipts[mode]
    const targetDir = this.modeDirectoryPath(mode)
    const evalResult = this.evaluateModeCatalog(mode)

    const receiptEntryBySkillId = new Map<string, (typeof modeReceipt extends null ? never : NonNullable<typeof modeReceipt>['skills'][number])>()
    const receiptEntriesValidProfile = modeReceipt?.profileVersion === activeProfileVersion
    if (modeReceipt && receiptEntriesValidProfile) {
      for (const entry of modeReceipt.skills) {
        if (entry.skillId) {
          receiptEntryBySkillId.set(entry.skillId, entry)
        }
      }
    }

    const pendingSkills: AcademyGeminiPendingSkill[] = []
    const importedSkills: AcademyGeminiImportedSkillStatus[] = []
    const manualActions: AcademyGeminiManualAction[] = []
    const eligibleIds = new Set<string>()
    let newSkills = 0
    let updatedSkills = 0
    let awaitingImport = 0
    let pendingExport = 0

    for (const skill of [...evalResult.eligibleSkills].sort((a, b) => a.name.localeCompare(b.name))) {
      eligibleIds.add(skill.id)
      const packageHash = evalResult.packageHashes.get(skill.id) ?? ''
      const fingerprint = this.computeFingerprintForSkill(mode, skill, evalResult.packageHashes)
      const checkpoint = checkpoints[skill.id]

      if (
        checkpoint &&
        checkpoint.fingerprint === fingerprint &&
        checkpoint.skillName === skill.name &&
        checkpoint.profileVersion === activeProfileVersion
      ) {
        importedSkills.push({
          skillId: skill.id,
          name: skill.name,
          academyVersion: skill.currentVersion,
          packageHash,
          profileVersion: activeProfileVersion,
          fingerprint,
          confirmedAt: checkpoint.confirmedAt,
          origin: checkpoint.origin,
          upToDate: true
        })
        continue
      }

      let reason: AcademyGeminiPendingReason
      let previousName: string | undefined
      if (!checkpoint) {
        reason = 'NEW_SKILL'
        newSkills++
      } else {
        updatedSkills++
        if (checkpoint.skillName !== skill.name) {
          reason = 'RENAMED'
          previousName = checkpoint.skillName
          manualActions.push({
            skillId: skill.id,
            previousName: checkpoint.skillName,
            currentName: skill.name,
            action: 'RENAME_IN_GEMINI',
            reason: `Skill renomeada de '${checkpoint.skillName}' para '${skill.name}'. Importe '${skill.name}.zip' e remova '${checkpoint.skillName}' no Gemini Web.`,
            checkpointedAt: checkpoint.confirmedAt
          })
        } else if (checkpoint.profileVersion !== activeProfileVersion) {
          reason = 'PROFILE_CHANGED'
        } else if (mode === 'MCP_TRIGGERS') {
          reason = 'METADATA_CHANGED'
        } else if (checkpoint.academyVersion !== skill.currentVersion) {
          reason = 'VERSION_CHANGED'
        } else {
          reason = 'CONTENT_CHANGED'
        }
      }

      const zipFileName = `${skill.name}.zip`
      const receiptEntry = receiptEntryBySkillId.get(skill.id)
      const candidateZipPath = join(targetDir, receiptEntry?.zipFileName ?? zipFileName)
      const zipMatchesPrepared = Boolean(
        receiptEntry &&
          receiptEntry.fingerprint === fingerprint &&
          receiptEntry.name === skill.name &&
          existsSync(candidateZipPath)
      )

      if (zipMatchesPrepared) {
        awaitingImport++
      } else {
        pendingExport++
      }

      pendingSkills.push({
        skillId: skill.id,
        name: skill.name,
        ...(previousName ? { previousName } : {}),
        academyVersion: skill.currentVersion,
        packageHash,
        profileVersion: activeProfileVersion,
        fingerprint,
        reason,
        zipFileName: receiptEntry?.zipFileName ?? zipFileName,
        zipPath: zipMatchesPrepared ? candidateZipPath : null,
        zipHash: zipMatchesPrepared ? receiptEntry!.zipSha256 : null,
        zipSizeBytes: zipMatchesPrepared ? receiptEntry!.byteLength : null,
        awaitingImport: zipMatchesPrepared
      })
    }

    const allSkillsById = new Map(this.store.list().map((s) => [s.id, s]))
    const excludedById = new Map(evalResult.coverage.excluded.map((e) => [e.skillId, e]))

    for (const [skillId, checkpoint] of Object.entries(checkpoints)) {
      if (eligibleIds.has(skillId)) continue
      manualActions.push({
        skillId,
        previousName: checkpoint.skillName,
        action: 'REMOVE_IN_GEMINI',
        reason: this.describeManualRemovalReason(skillId, checkpoint.skillName, allSkillsById, excludedById),
        checkpointedAt: checkpoint.confirmedAt
      })
    }

    manualActions.sort((a, b) => a.previousName.localeCompare(b.previousName))

    const pendingIds = new Set(pendingSkills.map((s) => s.skillId))
    const hasOrphanPreparedEntries = Boolean(
      modeReceipt &&
        modeReceipt.skills.some((entry) => {
          if (!entry.skillId || !pendingIds.has(entry.skillId)) return true
          const pending = pendingSkills.find((p) => p.skillId === entry.skillId)
          return !pending || pending.fingerprint !== entry.fingerprint || !pending.awaitingImport
        })
    )

    const drifted = pendingExport > 0 || (pendingSkills.length === 0 && Boolean(modeReceipt && modeReceipt.skillCount > 0)) || hasOrphanPreparedEntries
    const preparedSkills = pendingSkills.filter((s) => s.awaitingImport)
    const artifactAvailable =
      Boolean(modeReceipt && preparedSkills.length > 0) &&
      existsSync(targetDir) &&
      preparedSkills.every((s) => Boolean(s.zipPath && existsSync(s.zipPath)))

    return {
      mode,
      requiresMcp: mode === 'MCP_TRIGGERS',
      baselineEstablished: Object.keys(checkpoints).length > 0,
      importConfirmationPreference,
      fullImportConfirmation: null,
      latestExport: modeReceipt,
      coverage: {
        ...evalResult.coverage,
        includedInLastZip: modeReceipt ? modeReceipt.skillCount : null,
        awaitingZip: pendingExport,
        imported: importedSkills.length,
        upToDate: importedSkills.length,
        pendingExport,
        newSkills,
        updatedSkills,
        awaitingImport,
        manualActionsCount: manualActions.length
      },
      canonicalSnapshotHash: evalResult.canonicalSnapshotHash,
      pendingSkills,
      importedSkills,
      manualActions,
      drifted,
      artifactAvailable,
      lastError: this.lastError
    }
  }

  private workerUnavailableError(): AcademyError {
    return new AcademyError(
      'GEMINI_EXPORT_WORKER_UNAVAILABLE',
      'GEMINI_EXPORT_WORKER_UNAVAILABLE: Worker de exportação Gemini indisponível. A geração do pacote requer execução fora do processo principal.'
    )
  }

  async prepareExport(taskOverrides?: Partial<AcademyGeminiExportTask>): Promise<AcademyGeminiExportReceipt> {
    if (!this.executor || !this.executor.hasWorker()) {
      const error = this.workerUnavailableError()
      this.lastError = error.message
      this.emitChange()
      return Promise.reject(error)
    }

    const mode = taskOverrides?.mode ?? this.distributionState.mode
    const initialState = this.getState()
    const flightKey = `${mode}:${initialState.canonicalSnapshotHash}`

    const pendingFlight = this.flights.get(flightKey)
    if (pendingFlight) {
      return pendingFlight
    }

    const flight = (async () => {
      await this.executionTail.catch(() => {})
      this.lastError = null

      try {
        if (!this.executor || !this.executor.hasWorker()) {
          throw this.workerUnavailableError()
        }

        if (mode === 'FULL') {
          const currentEvaluation = evaluateGeminiCatalog(
            this.store,
            this.receipts.FULL,
            GEMINI_ADAPTATION_PROFILE_VERSION
          )
          const currentSnapshotHash = currentEvaluation.canonicalSnapshotHash
          const eligible = [...currentEvaluation.eligibleSkills].sort((a, b) => a.name.localeCompare(b.name))
          const profileVersion = GEMINI_ADAPTATION_PROFILE_VERSION
          const carriedExcludedSkills = getActiveWorkerExclusions(this.store, profileVersion)

          const task: AcademyGeminiExportTask = {
            kind: 'gemini-export',
            mode: 'FULL',
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
                description: skill.description,
                version: skill.currentVersion,
                packageHash: detail.current.packageHash,
                package: detail.current.package
              }
            }),
            ...(carriedExcludedSkills.length > 0 ? { carriedExcludedSkills } : {}),
            ...taskOverrides
          }

          const result = await this.executor.run(task)
          this.recordResultExclusions(result.excludedSkills, task.profileVersion ?? profileVersion)
          const receipt = result.receipt!
          this.receipts.FULL = receipt
          this.emitChange()
          return receipt
        }

        const liveState = this.getState()
        const targetMode: 'INCREMENTAL' | 'MCP_TRIGGERS' = mode
        if (liveState.pendingSkills.length === 0 && !taskOverrides?._failStage) {
          this.clearModePreparedArtifacts(targetMode)
          this.emitChange()
          throw new AcademyError(
            'GEMINI_NO_PENDING_SKILLS',
            'GEMINI_NO_PENDING_SKILLS: Nenhuma Skill pendente para gerar neste modo.'
          )
        }

        const profileVersion =
          targetMode === 'MCP_TRIGGERS' ? GEMINI_MCP_STUB_PROFILE_VERSION : GEMINI_ADAPTATION_PROFILE_VERSION
        const targetDirectoryPath = this.modeDirectoryPath(targetMode)
        const targetReceiptPath = this.modeReceiptPath(targetMode)
        const carriedExcludedSkills =
          targetMode === 'INCREMENTAL' ? getActiveWorkerExclusions(this.store, profileVersion) : []

        const taskSkills: AcademyGeminiExportTaskSkill[] = liveState.pendingSkills.map((pending) => {
          if (targetMode === 'MCP_TRIGGERS') {
            const summary = this.store.get(pending.skillId)
            return {
              id: pending.skillId,
              name: pending.name,
              description: summary.description,
              version: pending.academyVersion,
              packageHash: summary.current.packageHash,
              package: { skillMd: '', artifacts: {} },
              fingerprint: pending.fingerprint,
              reason: pending.reason,
              ...(pending.previousName ? { previousName: pending.previousName } : {})
            }
          }
          const detail = this.store.get(pending.skillId)
          return {
            id: detail.id,
            name: detail.name,
            description: detail.description,
            version: detail.currentVersion,
            packageHash: detail.current.packageHash,
            package: detail.current.package,
            fingerprint: pending.fingerprint,
            reason: pending.reason,
            ...(pending.previousName ? { previousName: pending.previousName } : {})
          }
        })

        const task: AcademyGeminiExportTask = {
          kind: 'gemini-export',
          mode: targetMode,
          exportDirectory: this.exportDirectory,
          masterZipPath: this.masterZipPath,
          targetDirectoryPath,
          receiptPath: targetReceiptPath,
          snapshotHash: liveState.canonicalSnapshotHash,
          profileVersion,
          skills: taskSkills,
          ...(carriedExcludedSkills.length > 0 ? { carriedExcludedSkills } : {}),
          ...taskOverrides
        }

        const result = await this.executor.run(task)
        if (targetMode === 'INCREMENTAL') {
          this.recordResultExclusions(result.excludedSkills, task.profileVersion ?? profileVersion)
        }
        const receipt = result.receipt!
        if (receipt.skillCount === 0) {
          this.clearModePreparedArtifacts(targetMode)
          this.emitChange()
          throw new AcademyError(
            'GEMINI_NO_PENDING_SKILLS',
            'GEMINI_NO_PENDING_SKILLS: Todas as Skills pendentes falharam na validação ou foram excluídas.'
          )
        }

        this.receipts[targetMode] = receipt
        this.emitChange()
        return receipt
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.emitChange()
        throw error
      }
    })()

    this.flights.set(flightKey, flight)
    this.executionTail = flight.catch(() => {})
    const settleFlight = () => {
      this.flights.delete(flightKey)
    }
    void flight.then(settleFlight, settleFlight)

    return flight
  }

  private recordResultExclusions(
    excludedSkills: AcademyGeminiWorkerExcludedSkill[] | undefined,
    profileVersion: string
  ): void {
    if (!excludedSkills?.length) return
    for (const exclusion of excludedSkills) {
      recordGeminiWorkerExclusion(this.store, exclusion, profileVersion)
    }
    const existingById = new Map(this.distributionState.workerExclusions.map((e) => [e.skillId, e]))
    for (const exclusion of excludedSkills) {
      existingById.set(exclusion.skillId, exclusion)
    }
    this.distributionState.workerExclusions = [...existingById.values()]
    this.persistDistributionState()
  }

  async downloadExport(
    targetDirectory?: string,
    options?: AcademyGeminiDownloadOptions
  ): Promise<AcademyGeminiExportState> {
    this.lastError = null
    const destinationRoot = targetDirectory ?? this.downloadsPath
    if (!destinationRoot) {
      const error = new AcademyError(
        'GEMINI_DOWNLOAD_DIRECTORY_UNAVAILABLE',
        'Pasta Downloads não configurada para entrega do pacote Gemini.'
      )
      this.lastError = error.message
      this.emitChange()
      throw error
    }

    const state = this.getState()
    const mode = state.mode
    const receipt = this.receipts[mode]

    if (!receipt || state.drifted || !state.artifactAvailable) {
      const error = new AcademyError(
        'GEMINI_EXPORT_NOT_READY',
        'GEMINI_EXPORT_NOT_READY: Gere ou atualize o pacote Gemini antes de baixar.'
      )
      this.lastError = error.message
      this.emitChange()
      throw error
    }

    if (mode === 'FULL') {
      return this.downloadFullExport(destinationRoot, receipt, options)
    }

    return this.downloadDifferentialExport(mode, destinationRoot, state, receipt, options)
  }

  private async downloadFullExport(
    destinationRoot: string,
    receipt: AcademyGeminiExportReceipt,
    options?: AcademyGeminiDownloadOptions
  ): Promise<AcademyGeminiExportState> {
    if (!existsSync(receipt.artifactPath)) {
      const error = new AcademyError(
        'GEMINI_EXPORT_ARTIFACT_MISSING',
        'Arquivo academy-gemini.zip não encontrado no disco.'
      )
      this.lastError = error.message
      this.emitChange()
      throw error
    }

    const deliveredSnapshotHash = receipt.snapshotHash
    const deliveredArtifactHash = receipt.artifactHash
    const deliveredProfileVersion = receipt.profileVersion
    const deliveredEntries = receipt.skills.map((e) => ({ ...e }))
    const previousReceiptSnapshot: AcademyGeminiExportReceipt = {
      ...receipt,
      skills: receipt.skills.map((s) => ({ ...s }))
    }
    const previousReceiptFileBytes = existsSync(this.receiptPath) ? readFileSync(this.receiptPath) : null

    const destZipPath = join(destinationRoot, 'academy-gemini.zip')
    const stagedDestPath = `${destZipPath}.${randomUUID()}.stage`
    const promoteFile = options?.renameFile ?? rename

    try {
      const sourceBytes = await readFile(receipt.artifactPath)
      if (sha256(sourceBytes) !== deliveredArtifactHash) {
        throw new AcademyError(
          'GEMINI_EXPORT_ARTIFACT_CORRUPT',
          'O pacote academy-gemini.zip preparado não corresponde ao hash do recibo.'
        )
      }

      await mkdir(destinationRoot, { recursive: true })
      if (options?._failStage === 'stage-copy') {
        throw new Error('SIMULATED_DOWNLOAD_STAGE_COPY_FAILURE')
      }
      await writeFile(stagedDestPath, sourceBytes)
      const writtenHash = sha256(await readFile(stagedDestPath))
      if (writtenHash !== deliveredArtifactHash) {
        throw new AcademyError(
          'GEMINI_DOWNLOAD_COPY_MISMATCH',
          'Falha na verificação de integridade após cópia para Downloads.'
        )
      }

      let backupZipPath: string | null = null
      try {
        if (existsSync(destZipPath)) {
          backupZipPath = `${destZipPath}.${randomUUID()}.bak`
          await rename(destZipPath, backupZipPath)
        }
        if (options?._failStage === 'promote') {
          throw new Error('SIMULATED_DOWNLOAD_PROMOTE_FAILURE')
        }
        await promoteFile(stagedDestPath, destZipPath)
        const promotedHash = sha256(await readFile(destZipPath))
        if (promotedHash !== deliveredArtifactHash) {
          throw new AcademyError(
            'GEMINI_DOWNLOAD_COPY_MISMATCH',
            'Falha na verificação após promoção de academy-gemini.zip em Downloads.'
          )
        }

        const updatedReceipt: AcademyGeminiExportReceipt = {
          ...previousReceiptSnapshot,
          downloadsPath: destZipPath
        }
        this.writeReceiptFileAtomic(this.receiptPath, updatedReceipt)
        this.receipts.FULL = updatedReceipt

        if (backupZipPath) {
          await unlink(backupZipPath).catch(() => {})
        }
      } catch (promotionError) {
        if (existsSync(destZipPath)) {
          await unlink(destZipPath).catch(() => {})
        }
        if (backupZipPath && existsSync(backupZipPath)) {
          await moveFileWithFallback(backupZipPath, destZipPath).catch(() => {})
        }
        this.receipts.FULL = previousReceiptSnapshot
        this.restoreRawReceiptFile(this.receiptPath, previousReceiptFileBytes)
        throw promotionError
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.emitChange()
      throw error
    } finally {
      await unlink(stagedDestPath).catch(() => {})
    }

    await options?._onBeforeConfirm?.()

    if (this.getImportConfirmationPreference().mode === 'AUTOMATIC') {
      const evalAfter = evaluateGeminiCatalog(this.store, this.receipts.FULL, GEMINI_ADAPTATION_PROFILE_VERSION)
      const eligibleById = new Map(evalAfter.eligibleSkills.map((s) => [s.id, s]))
      const deliveredWithIds = deliveredEntries.filter((e): e is AcademyGeminiSkillExportEntry & { skillId: string } =>
        Boolean(e.skillId)
      )
      const allEntriesMatch =
        deliveredProfileVersion === GEMINI_ADAPTATION_PROFILE_VERSION &&
        evalAfter.canonicalSnapshotHash === deliveredSnapshotHash &&
        eligibleById.size === deliveredWithIds.length &&
        deliveredWithIds.every((entry) => {
          const current = eligibleById.get(entry.skillId)
          if (!current || current.name !== entry.name) return false
          if (entry.academyVersion !== undefined && current.currentVersion !== entry.academyVersion) return false
          if (
            entry.packageHash !== undefined &&
            (evalAfter.eligiblePackageHashes.get(entry.skillId) ?? '') !== entry.packageHash
          ) {
            return false
          }
          return true
        })

      if (allEntriesMatch) {
        this.distributionState.fullImportConfirmation = {
          artifactHash: deliveredArtifactHash,
          confirmedAt: new Date().toISOString(),
          origin: 'ASSUMED_ON_DOWNLOAD',
          skillCount: previousReceiptSnapshot.skillCount
        }
        this.persistDistributionState()
      } else {
        this.lastError =
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: Uma ou mais Skills mudaram durante o download. Existe uma atualização pendente na Academy; a confirmação automática não foi aplicada.'
      }
    }

    this.emitChange()
    return this.getState()
  }

  private async downloadDifferentialExport(
    mode: 'INCREMENTAL' | 'MCP_TRIGGERS',
    destinationRoot: string,
    state: AcademyGeminiExportState,
    receipt: AcademyGeminiExportReceipt,
    options?: AcademyGeminiDownloadOptions
  ): Promise<AcademyGeminiExportState> {
    const activeProfileVersion =
      mode === 'MCP_TRIGGERS' ? GEMINI_MCP_STUB_PROFILE_VERSION : GEMINI_ADAPTATION_PROFILE_VERSION
    if (receipt.profileVersion !== activeProfileVersion) {
      const error = new AcademyError(
        'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
        'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: Perfil de exportação divergiu. Existe uma atualização pendente; regere o lote.'
      )
      this.lastError = error.message
      this.emitChange()
      throw error
    }

    const sourceDir = this.modeDirectoryPath(mode)
    const modeReceiptPath = this.modeReceiptPath(mode)
    const freshPendingById = new Map(state.pendingSkills.map((p) => [p.skillId, p]))
    const filesToCopy: Array<{ fileName: string; sourcePath: string; expectedHash: string; skillId: string }> = []
    const deliveredEntries: AcademyGeminiSkillExportEntry[] = receipt.skills.map((e) => ({ ...e }))
    const previousReceiptSnapshot: AcademyGeminiExportReceipt = {
      ...receipt,
      skills: receipt.skills.map((s) => ({ ...s }))
    }
    const previousReceiptFileBytes = existsSync(modeReceiptPath) ? readFileSync(modeReceiptPath) : null

    for (const entry of deliveredEntries) {
      if (!entry.skillId || !entry.fingerprint) {
        const error = new AcademyError(
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
          `GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: Recibo de '${entry.name}' incompleto. Existe uma atualização pendente; regere antes de baixar.`
        )
        this.lastError = error.message
        this.emitChange()
        throw error
      }
      const currentPending = freshPendingById.get(entry.skillId)
      if (
        !currentPending ||
        !currentPending.awaitingImport ||
        currentPending.fingerprint !== entry.fingerprint ||
        currentPending.name !== entry.name ||
        (entry.academyVersion !== undefined && currentPending.academyVersion !== entry.academyVersion) ||
        (entry.packageHash !== undefined && currentPending.packageHash !== entry.packageHash)
      ) {
        const error = new AcademyError(
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
          `GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: A Skill '${entry.name}' avançou na Academy após a geração do lote. Existe uma atualização pendente; regere antes de baixar.`
        )
        this.lastError = error.message
        this.emitChange()
        throw error
      }
      const fileName = entry.zipFileName ?? `${entry.name}.zip`
      const sourcePath = join(sourceDir, fileName)
      if (!existsSync(sourcePath)) {
        const error = new AcademyError(
          'GEMINI_EXPORT_ARTIFACT_MISSING',
          `Arquivo '${fileName}' ausente na pasta preparada.`
        )
        this.lastError = error.message
        this.emitChange()
        throw error
      }
      filesToCopy.push({ fileName, sourcePath, expectedHash: entry.zipSha256, skillId: entry.skillId })
    }

    if (filesToCopy.length === 0) {
      const error = new AcademyError('GEMINI_NO_PENDING_SKILLS', 'Nenhuma Skill pendente para entrega.')
      this.lastError = error.message
      this.emitChange()
      throw error
    }

    const subfolderName = mode === 'INCREMENTAL' ? 'academy-gemini-incremental' : 'academy-gemini-mcp-triggers'
    const destFolder = join(destinationRoot, subfolderName)
    const stagedFolder = `${destFolder}.${randomUUID()}.stage`
    const promoteDirectory = options?.renameDirectory ?? rename

    try {
      await mkdir(destinationRoot, { recursive: true })
      await mkdir(stagedFolder, { recursive: true })

      if (options?._failStage === 'stage-copy') {
        throw new Error('SIMULATED_DOWNLOAD_STAGE_COPY_FAILURE')
      }

      for (const item of filesToCopy) {
        const sourceBytes = await readFile(item.sourcePath)
        if (sha256(sourceBytes) !== item.expectedHash) {
          throw new AcademyError(
            'GEMINI_EXPORT_ARTIFACT_CORRUPT',
            `Hash de '${item.fileName}' não confere com o recibo.`
          )
        }
        const stagedFile = join(stagedFolder, item.fileName)
        await cp(item.sourcePath, stagedFile)
        const copiedHash = sha256(await readFile(stagedFile))
        if (copiedHash !== item.expectedHash) {
          throw new AcademyError(
            'GEMINI_DOWNLOAD_COPY_MISMATCH',
            `Falha de integridade ao copiar '${item.fileName}' para Downloads.`
          )
        }
      }

      let backupFolder: string | null = null
      try {
        if (existsSync(destFolder)) {
          backupFolder = `${destFolder}.${randomUUID()}.bak`
          await rename(destFolder, backupFolder)
        }

        if (options?._failStage === 'promote') {
          throw new Error('SIMULATED_DOWNLOAD_PROMOTE_FAILURE')
        }

        await promoteDirectory(stagedFolder, destFolder)

        for (const item of filesToCopy) {
          const promotedFile = join(destFolder, item.fileName)
          if (!existsSync(promotedFile)) {
            throw new AcademyError(
              'GEMINI_DOWNLOAD_COPY_MISMATCH',
              `Arquivo '${item.fileName}' ausente após promoção para Downloads.`
            )
          }
          const promotedHash = sha256(await readFile(promotedFile))
          if (promotedHash !== item.expectedHash) {
            throw new AcademyError(
              'GEMINI_DOWNLOAD_COPY_MISMATCH',
              `Hash de '${item.fileName}' divergiu após promoção para Downloads.`
            )
          }
        }

        const updatedReceipt: AcademyGeminiExportReceipt = {
          ...previousReceiptSnapshot,
          downloadsPath: destFolder
        }
        this.writeReceiptFileAtomic(modeReceiptPath, updatedReceipt)
        this.receipts[mode] = updatedReceipt

        if (backupFolder) {
          await rm(backupFolder, { recursive: true, force: true }).catch(() => {})
        }
      } catch (promotionError) {
        if (existsSync(destFolder)) {
          await rm(destFolder, { recursive: true, force: true }).catch(() => {})
        }
        if (backupFolder && existsSync(backupFolder)) {
          await moveDirectoryWithFallback(backupFolder, destFolder).catch(() => {})
        }
        this.receipts[mode] = previousReceiptSnapshot
        this.restoreRawReceiptFile(modeReceiptPath, previousReceiptFileBytes)
        throw promotionError
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.emitChange()
      throw error
    } finally {
      await rm(stagedFolder, { recursive: true, force: true }).catch(() => {})
    }

    await options?._onBeforeConfirm?.()

    if (this.getImportConfirmationPreference().mode === 'AUTOMATIC') {
      try {
        this.applyCheckpointsForEntries(
          mode,
          deliveredEntries,
          previousReceiptSnapshot.profileVersion,
          'ASSUMED_ON_DOWNLOAD'
        )
      } catch (confirmError) {
        this.lastError = confirmError instanceof Error ? confirmError.message : String(confirmError)
      }
    }

    this.emitChange()
    return this.getState()
  }

  confirmImport(input?: {
    skillIds?: string[]
    expectedFingerprints?: Record<string, string>
  }): AcademyGeminiExportState {
    this.lastError = null
    try {
      const state = this.getState()
      const mode = state.mode

      if (mode === 'FULL') {
        const receipt = this.receipts.FULL
        if (!receipt || state.drifted || !state.artifactAvailable) {
          throw new AcademyError(
            'GEMINI_EXPORT_NOT_READY',
            'Gere o pacote Gemini completo atualizado antes de confirmar a importação.'
          )
        }
        const diskHash = sha256(readFileSync(receipt.artifactPath))
        if (diskHash !== receipt.artifactHash) {
          throw new AcademyError('GEMINI_EXPORT_ARTIFACT_CORRUPT', 'O ZIP preparado diverge do recibo registrado.')
        }
        this.distributionState.fullImportConfirmation = {
          artifactHash: receipt.artifactHash,
          confirmedAt: new Date().toISOString(),
          origin: 'MANUAL',
          skillCount: receipt.skillCount
        }
        this.persistDistributionState()
        this.emitChange()
        return this.getState()
      }

      const modeReceipt = this.receipts[mode]
      if (!modeReceipt || modeReceipt.skills.length === 0) {
        throw new AcademyError(
          'GEMINI_IMPORT_NOTHING_PENDING',
          'Nenhum pacote diferencial preparado encontrado para confirmar importação.'
        )
      }

      const receiptEntryById = new Map(
        modeReceipt.skills.filter((e) => Boolean(e.skillId)).map((e) => [e.skillId!, e])
      )
      const sourceDir = this.modeDirectoryPath(mode)

      const requestedIds =
        input?.skillIds && input.skillIds.length > 0
          ? [...new Set(input.skillIds)]
          : [...receiptEntryById.keys()]

      if (requestedIds.length === 0) {
        throw new AcademyError(
          'GEMINI_IMPORT_NOTHING_PENDING',
          'Nenhuma Skill preparada selecionada para confirmar importação.'
        )
      }

      const targetEntries: AcademyGeminiSkillExportEntry[] = []
      for (const skillId of requestedIds) {
        const entry = receiptEntryById.get(skillId)
        if (!entry) {
          throw new AcademyError(
            'GEMINI_IMPORT_CONFIRMATION_NOT_PREPARED',
            `Skill '${skillId}' não faz parte do lote preparado atual.`
          )
        }

        const zipFile = join(sourceDir, entry.zipFileName ?? `${entry.name}.zip`)
        if (!existsSync(zipFile)) {
          throw new AcademyError(
            'GEMINI_EXPORT_ARTIFACT_MISSING',
            `Arquivo '${entry.zipFileName ?? `${entry.name}.zip`}' não encontrado para confirmação.`
          )
        }
        if (sha256(readFileSync(zipFile)) !== entry.zipSha256) {
          throw new AcademyError(
            'GEMINI_EXPORT_ARTIFACT_CORRUPT',
            `Arquivo '${entry.zipFileName ?? `${entry.name}.zip`}' não corresponde ao hash preparado.`
          )
        }
        targetEntries.push(entry)
      }

      this.applyCheckpointsForEntries(
        mode,
        targetEntries,
        modeReceipt.profileVersion,
        'MANUAL',
        input?.expectedFingerprints
      )
      this.emitChange()
      return this.getState()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.emitChange()
      throw error
    }
  }

  private applyCheckpointsForEntries(
    mode: 'INCREMENTAL' | 'MCP_TRIGGERS',
    entries: AcademyGeminiSkillExportEntry[],
    receiptProfileVersion: string | undefined,
    origin: AcademyImportConfirmationOrigin,
    expectedFingerprints?: Record<string, string>
  ): void {
    const activeProfileVersion =
      mode === 'MCP_TRIGGERS' ? GEMINI_MCP_STUB_PROFILE_VERSION : GEMINI_ADAPTATION_PROFILE_VERSION
    if (receiptProfileVersion !== activeProfileVersion) {
      throw new AcademyError(
        'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
        'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: O perfil de exportação mudou desde a geração do ZIP. Existe uma atualização pendente; regere o lote antes de confirmar.'
      )
    }

    const evalResult = this.evaluateModeCatalog(mode)
    const eligibleById = new Map(evalResult.eligibleSkills.map((s) => [s.id, s]))
    const confirmedAt = new Date().toISOString()
    const stagedCheckpoints: Array<[string, AcademyGeminiSkillCheckpoint]> = []

    for (const entry of entries) {
      if (!entry.skillId || !entry.fingerprint) {
        throw new AcademyError(
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
          `GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: O recibo de '${entry.name}' não possui fingerprint válido. Existe uma atualização pendente; regere o lote antes de confirmar.`
        )
      }

      const currentSkill = eligibleById.get(entry.skillId)
      if (!currentSkill) {
        throw new AcademyError(
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
          `GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: A Skill '${entry.name}' não é mais elegível na Academy. Existe uma atualização pendente; regere o lote antes de confirmar.`
        )
      }

      if (currentSkill.name !== entry.name) {
        throw new AcademyError(
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
          `GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: A Skill '${entry.name}' foi renomeada para '${currentSkill.name}'. Existe uma atualização pendente; regere o lote antes de confirmar.`
        )
      }

      if (entry.academyVersion === undefined || currentSkill.currentVersion !== entry.academyVersion) {
        throw new AcademyError(
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
          `GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: A Skill '${currentSkill.name}' mudou para v${currentSkill.currentVersion} após a geração do ZIP (v${entry.academyVersion ?? '?'}). Existe uma atualização pendente; regere o lote antes de confirmar.`
        )
      }

      const currentPackageHash = evalResult.packageHashes.get(entry.skillId) ?? ''
      if (!entry.packageHash || currentPackageHash !== entry.packageHash) {
        throw new AcademyError(
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
          `GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: O conteúdo/hash da Skill '${currentSkill.name}' mudou após a geração do ZIP. Existe uma atualização pendente; regere o lote antes de confirmar.`
        )
      }

      const currentFingerprint = this.computeFingerprintForSkill(mode, currentSkill, evalResult.packageHashes)
      if (currentFingerprint !== entry.fingerprint) {
        throw new AcademyError(
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
          `GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: O fingerprint de '${currentSkill.name}' divergiu do recibo entregue. Existe uma atualização pendente; regere o lote antes de confirmar.`
        )
      }

      if (
        expectedFingerprints &&
        Object.hasOwn(expectedFingerprints, entry.skillId) &&
        (expectedFingerprints[entry.skillId] !== entry.fingerprint ||
          expectedFingerprints[entry.skillId] !== currentFingerprint)
      ) {
        throw new AcademyError(
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
          `GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: O fingerprint esperado para '${currentSkill.name}' está obsoleto. Existe uma atualização pendente; regere o lote antes de confirmar.`
        )
      }

      stagedCheckpoints.push([
        entry.skillId,
        {
          skillId: entry.skillId,
          skillName: entry.name,
          academyVersion: entry.academyVersion,
          packageHash: entry.packageHash,
          profileVersion: activeProfileVersion,
          fingerprint: entry.fingerprint,
          confirmedAt,
          origin,
          ...(mode === 'MCP_TRIGGERS' ? { description: currentSkill.description } : {})
        }
      ])
    }

    if (stagedCheckpoints.length === 0) {
      throw new AcademyError('GEMINI_IMPORT_NOTHING_PENDING', 'Nenhuma Skill válida encontrada no lote para confirmar.')
    }

    const checkpoints = this.checkpointsForMode(mode)
    const confirmedSet = new Set<string>()
    for (const [skillId, checkpoint] of stagedCheckpoints) {
      checkpoints[skillId] = checkpoint
      confirmedSet.add(skillId)
    }

    this.persistDistributionState()

    const receipt = this.receipts[mode]
    if (receipt) {
      const dirPath = this.modeDirectoryPath(mode)
      const remainingSkills = []
      for (const entry of receipt.skills) {
        if (entry.skillId && confirmedSet.has(entry.skillId)) {
          const zipFile = join(dirPath, entry.zipFileName ?? `${entry.name}.zip`)
          if (existsSync(zipFile)) {
            unlinkSync(zipFile)
          }
        } else {
          remainingSkills.push(entry)
        }
      }

      if (remainingSkills.length === 0) {
        this.clearModePreparedArtifacts(mode)
      } else {
        const updatedArtifactHash = sha256(
          canonicalJson(
            remainingSkills.map((item) => ({
              skillId: item.skillId ?? '',
              zipFileName: item.zipFileName ?? `${item.name}.zip`,
              zipSha256: item.zipSha256,
              fingerprint: item.fingerprint ?? ''
            }))
          )
        )
        const updatedReceipt: AcademyGeminiExportReceipt = {
          ...receipt,
          artifactHash: updatedArtifactHash,
          skillCount: remainingSkills.length,
          totalBytes: remainingSkills.reduce((acc, item) => acc + item.byteLength, 0),
          skills: remainingSkills
        }
        this.writeReceiptFileAtomic(this.modeReceiptPath(mode), updatedReceipt)
        this.receipts[mode] = updatedReceipt
      }
    }
  }

  revokeImportConfirmation(input?: { skillIds?: string[] }): AcademyGeminiExportState {
    const mode = this.distributionState.mode
    if (mode === 'FULL') {
      if (this.distributionState.fullImportConfirmation !== null) {
        this.distributionState.fullImportConfirmation = null
        this.persistDistributionState()
        this.emitChange()
      }
      return this.getState()
    }

    const checkpoints = this.checkpointsForMode(mode)
    let changed = false
    if (input?.skillIds && input.skillIds.length > 0) {
      for (const skillId of input.skillIds) {
        if (Object.hasOwn(checkpoints, skillId)) {
          delete checkpoints[skillId]
          changed = true
        }
      }
    } else if (Object.keys(checkpoints).length > 0) {
      if (mode === 'MCP_TRIGGERS') {
        this.distributionState.mcpTriggerCheckpoints = {}
      } else {
        this.distributionState.incrementalCheckpoints = {}
      }
      changed = true
    }

    if (changed) {
      this.persistDistributionState()
      this.emitChange()
    }
    return this.getState()
  }

  establishBaseline(input?: { skillIds?: string[] }): AcademyGeminiExportState {
    const mode = this.distributionState.mode
    if (mode === 'FULL') {
      throw new AcademyError(
        'GEMINI_BASELINE_DIFFERENTIAL_ONLY',
        'Estabelecimento de base aplica-se apenas aos modos Incremental ou Gatilhos MCP.'
      )
    }

    const activeProfileVersion =
      mode === 'MCP_TRIGGERS' ? GEMINI_MCP_STUB_PROFILE_VERSION : GEMINI_ADAPTATION_PROFILE_VERSION
    const evalResult = this.evaluateModeCatalog(mode)
    const eligibleById = new Map(evalResult.eligibleSkills.map((s) => [s.id, s]))
    const targetIds =
      input?.skillIds && input.skillIds.length > 0
        ? input.skillIds.filter((id) => eligibleById.has(id))
        : [...eligibleById.keys()]

    const checkpoints = this.checkpointsForMode(mode)
    const confirmedAt = new Date().toISOString()

    for (const skillId of targetIds) {
      const skill = eligibleById.get(skillId)
      if (!skill) continue
      const packageHash = evalResult.packageHashes.get(skillId) ?? ''
      const fingerprint = this.computeFingerprintForSkill(mode, skill, evalResult.packageHashes)
      checkpoints[skillId] = {
        skillId,
        skillName: skill.name,
        academyVersion: skill.currentVersion,
        packageHash,
        profileVersion: activeProfileVersion,
        fingerprint,
        confirmedAt,
        origin: 'MANUAL',
        ...(mode === 'MCP_TRIGGERS' ? { description: skill.description } : {})
      }
    }

    this.persistDistributionState()

    // Remove prepared ZIPs belonging to newly baselined skills so no contradictory pending files linger
    const receipt = this.receipts[mode]
    if (receipt && targetIds.length > 0) {
      const targetSet = new Set(targetIds)
      const dirPath = this.modeDirectoryPath(mode)
      const remaining = receipt.skills.filter((entry) => {
        if (entry.skillId && targetSet.has(entry.skillId)) {
          const zipFile = join(dirPath, entry.zipFileName ?? `${entry.name}.zip`)
          if (existsSync(zipFile)) unlinkSync(zipFile)
          return false
        }
        return true
      })
      if (remaining.length === 0) {
        this.clearModePreparedArtifacts(mode)
      } else if (remaining.length !== receipt.skills.length) {
        const updatedReceipt: AcademyGeminiExportReceipt = {
          ...receipt,
          skillCount: remaining.length,
          totalBytes: remaining.reduce((acc, item) => acc + item.byteLength, 0),
          skills: remaining
        }
        this.writeReceiptFileAtomic(this.modeReceiptPath(mode), updatedReceipt)
        this.receipts[mode] = updatedReceipt
      }
    }

    this.emitChange()
    return this.getState()
  }

  acknowledgeManualAction(skillId: string): AcademyGeminiExportState {
    const mode = this.distributionState.mode
    if (mode === 'FULL') {
      return this.getState()
    }
    const checkpoints = this.checkpointsForMode(mode)
    if (Object.hasOwn(checkpoints, skillId)) {
      delete checkpoints[skillId]
      this.persistDistributionState()
      this.emitChange()
    }
    return this.getState()
  }

  getArtifactPath(): string | null {
    const mode = this.distributionState.mode
    if (mode === 'FULL') {
      const fullReceipt = this.receipts.FULL
      if (fullReceipt && existsSync(fullReceipt.artifactPath)) {
        return fullReceipt.artifactPath
      }
      if (existsSync(this.masterZipPath)) {
        return this.masterZipPath
      }
      return null
    }
    const dirPath = this.modeDirectoryPath(mode)
    if (existsSync(dirPath)) {
      return dirPath
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
