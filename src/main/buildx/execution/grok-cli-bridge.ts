import type {
  GrokCliPreAdmissionResult
} from '../../../shared/types/buildx/execution-types'
import { validateRepositoryId } from '../smc/session-memory-central-paths'
import type { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import type { WorkspaceBindingService } from './workspace-binding-service'
import type { PrepareCliExecutionInput, CliProposal } from '../../cli-execution/cli-execution-types'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CliExecutionPort {
  isEnabled(): boolean
  getRepositoryId(): string | null
  prepare(input: PrepareCliExecutionInput): Promise<CliProposal>
}

export type CliExecutionResolver = (repositoryId: string) => Promise<CliExecutionPort | null> | CliExecutionPort | null

export class BuildXGrokCliBridge {
  private readonly smcService: SessionMemoryCentralService
  private readonly workspaceService: WorkspaceBindingService
  private readonly cliResolver: CliExecutionResolver

  constructor(
    smcService: SessionMemoryCentralService,
    workspaceService: WorkspaceBindingService,
    cliServiceOrResolver?: CliExecutionPort | CliExecutionResolver | null
  ) {
    this.smcService = smcService
    this.workspaceService = workspaceService
    if (typeof cliServiceOrResolver === 'function') {
      this.cliResolver = cliServiceOrResolver
    } else if (cliServiceOrResolver) {
      this.cliResolver = () => cliServiceOrResolver
    } else {
      this.cliResolver = () => null
    }
  }

  async prepareGrokBuildProposal(
    repositoryId: string,
    sessionId: string,
    attemptId: string
  ): Promise<GrokCliPreAdmissionResult> {
    // 1. Parameter validation
    let validRepoId: string
    try {
      validRepoId = validateRepositoryId(repositoryId)
    } catch {
      return {
        status: 'ATTEMPT_INVALID',
        reason: 'INVALID_REPOSITORY_ID',
        attemptId: attemptId ?? '',
        sessionId: sessionId ?? '',
        repositoryId: repositoryId ?? '',
      }
    }

    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      return {
        status: 'ATTEMPT_INVALID',
        reason: 'INVALID_SESSION_ID',
        attemptId: attemptId ?? '',
        sessionId: sessionId ?? '',
        repositoryId: validRepoId,
      }
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof attemptId !== 'string' || !attemptId.trim() || !UUID_REGEX.test(attemptId.trim())) {
      return {
        status: 'ATTEMPT_INVALID',
        reason: 'INVALID_ATTEMPT_ID',
        attemptId: attemptId ?? '',
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }
    const cleanAttemptId = attemptId.trim().toLowerCase()

    // 2. Resolve and validate CliExecutionService
    let cliService: CliExecutionPort | null = null
    try {
      cliService = await this.cliResolver(validRepoId)
    } catch {
      cliService = null
    }

    if (!cliService) {
      return {
        status: 'CLI_NOT_AVAILABLE',
        reason: 'CLI_EXECUTION_SERVICE_NOT_AVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (!cliService.isEnabled()) {
      return {
        status: 'CLI_DISABLED',
        reason: 'CLI_EXECUTION_DISABLED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    let cliRepoId: string | null = null
    try {
      cliRepoId = typeof cliService.getRepositoryId === 'function' ? cliService.getRepositoryId() : null
    } catch {
      return {
        status: 'CLI_NOT_AVAILABLE',
        reason: 'CLI_SERVICE_REPOSITORY_CHECK_FAILED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (typeof cliRepoId !== 'string' || !cliRepoId.trim() || cliRepoId !== validRepoId) {
      return {
        status: 'PROJECT_CONTEXT_CHANGED',
        reason: 'CLI_SERVICE_REPOSITORY_MISMATCH',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    // 3. SMC Precondition checks (fail-closed, read-only)
    const store = this.smcService.getStore(validRepoId)

    const session = store.getSession(cleanSessionId)
    if (!session || session.status !== 'OPEN') {
      return {
        status: 'ATTEMPT_INVALID',
        reason: !session ? 'SESSION_NOT_FOUND' : 'SESSION_NOT_OPEN',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    const attempt = store.getExecutionAttempt(cleanAttemptId)
    if (!attempt) {
      return {
        status: 'ATTEMPT_INVALID',
        reason: 'ATTEMPT_NOT_FOUND',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (attempt.sessionId !== cleanSessionId) {
      return {
        status: 'ATTEMPT_INVALID',
        reason: 'ATTEMPT_SESSION_MISMATCH',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (attempt.status !== 'PREPARED') {
      return {
        status: 'ATTEMPT_INVALID',
        reason: 'ATTEMPT_NOT_PREPARED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    const reservation = store.getReservation(attempt.reservationId)
    if (!reservation || reservation.status !== 'ACTIVE') {
      return {
        status: 'ATTEMPT_INVALID',
        reason: !reservation ? 'RESERVATION_NOT_FOUND' : 'RESERVATION_NOT_ACTIVE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (reservation.sessionId !== cleanSessionId) {
      return {
        status: 'ATTEMPT_INVALID',
        reason: 'RESERVATION_SESSION_MISMATCH',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    const plan = store.getPlan(attempt.planId)
    if (!plan || plan.status !== 'ACTIVE') {
      return {
        status: 'ATTEMPT_INVALID',
        reason: !plan ? 'PLAN_NOT_FOUND' : 'PLAN_NOT_ACTIVE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    const unitState = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
    if (!unitState) {
      return {
        status: 'ATTEMPT_INVALID',
        reason: 'UNIT_STATE_NOT_FOUND',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (unitState.status !== 'RESERVED') {
      return {
        status: 'ATTEMPT_INVALID',
        reason: 'UNIT_NOT_RESERVED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (unitState.revision !== reservation.unitStateRevision) {
      return {
        status: 'ATTEMPT_INVALID',
        reason: 'UNIT_REVISION_MISMATCH',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (
      attempt.worktreeId !== reservation.worktreeId ||
      attempt.generation !== reservation.generation ||
      attempt.branch !== reservation.branch
    ) {
      return {
        status: 'ATTEMPT_INVALID',
        reason: 'ATTEMPT_WORKTREE_MISMATCH',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    // 4. Pre-observation of Bound Workspace
    let workspaceResult
    try {
      workspaceResult = await this.workspaceService.inspectBoundWorkspace(validRepoId, cleanSessionId)
    } catch {
      return {
        status: 'WORKSPACE_INVALID',
        reason: 'WORKSPACE_INSPECTION_FAILED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (workspaceResult.status !== 'CURRENT') {
      const reason =
        workspaceResult.status === 'UNBOUND'
          ? 'WORKSPACE_UNBOUND'
          : 'reason' in workspaceResult
            ? workspaceResult.reason
            : 'WORKSPACE_NOT_CURRENT'
      return {
        status: 'WORKSPACE_INVALID',
        reason,
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (!workspaceResult.currentHead || typeof workspaceResult.currentHead !== 'string' || !workspaceResult.currentHead.trim()) {
      return {
        status: 'WORKSPACE_INVALID',
        reason: 'HEAD_UNAVAILABLE',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (
      workspaceResult.binding.worktreeId !== attempt.worktreeId ||
      workspaceResult.binding.generation !== attempt.generation ||
      workspaceResult.binding.branch !== attempt.branch
    ) {
      return {
        status: 'WORKSPACE_INVALID',
        reason: 'WORKTREE_IDENTITY_DRIFT',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    // 5. Prepare proposal via CliExecutionService
    let proposal: CliProposal
    try {
      proposal = await cliService.prepare({
        worktree: {
          worktreeId: attempt.worktreeId,
          generation: attempt.generation,
        },
        executable: 'grok',
        args: ['version'],
      })
    } catch (err: any) {
      const errMsg = err?.message ?? String(err)
      const errCode = err?.code
      if (
        errMsg.includes('EXECUTABLE_NOT_FOUND') ||
        errMsg.includes('Could not resolve executable') ||
        errCode === 'EXECUTABLE_NOT_FOUND'
      ) {
        return {
          status: 'CLI_INSTALLATION_UNVERIFIED',
          reason: 'EXECUTABLE_NOT_FOUND',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
        }
      }
      if (
        errMsg.includes('WORKTREE_NOT_FOUND') ||
        errMsg.includes('worktree') ||
        errMsg.includes('DIRECTORY_NOT_FOUND')
      ) {
        return {
          status: 'WORKSPACE_INVALID',
          reason: 'WORKTREE_NOT_FOUND',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
        }
      }
      return {
        status: 'CLI_INSTALLATION_UNVERIFIED',
        reason: 'CLI_PREPARATION_FAILED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    // 6. Strict validation of returned proposal
    if (!proposal || typeof proposal.proposalId !== 'string' || !proposal.proposalId.trim()) {
      return {
        status: 'CLI_INSTALLATION_UNVERIFIED',
        reason: 'PROPOSAL_ID_MISSING',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (proposal.repositoryId !== validRepoId) {
      return {
        status: 'PROJECT_CONTEXT_CHANGED',
        reason: 'PROPOSAL_REPOSITORY_MISMATCH',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (!proposal.worktree) {
      return {
        status: 'WORKSPACE_INVALID',
        reason: 'PROPOSAL_WORKTREE_MISSING',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (
      proposal.worktree.worktreeId !== attempt.worktreeId ||
      proposal.worktree.generation !== attempt.generation
    ) {
      return {
        status: 'WORKSPACE_INVALID',
        reason: 'PROPOSAL_WORKTREE_MISMATCH',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (proposal.worktree.branch !== attempt.branch) {
      return {
        status: 'WORKSPACE_INVALID',
        reason: 'PROPOSAL_BRANCH_MISMATCH',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (proposal.worktree.head !== workspaceResult.currentHead) {
      return {
        status: 'WORKSPACE_INVALID',
        reason: 'PROPOSAL_HEAD_MISMATCH',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    // Validate command consistency with literal probe `grok version`
    if (!proposal.command || proposal.command.executable !== 'grok') {
      return {
        status: 'CLI_INSTALLATION_UNVERIFIED',
        reason: 'PROPOSAL_COMMAND_MISMATCH',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (!Array.isArray(proposal.command.args) || proposal.command.args.length !== 1 || proposal.command.args[0] !== 'version') {
      return {
        status: 'CLI_INSTALLATION_UNVERIFIED',
        reason: 'PROPOSAL_ARGS_MISMATCH',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    // Validate policy is SUPERVISED and not auto-authorized
    if (!proposal.policy || proposal.policy.mode !== 'SUPERVISED') {
      return {
        status: 'CLI_DISABLED',
        reason: 'PROPOSAL_POLICY_UNSUPERVISED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (proposal.autoAuthorized === true) {
      return {
        status: 'CLI_DISABLED',
        reason: 'PROPOSAL_AUTO_AUTHORIZATION_DISALLOWED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    // 7. Post-await revalidation (fail-closed against concurrent mutations / drift during preparation)
    if (!cliService.isEnabled()) {
      return {
        status: 'CLI_DISABLED',
        reason: 'CLI_EXECUTION_DISABLED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    try {
      if (cliService.getRepositoryId() !== validRepoId) {
        return {
          status: 'PROJECT_CONTEXT_CHANGED',
          reason: 'CLI_SERVICE_REPOSITORY_MISMATCH',
          attemptId: cleanAttemptId,
          sessionId: cleanSessionId,
          repositoryId: validRepoId,
        }
      }
    } catch {
      return {
        status: 'CLI_NOT_AVAILABLE',
        reason: 'CLI_SERVICE_REPOSITORY_CHECK_FAILED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    const postSession = store.getSession(cleanSessionId)
    if (!postSession || postSession.status !== 'OPEN' || postSession.revision !== session.revision) {
      return {
        status: 'ATTEMPT_INVALID',
        reason: !postSession ? 'SESSION_NOT_FOUND' : 'SESSION_STATE_CHANGED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    const postAttempt = store.getExecutionAttempt(cleanAttemptId)
    if (!postAttempt || postAttempt.status !== 'PREPARED' || postAttempt.revision !== attempt.revision) {
      return {
        status: 'ATTEMPT_INVALID',
        reason: !postAttempt ? 'ATTEMPT_NOT_FOUND' : 'ATTEMPT_STATE_CHANGED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    const postReservation = store.getReservation(attempt.reservationId)
    if (!postReservation || postReservation.status !== 'ACTIVE' || postReservation.updatedAt !== reservation.updatedAt) {
      return {
        status: 'ATTEMPT_INVALID',
        reason: !postReservation ? 'RESERVATION_NOT_FOUND' : 'RESERVATION_STATE_CHANGED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    const postPlan = store.getPlan(attempt.planId)
    if (!postPlan || postPlan.status !== 'ACTIVE' || postPlan.revision !== plan.revision) {
      return {
        status: 'ATTEMPT_INVALID',
        reason: !postPlan ? 'PLAN_NOT_FOUND' : 'PLAN_STATE_CHANGED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    const postUnitState = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
    if (!postUnitState || postUnitState.status !== 'RESERVED' || postUnitState.revision !== unitState.revision) {
      return {
        status: 'ATTEMPT_INVALID',
        reason: !postUnitState ? 'UNIT_STATE_NOT_FOUND' : 'UNIT_STATE_CHANGED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    let postWorkspaceResult
    try {
      postWorkspaceResult = await this.workspaceService.inspectBoundWorkspace(validRepoId, cleanSessionId)
    } catch {
      return {
        status: 'WORKSPACE_INVALID',
        reason: 'WORKSPACE_INSPECTION_FAILED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (postWorkspaceResult.status !== 'CURRENT') {
      const reason =
        postWorkspaceResult.status === 'UNBOUND'
          ? 'WORKSPACE_UNBOUND'
          : 'reason' in postWorkspaceResult
            ? postWorkspaceResult.reason
            : 'WORKSPACE_NOT_CURRENT'
      return {
        status: 'WORKSPACE_INVALID',
        reason,
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (
      postWorkspaceResult.binding.worktreeId !== attempt.worktreeId ||
      postWorkspaceResult.binding.generation !== attempt.generation ||
      postWorkspaceResult.binding.branch !== attempt.branch
    ) {
      return {
        status: 'WORKSPACE_INVALID',
        reason: 'WORKTREE_IDENTITY_DRIFT',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (postWorkspaceResult.currentHead !== workspaceResult.currentHead) {
      return {
        status: 'WORKSPACE_INVALID',
        reason: 'HEAD_DIVERGED_DURING_PREPARATION',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    return {
      status: 'PROPOSAL_PREPARED',
      proposalId: proposal.proposalId,
      attemptId: cleanAttemptId,
      sessionId: cleanSessionId,
      repositoryId: validRepoId,
      worktree: {
        worktreeId: attempt.worktreeId,
        generation: attempt.generation,
        branch: attempt.branch,
        head: postWorkspaceResult.currentHead,
      },
      executable: 'grok',
      args: ['version'],
    }
  }
}
