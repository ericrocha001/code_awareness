import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import type {
  StageUnitPromptOptions,
  UnitPromptStageResult,
  UnitPromptStageInspection,
  UnitPromptReleaseResult
} from '../../../shared/types/buildx/execution-types'
import type { UnitFlowUnitRecord } from '../../../shared/types/buildx/unitflow-types'
import { validateRepositoryId } from '../smc/session-memory-central-paths'
import type { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import type { WorkspaceBindingService } from './workspace-binding-service'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PROMPT_BYTES = 64 * 1024 // 64 KiB
const DEFAULT_TTL_MS = 10 * 60 * 1000 // 10 minutes

interface InternalStageRecord {
  status: 'READY' | 'RELEASED' | 'EXPIRED' | 'FAILED'
  stageOperationId: string
  repositoryId: string
  sessionId: string
  attemptId: string
  planId: string
  unitId: string
  promptHash: string
  promptBytes: number
  headObserved: string
  filePath: string
  createdAt: string
  expiresAt: string
  reason?: string
}

export function buildDeterministicUnitPrompt(unit: UnitFlowUnitRecord): string {
  const deps =
    unit.dependsOnUnitIds && unit.dependsOnUnitIds.length > 0
      ? unit.dependsOnUnitIds.map(d => `- ${d}`).join('\n')
      : 'None'

  return [
    '# Implementation Task',
    '',
    '## Task Identity',
    `- Plan ID: ${unit.planId}`,
    `- Unit ID: ${unit.unitId}`,
    `- Position: ${unit.position}`,
    `- Title: ${unit.title}`,
    '',
    '## Objective',
    unit.objective,
    '',
    '## Acceptance Criteria',
    unit.acceptanceCriteria,
    '',
    '## Declared Dependencies',
    deps,
    '',
    '## Instructions',
    'Preserve repository and worktree integrity. Do not execute unauthorized actions or bypass gates. Request execution and validation under future authorized gates only.',
    ''
  ].join('\n')
}

function normalizePathForComparison(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInsideOrEqual(target: string, parent: string): boolean {
  const normTarget = normalizePathForComparison(target)
  const normParent = normalizePathForComparison(parent)
  if (normTarget === normParent) return true
  const rel = path.relative(normParent, normTarget)
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

export interface UnitPromptStageServiceOptions {
  readonly stagingDirectory?: string
  readonly ttlMs?: number
  readonly clock?: () => number
  readonly worktreePathResolver?: (
    repositoryId: string,
    worktreeId: string
  ) => Promise<string | null> | string | null
}

export class UnitPromptStageService {
  private readonly smcService: SessionMemoryCentralService
  private readonly workspaceService: WorkspaceBindingService
  private readonly stagingDirectory: string
  private readonly ttlMs: number
  private readonly clock: () => number
  private readonly worktreePathResolver?: (
    repositoryId: string,
    worktreeId: string
  ) => Promise<string | null> | string | null
  private readonly stages = new Map<string, InternalStageRecord>()

  constructor(
    smcService: SessionMemoryCentralService,
    workspaceService: WorkspaceBindingService,
    options?: UnitPromptStageServiceOptions
  ) {
    this.smcService = smcService
    this.workspaceService = workspaceService
    this.stagingDirectory =
      options?.stagingDirectory ?? path.join(os.tmpdir(), 'antigravity-buildx-prompt-stage')
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS
    this.clock = options?.clock ?? (() => Date.now())
    this.worktreePathResolver = options?.worktreePathResolver
  }

  getStagingDirectory(): string {
    return this.stagingDirectory
  }

  async stageUnitPrompt(
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    options: StageUnitPromptOptions
  ): Promise<UnitPromptStageResult> {
    // 1. Parameter validation
    let cleanRepoId: string
    try {
      cleanRepoId = validateRepositoryId(repositoryId)
    } catch {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: options?.stageOperationId ?? '',
        repositoryId: repositoryId ?? '',
        sessionId: sessionId ?? '',
        attemptId: attemptId ?? '',
        reason: 'INVALID_REPOSITORY_ID'
      }
    }

    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: options?.stageOperationId ?? '',
        repositoryId: cleanRepoId,
        sessionId: sessionId ?? '',
        attemptId: attemptId ?? '',
        reason: 'INVALID_SESSION_ID'
      }
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof attemptId !== 'string' || !attemptId.trim() || !UUID_REGEX.test(attemptId.trim())) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: options?.stageOperationId ?? '',
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: attemptId ?? '',
        reason: 'INVALID_ATTEMPT_ID'
      }
    }
    const cleanAttemptId = attemptId.trim().toLowerCase()

    if (
      !options ||
      typeof options.stageOperationId !== 'string' ||
      !options.stageOperationId.trim() ||
      !UUID_REGEX.test(options.stageOperationId.trim())
    ) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: options?.stageOperationId ?? '',
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'INVALID_STAGE_OPERATION_ID'
      }
    }
    const cleanStageOpId = options.stageOperationId.trim().toLowerCase()

    // 2. Idempotency check on same stageOperationId
    const existing = this.stages.get(cleanStageOpId)
    if (existing) {
      if (
        existing.repositoryId !== cleanRepoId ||
        existing.sessionId !== cleanSessionId ||
        existing.attemptId !== cleanAttemptId
      ) {
        return {
          success: false,
          status: 'FAILED',
          stageOperationId: cleanStageOpId,
          repositoryId: cleanRepoId,
          sessionId: cleanSessionId,
          attemptId: cleanAttemptId,
          reason: 'STAGE_ID_CONFLICT'
        }
      }

      const now = this.clock()
      const isExpired = now >= new Date(existing.expiresAt).getTime()
      if (!isExpired && existing.status === 'READY') {
        try {
          if (fs.existsSync(existing.filePath)) {
            const stat = fs.statSync(existing.filePath)
            if (stat.size === existing.promptBytes) {
              const content = fs.readFileSync(existing.filePath, 'utf8')
              const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex')
              if (hash === existing.promptHash) {
                return {
                  success: true,
                  status: 'READY',
                  stageOperationId: existing.stageOperationId,
                  repositoryId: existing.repositoryId,
                  sessionId: existing.sessionId,
                  attemptId: existing.attemptId,
                  promptHash: existing.promptHash,
                  promptBytes: existing.promptBytes,
                  headObserved: existing.headObserved,
                  createdAt: existing.createdAt,
                  expiresAt: existing.expiresAt
                }
              }
            }
          }
        } catch {
          // Fall through to cleanup
        }
      }

      this.cleanupStageRecord(existing)
      this.stages.delete(cleanStageOpId)
    }

    // 3. Ensure single active READY stage file per attempt
    for (const [id, rec] of this.stages.entries()) {
      if (id !== cleanStageOpId && rec.attemptId === cleanAttemptId && rec.status === 'READY') {
        this.cleanupStageRecord(rec)
        rec.status = 'RELEASED'
        rec.reason = 'SUPERSEDED_BY_NEW_STAGE'
      }
    }

    // 4. Pre-observation SMC checks (fail-closed, read-only)
    const store = this.smcService.getStore(cleanRepoId)

    const session = store.getSession(cleanSessionId)
    if (!session || session.status !== 'OPEN') {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: !session ? 'SESSION_NOT_FOUND' : 'SESSION_NOT_OPEN'
      }
    }

    const attempt = store.getExecutionAttempt(cleanAttemptId)
    if (!attempt) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'ATTEMPT_NOT_FOUND'
      }
    }

    if (attempt.sessionId !== cleanSessionId) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'ATTEMPT_SESSION_MISMATCH'
      }
    }

    if (attempt.status !== 'PREPARED') {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'ATTEMPT_NOT_PREPARED'
      }
    }

    const reservation = store.getReservation(attempt.reservationId)
    if (!reservation || reservation.status !== 'ACTIVE') {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: !reservation ? 'RESERVATION_NOT_FOUND' : 'RESERVATION_NOT_ACTIVE'
      }
    }

    if (reservation.sessionId !== cleanSessionId) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'RESERVATION_SESSION_MISMATCH'
      }
    }

    if (reservation.planId !== attempt.planId || reservation.unitId !== attempt.unitId) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'RESERVATION_MISMATCH'
      }
    }

    const plan = store.getPlan(attempt.planId)
    if (!plan || plan.status !== 'ACTIVE') {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: !plan ? 'PLAN_NOT_FOUND' : 'PLAN_NOT_ACTIVE'
      }
    }

    if (plan.sessionId !== cleanSessionId) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'PLAN_SESSION_MISMATCH'
      }
    }

    const unitState = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
    if (!unitState) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'UNIT_STATE_NOT_FOUND'
      }
    }

    if (unitState.status !== 'RESERVED') {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'UNIT_NOT_RESERVED'
      }
    }

    if (unitState.revision !== reservation.unitStateRevision) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'UNIT_REVISION_MISMATCH'
      }
    }

    if (
      attempt.worktreeId !== reservation.worktreeId ||
      attempt.generation !== reservation.generation ||
      attempt.branch !== reservation.branch
    ) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'ATTEMPT_WORKTREE_MISMATCH'
      }
    }

    const unit = store.getPlanUnit(cleanSessionId, attempt.planId, attempt.unitId)
    if (!unit) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'UNIT_MANIFEST_NOT_FOUND'
      }
    }

    if (unit.planId !== attempt.planId || unit.unitId !== attempt.unitId) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'UNIT_MANIFEST_MISMATCH'
      }
    }

    // 5. Pre-observation of Bound Workspace
    let wsPre
    try {
      wsPre = await this.workspaceService.inspectBoundWorkspace(cleanRepoId, cleanSessionId)
    } catch {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'WORKSPACE_INSPECTION_FAILED'
      }
    }

    if (wsPre.status !== 'CURRENT') {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'WORKSPACE_NOT_CURRENT'
      }
    }

    if (!wsPre.currentHead || typeof wsPre.currentHead !== 'string' || !wsPre.currentHead.trim()) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'WORKSPACE_HEAD_MISSING'
      }
    }

    if (
      wsPre.binding.worktreeId !== attempt.worktreeId ||
      wsPre.binding.generation !== attempt.generation ||
      wsPre.binding.branch !== attempt.branch
    ) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'WORKSPACE_BINDING_MISMATCH'
      }
    }
    const observedHeadPre = wsPre.currentHead

    // 6. Build prompt & verify byte length limit
    const promptText = buildDeterministicUnitPrompt(unit)
    const promptBytes = Buffer.byteLength(promptText, 'utf8')
    if (promptBytes > MAX_PROMPT_BYTES) {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'PROMPT_SIZE_EXCEEDS_64KB'
      }
    }
    const promptHash = crypto.createHash('sha256').update(promptText, 'utf8').digest('hex')

    // 7. Validate staging directory boundary
    const resolvedStageDir = path.resolve(this.stagingDirectory)
    let worktreePath: string | null = null
    if (this.worktreePathResolver) {
      try {
        worktreePath = await this.worktreePathResolver(cleanRepoId, attempt.worktreeId)
      } catch {
        worktreePath = null
      }
    } else if (typeof this.workspaceService.getWorktreePath === 'function') {
      try {
        worktreePath = await this.workspaceService.getWorktreePath(cleanRepoId, attempt.worktreeId)
      } catch {
        worktreePath = null
      }
    }

    if (worktreePath) {
      const resolvedWorktree = path.resolve(worktreePath)
      if (
        isInsideOrEqual(resolvedStageDir, resolvedWorktree) ||
        isInsideOrEqual(resolvedWorktree, resolvedStageDir)
      ) {
        return {
          success: false,
          status: 'FAILED',
          stageOperationId: cleanStageOpId,
          repositoryId: cleanRepoId,
          sessionId: cleanSessionId,
          attemptId: cleanAttemptId,
          reason: 'STAGE_DIRECTORY_INSIDE_WORKTREE'
        }
      }
    }

    try {
      if (!fs.existsSync(resolvedStageDir)) {
        fs.mkdirSync(resolvedStageDir, { recursive: true, mode: 0o700 })
      }
      const lstat = fs.lstatSync(resolvedStageDir)
      if (lstat.isSymbolicLink()) {
        return {
          success: false,
          status: 'FAILED',
          stageOperationId: cleanStageOpId,
          repositoryId: cleanRepoId,
          sessionId: cleanSessionId,
          attemptId: cleanAttemptId,
          reason: 'STAGE_DIRECTORY_IS_SYMLINK'
        }
      }
      if (!lstat.isDirectory()) {
        return {
          success: false,
          status: 'FAILED',
          stageOperationId: cleanStageOpId,
          repositoryId: cleanRepoId,
          sessionId: cleanSessionId,
          attemptId: cleanAttemptId,
          reason: 'STAGE_DIRECTORY_NOT_A_DIRECTORY'
        }
      }
    } catch {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'STAGE_DIRECTORY_ERROR'
      }
    }

    // 8. Exclusive file write with randomized name without unitId
    const randomHex = crypto.randomBytes(16).toString('hex')
    const fileName = `buildx-prompt-${randomHex}.tmp`
    const filePath = path.join(resolvedStageDir, fileName)

    try {
      fs.writeFileSync(filePath, promptText, { flag: 'wx', mode: 0o600, encoding: 'utf8' })
    } catch {
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'FILE_WRITE_FAILED'
      }
    }

    // 9. Post-creation revalidation gate
    try {
      const stat = fs.statSync(filePath)
      if (stat.size !== promptBytes) {
        this.safeUnlink(filePath)
        return {
          success: false,
          status: 'FAILED',
          stageOperationId: cleanStageOpId,
          repositoryId: cleanRepoId,
          sessionId: cleanSessionId,
          attemptId: cleanAttemptId,
          reason: 'FILE_WRITE_CORRUPTED'
        }
      }
      const fileContent = fs.readFileSync(filePath, 'utf8')
      const readHash = crypto.createHash('sha256').update(fileContent, 'utf8').digest('hex')
      if (readHash !== promptHash) {
        this.safeUnlink(filePath)
        return {
          success: false,
          status: 'FAILED',
          stageOperationId: cleanStageOpId,
          repositoryId: cleanRepoId,
          sessionId: cleanSessionId,
          attemptId: cleanAttemptId,
          reason: 'FILE_HASH_MISMATCH'
        }
      }
    } catch {
      this.safeUnlink(filePath)
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'FILE_VERIFICATION_FAILED'
      }
    }

    // Revalidate SMC state
    const sessionPost = store.getSession(cleanSessionId)
    if (!sessionPost || sessionPost.status !== 'OPEN') {
      this.safeUnlink(filePath)
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'SESSION_DRIFT_DURING_STAGE'
      }
    }

    const attemptPost = store.getExecutionAttempt(cleanAttemptId)
    if (!attemptPost || attemptPost.status !== 'PREPARED') {
      this.safeUnlink(filePath)
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'ATTEMPT_DRIFT_DURING_STAGE'
      }
    }

    const reservationPost = store.getReservation(attempt.reservationId)
    if (!reservationPost || reservationPost.status !== 'ACTIVE') {
      this.safeUnlink(filePath)
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'RESERVATION_DRIFT_DURING_STAGE'
      }
    }

    const planPost = store.getPlan(attempt.planId)
    if (!planPost || planPost.status !== 'ACTIVE') {
      this.safeUnlink(filePath)
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'PLAN_DRIFT_DURING_STAGE'
      }
    }

    const unitStatePost = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
    if (
      !unitStatePost ||
      unitStatePost.status !== 'RESERVED' ||
      unitStatePost.revision !== reservationPost.unitStateRevision
    ) {
      this.safeUnlink(filePath)
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'UNIT_DRIFT_DURING_STAGE'
      }
    }

    // Revalidate Workspace & HEAD
    let wsPost
    try {
      wsPost = await this.workspaceService.inspectBoundWorkspace(cleanRepoId, cleanSessionId)
    } catch {
      this.safeUnlink(filePath)
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'WORKSPACE_POST_INSPECTION_FAILED'
      }
    }

    if (
      wsPost.status !== 'CURRENT' ||
      wsPost.binding.worktreeId !== attempt.worktreeId ||
      wsPost.binding.generation !== attempt.generation ||
      wsPost.binding.branch !== attempt.branch
    ) {
      this.safeUnlink(filePath)
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'WORKSPACE_DRIFT_DURING_STAGE'
      }
    }

    if (wsPost.currentHead !== observedHeadPre) {
      this.safeUnlink(filePath)
      return {
        success: false,
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'HEAD_DRIFT_DURING_STAGE'
      }
    }

    // 10. Record in memory and return compact receipt (NO filePath, NO prompt content)
    const now = this.clock()
    const createdAt = new Date(now).toISOString()
    const expiresAt = new Date(now + this.ttlMs).toISOString()

    const record: InternalStageRecord = {
      status: 'READY',
      stageOperationId: cleanStageOpId,
      repositoryId: cleanRepoId,
      sessionId: cleanSessionId,
      attemptId: cleanAttemptId,
      planId: attempt.planId,
      unitId: attempt.unitId,
      promptHash,
      promptBytes,
      headObserved: observedHeadPre,
      filePath,
      createdAt,
      expiresAt
    }

    this.stages.set(cleanStageOpId, record)

    return {
      success: true,
      status: 'READY',
      stageOperationId: cleanStageOpId,
      repositoryId: cleanRepoId,
      sessionId: cleanSessionId,
      attemptId: cleanAttemptId,
      promptHash,
      promptBytes,
      headObserved: observedHeadPre,
      createdAt,
      expiresAt
    }
  }

  async inspectStagedPrompt(
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    stageOperationId: string
  ): Promise<UnitPromptStageInspection> {
    let cleanRepoId: string
    try {
      cleanRepoId = validateRepositoryId(repositoryId)
    } catch {
      return {
        status: 'UNKNOWN',
        stageOperationId: stageOperationId ?? '',
        repositoryId: repositoryId ?? '',
        sessionId: sessionId ?? '',
        attemptId: attemptId ?? '',
        reason: 'INVALID_REPOSITORY_ID'
      }
    }

    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      return {
        status: 'UNKNOWN',
        stageOperationId: stageOperationId ?? '',
        repositoryId: cleanRepoId,
        sessionId: sessionId ?? '',
        attemptId: attemptId ?? '',
        reason: 'INVALID_SESSION_ID'
      }
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof attemptId !== 'string' || !attemptId.trim() || !UUID_REGEX.test(attemptId.trim())) {
      return {
        status: 'UNKNOWN',
        stageOperationId: stageOperationId ?? '',
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: attemptId ?? '',
        reason: 'INVALID_ATTEMPT_ID'
      }
    }
    const cleanAttemptId = attemptId.trim().toLowerCase()

    if (
      typeof stageOperationId !== 'string' ||
      !stageOperationId.trim() ||
      !UUID_REGEX.test(stageOperationId.trim())
    ) {
      return {
        status: 'UNKNOWN',
        stageOperationId: stageOperationId ?? '',
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'INVALID_STAGE_OPERATION_ID'
      }
    }
    const cleanStageOpId = stageOperationId.trim().toLowerCase()

    const record = this.stages.get(cleanStageOpId)
    if (!record) {
      return {
        status: 'UNKNOWN',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'STAGE_NOT_FOUND_OR_EXPIRED'
      }
    }

    if (
      record.repositoryId !== cleanRepoId ||
      record.sessionId !== cleanSessionId ||
      record.attemptId !== cleanAttemptId
    ) {
      return {
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'SCOPE_MISMATCH'
      }
    }

    const now = this.clock()
    if (now >= new Date(record.expiresAt).getTime()) {
      this.cleanupStageRecord(record)
      record.status = 'EXPIRED'
      return {
        status: 'EXPIRED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'STAGE_EXPIRED'
      }
    }

    if (record.status !== 'READY') {
      return {
        status: record.status,
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: record.reason
      }
    }

    try {
      if (!fs.existsSync(record.filePath)) {
        record.status = 'FAILED'
        record.reason = 'FILE_MISSING'
        return {
          status: 'FAILED',
          stageOperationId: cleanStageOpId,
          repositoryId: cleanRepoId,
          sessionId: cleanSessionId,
          attemptId: cleanAttemptId,
          reason: 'FILE_MISSING'
        }
      }
      const stat = fs.statSync(record.filePath)
      if (stat.size !== record.promptBytes) {
        this.safeUnlink(record.filePath)
        record.status = 'FAILED'
        record.reason = 'FILE_CORRUPTED'
        return {
          status: 'FAILED',
          stageOperationId: cleanStageOpId,
          repositoryId: cleanRepoId,
          sessionId: cleanSessionId,
          attemptId: cleanAttemptId,
          reason: 'FILE_CORRUPTED'
        }
      }
    } catch {
      record.status = 'FAILED'
      record.reason = 'FILE_CHECK_FAILED'
      return {
        status: 'FAILED',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'FILE_CHECK_FAILED'
      }
    }

    return {
      status: 'READY',
      stageOperationId: record.stageOperationId,
      repositoryId: record.repositoryId,
      sessionId: record.sessionId,
      attemptId: record.attemptId,
      promptHash: record.promptHash,
      promptBytes: record.promptBytes,
      headObserved: record.headObserved,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt
    }
  }

  async releaseStagedPrompt(
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    stageOperationId: string
  ): Promise<UnitPromptReleaseResult> {
    const cleanRepoId = repositoryId?.trim().toLowerCase() ?? ''
    const cleanSessionId = sessionId?.trim().toLowerCase() ?? ''
    const cleanAttemptId = attemptId?.trim().toLowerCase() ?? ''
    const cleanStageOpId = stageOperationId?.trim().toLowerCase() ?? ''

    const record = this.stages.get(cleanStageOpId)
    if (!record) {
      return {
        success: false,
        status: 'UNKNOWN',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'STAGE_NOT_FOUND'
      }
    }

    if (
      record.repositoryId !== cleanRepoId ||
      record.sessionId !== cleanSessionId ||
      record.attemptId !== cleanAttemptId
    ) {
      return {
        success: false,
        status: 'UNKNOWN',
        stageOperationId: cleanStageOpId,
        repositoryId: cleanRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'SCOPE_MISMATCH'
      }
    }

    this.cleanupStageRecord(record)
    this.stages.delete(cleanStageOpId)

    return {
      success: true,
      status: 'RELEASED',
      stageOperationId: cleanStageOpId,
      repositoryId: cleanRepoId,
      sessionId: cleanSessionId,
      attemptId: cleanAttemptId
    }
  }

  resolveStagedPromptPath(
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    stageOperationId: string
  ): string | null {
    const cleanRepoId = repositoryId?.trim().toLowerCase() ?? ''
    const cleanSessionId = sessionId?.trim().toLowerCase() ?? ''
    const cleanAttemptId = attemptId?.trim().toLowerCase() ?? ''
    const cleanStageOpId = stageOperationId?.trim().toLowerCase() ?? ''

    const record = this.stages.get(cleanStageOpId)
    if (!record || record.status !== 'READY') return null

    if (
      record.repositoryId !== cleanRepoId ||
      record.sessionId !== cleanSessionId ||
      record.attemptId !== cleanAttemptId
    ) {
      return null
    }

    const now = this.clock()
    if (now >= new Date(record.expiresAt).getTime()) {
      this.cleanupStageRecord(record)
      return null
    }

    try {
      if (!fs.existsSync(record.filePath)) return null
      const stat = fs.statSync(record.filePath)
      if (stat.size !== record.promptBytes) return null
      const content = fs.readFileSync(record.filePath, 'utf8')
      const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex')
      if (hash !== record.promptHash) return null
    } catch {
      return null
    }

    return record.filePath
  }

  cleanupExpiredStages(): number {
    let cleanedCount = 0
    const now = this.clock()

    for (const [id, record] of Array.from(this.stages.entries())) {
      if (now >= new Date(record.expiresAt).getTime() || record.status !== 'READY') {
        this.cleanupStageRecord(record)
        this.stages.delete(id)
        cleanedCount++
      }
    }

    try {
      const resolvedStageDir = path.resolve(this.stagingDirectory)
      if (fs.existsSync(resolvedStageDir)) {
        const files = fs.readdirSync(resolvedStageDir)
        const activePaths = new Set(
          Array.from(this.stages.values())
            .filter(r => r.status === 'READY')
            .map(r => normalizePathForComparison(r.filePath))
        )

        for (const file of files) {
          if (file.startsWith('buildx-prompt-') && file.endsWith('.tmp')) {
            const fullPath = path.join(resolvedStageDir, file)
            const norm = normalizePathForComparison(fullPath)
            if (!activePaths.has(norm)) {
              try {
                const lstat = fs.lstatSync(fullPath)
                if (!lstat.isSymbolicLink() && lstat.isFile()) {
                  fs.unlinkSync(fullPath)
                  cleanedCount++
                }
              } catch {}
            }
          }
        }
      }
    } catch {}

    return cleanedCount
  }

  private safeUnlink(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        const lstat = fs.lstatSync(filePath)
        if (!lstat.isSymbolicLink() && lstat.isFile()) {
          fs.unlinkSync(filePath)
        }
      }
    } catch {}
  }

  private cleanupStageRecord(record: InternalStageRecord): void {
    if (record.filePath) {
      this.safeUnlink(record.filePath)
    }
  }
}
