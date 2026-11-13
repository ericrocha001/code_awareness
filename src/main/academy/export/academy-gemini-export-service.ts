import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
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

  private writeReceiptFileAtomic(filePath: string, receipt: AcademyGeminiExportReceipt): void {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmpPath, JSON.stringify(receipt, null, 2), 'utf8')
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

  async downloadExport(targetDirectory?: string): Promise<AcademyGeminiExportState> {
    const destinationRoot = targetDirectory ?? this.downloadsPath
    if (!destinationRoot) {
      throw new AcademyError(
        'GEMINI_DOWNLOAD_DIRECTORY_UNAVAILABLE',
        'Pasta Downloads não configurada para entrega do pacote Gemini.'
      )
    }

    const state = this.getState()
    const mode = state.mode
    const receipt = this.receipts[mode]

    if (!receipt || state.drifted || !state.artifactAvailable) {
      throw new AcademyError(
        'GEMINI_EXPORT_NOT_READY',
        'GEMINI_EXPORT_NOT_READY: Gere ou atualize o pacote Gemini antes de baixar.'
      )
    }

    if (mode === 'FULL') {
      if (!existsSync(receipt.artifactPath)) {
        throw new AcademyError('GEMINI_EXPORT_ARTIFACT_MISSING', 'Arquivo academy-gemini.zip não encontrado no disco.')
      }
      const sourceBytes = await readFile(receipt.artifactPath)
      if (sha256(sourceBytes) !== receipt.artifactHash) {
        throw new AcademyError(
          'GEMINI_EXPORT_ARTIFACT_CORRUPT',
          'O pacote academy-gemini.zip preparado não corresponde ao hash do recibo.'
        )
      }

      await mkdir(destinationRoot, { recursive: true })
      const destZipPath = join(destinationRoot, 'academy-gemini.zip')
      const stagedDestPath = `${destZipPath}.${randomUUID()}.stage`
      try {
        await writeFile(stagedDestPath, sourceBytes)
        const writtenHash = sha256(await readFile(stagedDestPath))
        if (writtenHash !== receipt.artifactHash) {
          throw new AcademyError('GEMINI_DOWNLOAD_COPY_MISMATCH', 'Falha na verificação de integridade após cópia para Downloads.')
        }
        await rename(stagedDestPath, destZipPath)
      } finally {
        await unlink(stagedDestPath).catch(() => {})
      }

      receipt.downloadsPath = destZipPath
      this.writeReceiptFileAtomic(this.receiptPath, receipt)
      this.receipts.FULL = receipt

      const evalAfter = evaluateGeminiCatalog(this.store, receipt, GEMINI_ADAPTATION_PROFILE_VERSION)
      if (
        this.getImportConfirmationPreference().mode === 'AUTOMATIC' &&
        evalAfter.canonicalSnapshotHash === receipt.snapshotHash
      ) {
        this.distributionState.fullImportConfirmation = {
          artifactHash: receipt.artifactHash,
          confirmedAt: new Date().toISOString(),
          origin: 'ASSUMED_ON_DOWNLOAD',
          skillCount: receipt.skillCount
        }
        this.persistDistributionState()
      }

      this.emitChange()
      return this.getState()
    }

    // INCREMENTAL or MCP_TRIGGERS
    const sourceDir = this.modeDirectoryPath(mode)
    const freshState = this.getState()
    const freshPendingById = new Map(freshState.pendingSkills.map((p) => [p.skillId, p]))

    const filesToCopy: Array<{ fileName: string; sourcePath: string; expectedHash: string; skillId: string }> = []
    for (const entry of receipt.skills) {
      if (!entry.skillId) continue
      const currentPending = freshPendingById.get(entry.skillId)
      if (!currentPending || currentPending.fingerprint !== entry.fingerprint) {
        throw new AcademyError(
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
          `A Skill '${entry.name}' avançou na Academy após a geração do lote. Regere antes de baixar.`
        )
      }
      const fileName = entry.zipFileName ?? `${entry.name}.zip`
      const sourcePath = join(sourceDir, fileName)
      if (!existsSync(sourcePath)) {
        throw new AcademyError('GEMINI_EXPORT_ARTIFACT_MISSING', `Arquivo '${fileName}' ausente na pasta preparada.`)
      }
      const sourceBytes = await readFile(sourcePath)
      if (sha256(sourceBytes) !== entry.zipSha256) {
        throw new AcademyError('GEMINI_EXPORT_ARTIFACT_CORRUPT', `Hash de '${fileName}' não confere com o recibo.`)
      }
      filesToCopy.push({ fileName, sourcePath, expectedHash: entry.zipSha256, skillId: entry.skillId })
    }

    if (filesToCopy.length === 0) {
      throw new AcademyError('GEMINI_NO_PENDING_SKILLS', 'Nenhuma Skill pendente para entrega.')
    }

    const subfolderName = mode === 'INCREMENTAL' ? 'academy-gemini-incremental' : 'academy-gemini-mcp-triggers'
    const destFolder = join(destinationRoot, subfolderName)
    await mkdir(destinationRoot, { recursive: true })
    const stagedFolder = `${destFolder}.${randomUUID()}.stage`

    try {
      await mkdir(stagedFolder, { recursive: true })
      for (const item of filesToCopy) {
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

      if (existsSync(destFolder)) {
        await rm(destFolder, { recursive: true, force: true })
      }
      await rename(stagedFolder, destFolder)
    } finally {
      await rm(stagedFolder, { recursive: true, force: true }).catch(() => {})
    }

    receipt.downloadsPath = destFolder
    this.writeReceiptFileAtomic(this.modeReceiptPath(mode), receipt)
    this.receipts[mode] = receipt

    if (this.getImportConfirmationPreference().mode === 'AUTOMATIC') {
      this.applyCheckpointsForEntries(
        mode,
        filesToCopy.map((f) => f.skillId),
        'ASSUMED_ON_DOWNLOAD'
      )
    }

    this.emitChange()
    return this.getState()
  }

  confirmImport(input?: {
    skillIds?: string[]
    expectedFingerprints?: Record<string, string>
  }): AcademyGeminiExportState {
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

    const activeProfileVersion =
      mode === 'MCP_TRIGGERS' ? GEMINI_MCP_STUB_PROFILE_VERSION : GEMINI_ADAPTATION_PROFILE_VERSION
    const evalResult = this.evaluateModeCatalog(mode)
    const eligibleById = new Map(evalResult.eligibleSkills.map((s) => [s.id, s]))
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

    // Precondição CAS rigorosa para todas as Skills alvo antes de persistir qualquer checkpoint
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

      const currentSkill = eligibleById.get(skillId)
      if (!currentSkill) {
        throw new AcademyError(
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
          `Skill '${entry.name}' não é mais elegível na Academy; regere o lote antes de confirmar.`
        )
      }

      const currentFingerprint = this.computeFingerprintForSkill(mode, currentSkill, evalResult.packageHashes)
      if (
        modeReceipt.profileVersion !== activeProfileVersion ||
        entry.fingerprint !== currentFingerprint ||
        entry.name !== currentSkill.name
      ) {
        throw new AcademyError(
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
          `GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: A Skill '${currentSkill.name}' mudou para v${currentSkill.currentVersion} após a geração do ZIP (${entry.academyVersion ?? '?'}). Regere o lote antes de confirmar.`
        )
      }

      if (input?.expectedFingerprints?.[skillId] && input.expectedFingerprints[skillId] !== currentFingerprint) {
        throw new AcademyError(
          'GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT',
          `GEMINI_IMPORT_CONFIRMATION_STALE_CONFLICT: A versão esperada para '${currentSkill.name}' está obsoleta.`
        )
      }
    }

    this.applyCheckpointsForEntries(mode, requestedIds, 'MANUAL')
    this.emitChange()
    return this.getState()
  }

  private applyCheckpointsForEntries(
    mode: 'INCREMENTAL' | 'MCP_TRIGGERS',
    skillIds: string[],
    origin: AcademyImportConfirmationOrigin
  ): void {
    const activeProfileVersion =
      mode === 'MCP_TRIGGERS' ? GEMINI_MCP_STUB_PROFILE_VERSION : GEMINI_ADAPTATION_PROFILE_VERSION
    const evalResult = this.evaluateModeCatalog(mode)
    const eligibleById = new Map(evalResult.eligibleSkills.map((s) => [s.id, s]))
    const checkpoints = this.checkpointsForMode(mode)
    const confirmedAt = new Date().toISOString()

    const confirmedSet = new Set(skillIds)
    for (const skillId of skillIds) {
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
        origin,
        ...(mode === 'MCP_TRIGGERS' ? { description: skill.description } : {})
      }
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
