import type {
  GrokCliPreAdmissionResult,
  GrokProbeStatus,
  GrokQualifications,
  GrokProbeDiagnosisResult
} from '../../../shared/types/buildx/execution-types'
import { validateRepositoryId } from '../smc/session-memory-central-paths'
import type { SessionMemoryCentralService } from '../smc/session-memory-central-service'
import type { WorkspaceBindingService } from './workspace-binding-service'
import type { CliPolicy } from '../../../shared/types/cli-policy-types'
import type {
  PrepareCliExecutionInput,
  CliProposal,
  CliCommandDescriptor,
  CliWorktreeSelector,
  StartCliExecutionInput,
  GetCliExecutionInput,
  CancelCliExecutionInput,
  CliExecutionSnapshot
} from '../../cli-execution/cli-execution-types'
import { resolveCliCommand } from '../../cli-execution/cli-command-resolver'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CliExecutionPort {
  isEnabled(): boolean
  getRepositoryId(): string | null
  getPolicyForWorktree?(selector?: CliWorktreeSelector): Promise<CliPolicy> | CliPolicy
  prepare(input: PrepareCliExecutionInput): Promise<CliProposal>
  start?(input: StartCliExecutionInput): CliExecutionSnapshot | Promise<CliExecutionSnapshot>
  get?(input: GetCliExecutionInput): CliExecutionSnapshot | Promise<CliExecutionSnapshot>
  cancel?(input: CancelCliExecutionInput): CliExecutionSnapshot | Promise<CliExecutionSnapshot>
}

export function extractGrokVersion(stdout: string): string | null {
  if (!stdout || typeof stdout !== 'string') return null
  const trimmed = stdout.trim()
  const lines = trimmed.split(/\r?\n/)
  for (const line of lines) {
    const cleanLine = line.trim()
    const match =
      cleanLine.match(/^(?:@xai\/)?grok(?:[/\s]+(?:version|build)?)?[\s/]+v?([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[0-9A-Za-z.-]+)?)\b/i) ||
      cleanLine.match(/^version[\s/]+v?([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[0-9A-Za-z.-]+)?)\b/i) ||
      cleanLine.match(/^v?([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[0-9A-Za-z.-]+)?)$/)
    if (match && match[1]) {
      return match[1]
    }
  }
  return null
}

export function createDefaultQualifications(installed: boolean = false): GrokQualifications {
  return {
    installedVersion: installed ? 'VERIFIED' : 'UNVERIFIED',
    authentication: 'UNVERIFIED',
    modelAccess: 'UNVERIFIED',
    quota: 'UNVERIFIED',
    headlessPrompt: 'UNVERIFIED',
    fileEditing: 'UNVERIFIED',
    agentPermissions: 'UNVERIFIED',
    promptFileCompatibility: 'UNVERIFIED'
  }
}

export type CliExecutionResolver = (repositoryId: string) => Promise<CliExecutionPort | null> | CliExecutionPort | null

export type CliCommandResolverFn = (
  repoRoot: string,
  rawExecutable: string,
  rawArgs?: string[],
  rawRelativeCwd?: string
) => CliCommandDescriptor

export class BuildXGrokCliBridge {
  private readonly smcService: SessionMemoryCentralService
  private readonly workspaceService: WorkspaceBindingService
  private readonly cliResolver: CliExecutionResolver
  private readonly commandResolver: CliCommandResolverFn

  constructor(
    smcService: SessionMemoryCentralService,
    workspaceService: WorkspaceBindingService,
    cliServiceOrResolver?: CliExecutionPort | CliExecutionResolver | null,
    commandResolver?: CliCommandResolverFn
  ) {
    this.smcService = smcService
    this.workspaceService = workspaceService
    this.commandResolver = commandResolver ?? resolveCliCommand
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

    // Validate command presence
    if (!proposal.command) {
      return {
        status: 'CLI_INSTALLATION_UNVERIFIED',
        reason: 'PROPOSAL_COMMAND_MISSING',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    // 1. Validate literal intention: originalExecutable === 'grok' and originalArgs === ['version']
    if (proposal.command.originalExecutable !== 'grok') {
      return {
        status: 'CLI_INSTALLATION_UNVERIFIED',
        reason: 'PROPOSAL_COMMAND_MISMATCH',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (
      !Array.isArray(proposal.command.originalArgs) ||
      proposal.command.originalArgs.length !== 1 ||
      proposal.command.originalArgs[0] !== 'version'
    ) {
      return {
        status: 'CLI_INSTALLATION_UNVERIFIED',
        reason: 'PROPOSAL_ARGS_MISMATCH',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    // Validate policy is SUPERVISED (without auto-authorization) or verified repository YOLO Worktree grant
    const yoloWorktreeAuthorized =
      proposal.policy?.mode === 'AUTONOMOUS_TRUSTED' &&
      proposal.policy?.scope === 'REPOSITORY_WORKTREES'

    if (!proposal.policy || (proposal.policy.mode !== 'SUPERVISED' && !yoloWorktreeAuthorized)) {
      return {
        status: 'CLI_DISABLED',
        reason: 'PROPOSAL_POLICY_UNSUPERVISED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (proposal.policy.mode === 'SUPERVISED' && proposal.autoAuthorized === true) {
      return {
        status: 'CLI_DISABLED',
        reason: 'PROPOSAL_AUTO_AUTHORIZATION_DISALLOWED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    // 2. Validate absence of arbitrary subdirectory: CWD must be the root of the selected worktree
    if (proposal.command.relativeCwd !== '.' && proposal.command.relativeCwd !== '') {
      return {
        status: 'WORKSPACE_INVALID',
        reason: 'PROPOSAL_CWD_NOT_ROOT',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    // 3. Verify integrity of the effective descriptor against authoritative resolveCliCommand
    let expectedDescriptor: CliCommandDescriptor
    try {
      expectedDescriptor = this.commandResolver(proposal.command.cwd, 'grok', ['version'])
    } catch {
      return {
        status: 'CLI_INSTALLATION_UNVERIFIED',
        reason: 'CLI_COMMAND_RESOLUTION_FAILED',
        attemptId: cleanAttemptId,
        sessionId: cleanSessionId,
        repositoryId: validRepoId,
      }
    }

    if (
      proposal.command.originalExecutable !== expectedDescriptor.originalExecutable ||
      !Array.isArray(proposal.command.originalArgs) ||
      proposal.command.originalArgs.length !== (expectedDescriptor.originalArgs?.length ?? 0) ||
      !proposal.command.originalArgs.every((arg, idx) => arg === expectedDescriptor.originalArgs?.[idx]) ||
      proposal.command.executable !== expectedDescriptor.executable ||
      proposal.command.cwd !== expectedDescriptor.cwd ||
      proposal.command.relativeCwd !== expectedDescriptor.relativeCwd ||
      proposal.command.windowsCommandLine !== expectedDescriptor.windowsCommandLine ||
      !Array.isArray(proposal.command.args) ||
      proposal.command.args.length !== expectedDescriptor.args.length ||
      !proposal.command.args.every((arg, idx) => arg === expectedDescriptor.args[idx])
    ) {
      return {
        status: 'CLI_INSTALLATION_UNVERIFIED',
        reason: 'PROPOSAL_DESCRIPTOR_MISMATCH',
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

  async diagnoseGrokBuildInstallation(
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    probeOperationId: string,
    options?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<GrokProbeDiagnosisResult> {
    let validRepoId: string
    try {
      validRepoId = validateRepositoryId(repositoryId)
    } catch {
      return {
        status: 'NOT_STARTED',
        probeOperationId: probeOperationId ?? '',
        repositoryId: repositoryId ?? '',
        sessionId: sessionId ?? '',
        attemptId: attemptId ?? '',
        reason: 'INVALID_REPOSITORY_ID',
        qualifications: createDefaultQualifications(false)
      }
    }

    if (typeof sessionId !== 'string' || !sessionId.trim() || !UUID_REGEX.test(sessionId.trim())) {
      return {
        status: 'NOT_STARTED',
        probeOperationId: probeOperationId ?? '',
        repositoryId: validRepoId,
        sessionId: sessionId ?? '',
        attemptId: attemptId ?? '',
        reason: 'INVALID_SESSION_ID',
        qualifications: createDefaultQualifications(false)
      }
    }
    const cleanSessionId = sessionId.trim().toLowerCase()

    if (typeof attemptId !== 'string' || !attemptId.trim() || !UUID_REGEX.test(attemptId.trim())) {
      return {
        status: 'NOT_STARTED',
        probeOperationId: probeOperationId ?? '',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: attemptId ?? '',
        reason: 'INVALID_ATTEMPT_ID',
        qualifications: createDefaultQualifications(false)
      }
    }
    const cleanAttemptId = attemptId.trim().toLowerCase()

    if (typeof probeOperationId !== 'string' || !probeOperationId.trim() || probeOperationId.trim().length > 128) {
      return {
        status: 'NOT_STARTED',
        probeOperationId: probeOperationId ?? '',
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'INVALID_OPERATION_ID',
        qualifications: createDefaultQualifications(false)
      }
    }
    const cleanOperationId = probeOperationId.trim()

    let cliService: CliExecutionPort | null = null
    try {
      cliService = await this.cliResolver(validRepoId)
    } catch {
      cliService = null
    }

    if (!cliService) {
      return {
        status: 'UNAVAILABLE',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'CLI_EXECUTION_SERVICE_NOT_AVAILABLE',
        qualifications: createDefaultQualifications(false)
      }
    }

    if (!cliService.isEnabled()) {
      return {
        status: 'UNAVAILABLE',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'CLI_EXECUTION_DISABLED',
        qualifications: createDefaultQualifications(false)
      }
    }

    let cliRepoId: string | null = null
    try {
      cliRepoId = typeof cliService.getRepositoryId === 'function' ? cliService.getRepositoryId() : null
    } catch {
      cliRepoId = null
    }

    if (cliRepoId !== validRepoId) {
      return {
        status: 'UNAVAILABLE',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'CLI_SERVICE_REPOSITORY_MISMATCH',
        qualifications: createDefaultQualifications(false)
      }
    }

    if (typeof cliService.start !== 'function' || typeof cliService.get !== 'function') {
      return {
        status: 'UNAVAILABLE',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'CLI_PORT_EXECUTION_UNSUPPORTED',
        qualifications: createDefaultQualifications(false)
      }
    }

    let existingSnapshot: CliExecutionSnapshot | null = null
    try {
      existingSnapshot = await cliService.get({ operationId: cleanOperationId })
    } catch {
      existingSnapshot = null
    }

    if (existingSnapshot) {
      return this.mapSnapshotToDiagnosis(cleanOperationId, validRepoId, cleanSessionId, cleanAttemptId, existingSnapshot)
    }

    const prepareResult = await this.prepareGrokBuildProposal(validRepoId, cleanSessionId, cleanAttemptId)
    if (prepareResult.status !== 'PROPOSAL_PREPARED') {
      const isUnavailable = ['CLI_NOT_AVAILABLE', 'CLI_DISABLED', 'CLI_INSTALLATION_UNVERIFIED'].includes(prepareResult.status)
      return {
        status: isUnavailable ? 'UNAVAILABLE' : 'NOT_STARTED',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: prepareResult.reason,
        qualifications: createDefaultQualifications(false)
      }
    }

    const store = this.smcService.getStore(validRepoId)
    const session = store.getSession(cleanSessionId)
    if (!session || session.status !== 'OPEN') {
      return {
        status: 'NOT_STARTED',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: !session ? 'SESSION_NOT_FOUND' : 'SESSION_NOT_OPEN',
        qualifications: createDefaultQualifications(false)
      }
    }

    const attempt = store.getExecutionAttempt(cleanAttemptId)
    if (!attempt || attempt.status !== 'PREPARED') {
      return {
        status: 'NOT_STARTED',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: !attempt ? 'ATTEMPT_NOT_FOUND' : 'ATTEMPT_NOT_PREPARED',
        qualifications: createDefaultQualifications(false)
      }
    }

    const reservation = store.getReservation(attempt.reservationId)
    if (!reservation || reservation.status !== 'ACTIVE') {
      return {
        status: 'NOT_STARTED',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: !reservation ? 'RESERVATION_NOT_FOUND' : 'RESERVATION_NOT_ACTIVE',
        qualifications: createDefaultQualifications(false)
      }
    }

    const plan = store.getPlan(attempt.planId)
    if (!plan || plan.status !== 'ACTIVE') {
      return {
        status: 'NOT_STARTED',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: !plan ? 'PLAN_NOT_FOUND' : 'PLAN_NOT_ACTIVE',
        qualifications: createDefaultQualifications(false)
      }
    }

    const unitState = store.getUnitState(cleanSessionId, attempt.planId, attempt.unitId)
    if (!unitState || unitState.status !== 'RESERVED' || unitState.revision !== reservation.unitStateRevision) {
      return {
        status: 'NOT_STARTED',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: !unitState ? 'UNIT_STATE_NOT_FOUND' : unitState.status !== 'RESERVED' ? 'UNIT_NOT_RESERVED' : 'UNIT_REVISION_MISMATCH',
        qualifications: createDefaultQualifications(false)
      }
    }

    let wsCheck
    try {
      wsCheck = await this.workspaceService.inspectBoundWorkspace(validRepoId, cleanSessionId)
    } catch {
      return {
        status: 'NOT_STARTED',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'WORKSPACE_INSPECTION_FAILED',
        qualifications: createDefaultQualifications(false)
      }
    }

    if (wsCheck.status !== 'CURRENT') {
      return {
        status: 'NOT_STARTED',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: wsCheck.status === 'UNBOUND' ? 'WORKSPACE_UNBOUND' : ('reason' in wsCheck ? wsCheck.reason : 'WORKSPACE_NOT_CURRENT'),
        qualifications: createDefaultQualifications(false)
      }
    }

    if (
      wsCheck.binding.worktreeId !== prepareResult.worktree.worktreeId ||
      wsCheck.binding.generation !== prepareResult.worktree.generation ||
      wsCheck.binding.branch !== prepareResult.worktree.branch ||
      wsCheck.currentHead !== prepareResult.worktree.head
    ) {
      return {
        status: 'NOT_STARTED',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'WORKTREE_IDENTITY_DRIFT',
        qualifications: createDefaultQualifications(false)
      }
    }

    let initialSnapshot: CliExecutionSnapshot
    try {
      initialSnapshot = await cliService.start({
        proposalId: prepareResult.proposalId,
        operationId: cleanOperationId
      })
    } catch (err: any) {
      const errMsg = err?.message ?? String(err)
      if (errMsg.includes('CLI_EXECUTION_BUSY')) {
        return {
          status: 'UNAVAILABLE',
          probeOperationId: cleanOperationId,
          repositoryId: validRepoId,
          sessionId: cleanSessionId,
          attemptId: cleanAttemptId,
          reason: 'CLI_EXECUTION_BUSY',
          qualifications: createDefaultQualifications(false)
        }
      }
      if (errMsg.includes('NOT_AUTO_AUTHORIZED') || errMsg.includes('REFUSED')) {
        return {
          status: 'REFUSED',
          probeOperationId: cleanOperationId,
          repositoryId: validRepoId,
          sessionId: cleanSessionId,
          attemptId: cleanAttemptId,
          reason: errMsg,
          qualifications: createDefaultQualifications(false)
        }
      }
      return {
        status: 'NOT_STARTED',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: errMsg,
        qualifications: createDefaultQualifications(false)
      }
    }

    const timeout = options?.timeoutMs ?? 5000
    const interval = options?.pollIntervalMs ?? 50
    const deadline = Date.now() + timeout

    let currentSnapshot = initialSnapshot
    while (Date.now() < deadline) {
      if (
        currentSnapshot.phase === 'TERMINAL' ||
        currentSnapshot.phase === 'TERMINATION_UNCONFIRMED' ||
        currentSnapshot.status === 'REFUSED'
      ) {
        break
      }
      await new Promise(r => setTimeout(r, interval))
      try {
        currentSnapshot = await cliService.get({ operationId: cleanOperationId })
      } catch {
        break
      }
    }

    return this.mapSnapshotToDiagnosis(cleanOperationId, validRepoId, cleanSessionId, cleanAttemptId, currentSnapshot)
  }

  async getGrokBuildDiagnosis(
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    probeOperationId: string
  ): Promise<GrokProbeDiagnosisResult> {
    let validRepoId: string
    try {
      validRepoId = validateRepositoryId(repositoryId)
    } catch {
      return {
        status: 'NOT_STARTED',
        probeOperationId: probeOperationId ?? '',
        repositoryId: repositoryId ?? '',
        sessionId: sessionId ?? '',
        attemptId: attemptId ?? '',
        reason: 'INVALID_REPOSITORY_ID',
        qualifications: createDefaultQualifications(false)
      }
    }

    const cleanSessionId = typeof sessionId === 'string' ? sessionId.trim().toLowerCase() : ''
    const cleanAttemptId = typeof attemptId === 'string' ? attemptId.trim().toLowerCase() : ''
    const cleanOperationId = typeof probeOperationId === 'string' ? probeOperationId.trim() : ''

    const cliService = await this.cliResolver(validRepoId)
    if (!cliService || typeof cliService.get !== 'function') {
      return {
        status: 'UNAVAILABLE',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'CLI_EXECUTION_SERVICE_NOT_AVAILABLE',
        qualifications: createDefaultQualifications(false)
      }
    }

    try {
      const snapshot = await cliService.get({ operationId: cleanOperationId })
      return this.mapSnapshotToDiagnosis(cleanOperationId, validRepoId, cleanSessionId, cleanAttemptId, snapshot)
    } catch {
      return {
        status: 'UNKNOWN',
        probeOperationId: cleanOperationId,
        repositoryId: validRepoId,
        sessionId: cleanSessionId,
        attemptId: cleanAttemptId,
        reason: 'OPERATION_NOT_FOUND',
        qualifications: createDefaultQualifications(false)
      }
    }
  }

  private mapSnapshotToDiagnosis(
    probeOperationId: string,
    repositoryId: string,
    sessionId: string,
    attemptId: string,
    snapshot: CliExecutionSnapshot
  ): GrokProbeDiagnosisResult {
    if (snapshot.phase === 'TERMINATION_UNCONFIRMED') {
      return {
        status: 'FAILED',
        probeOperationId,
        repositoryId,
        sessionId,
        attemptId,
        phase: snapshot.phase,
        exitCode: snapshot.exitCode ?? null,
        reason: 'TERMINATION_UNCONFIRMED',
        qualifications: createDefaultQualifications(false)
      }
    }

    if (snapshot.status === 'AWAITING_APPROVAL') {
      return {
        status: 'AWAITING_APPROVAL',
        probeOperationId,
        repositoryId,
        sessionId,
        attemptId,
        phase: snapshot.phase,
        qualifications: createDefaultQualifications(false)
      }
    }

    if (snapshot.status === 'RUNNING' || snapshot.phase === 'LAUNCHING' || snapshot.phase === 'RUNNING') {
      return {
        status: 'RUNNING',
        probeOperationId,
        repositoryId,
        sessionId,
        attemptId,
        phase: snapshot.phase,
        qualifications: createDefaultQualifications(false)
      }
    }

    if (snapshot.status === 'REFUSED' || snapshot.diagnostic === 'NATIVE_APPROVAL_REFUSED') {
      return {
        status: 'REFUSED',
        probeOperationId,
        repositoryId,
        sessionId,
        attemptId,
        phase: snapshot.phase,
        reason: snapshot.diagnostic ?? 'NATIVE_APPROVAL_REFUSED',
        qualifications: createDefaultQualifications(false)
      }
    }

    if (snapshot.status === 'CANCELLED' || snapshot.status === 'INTERRUPTED') {
      return {
        status: 'INTERRUPTED',
        probeOperationId,
        repositoryId,
        sessionId,
        attemptId,
        phase: snapshot.phase,
        reason: snapshot.diagnostic ?? 'INTERRUPTED',
        qualifications: createDefaultQualifications(false)
      }
    }

    if (snapshot.status === 'SUCCEEDED') {
      const cleanTree = snapshot.treeObservation?.activeProcesses === 0 && snapshot.treeObservation?.handlesClosed === true
      if (!cleanTree) {
        return {
          status: 'FAILED',
          probeOperationId,
          repositoryId,
          sessionId,
          attemptId,
          phase: snapshot.phase,
          exitCode: snapshot.exitCode ?? null,
          reason: 'TREE_TERMINATION_INVALID',
          qualifications: createDefaultQualifications(false)
        }
      }

      if (snapshot.exitCode !== 0) {
        return {
          status: 'FAILED',
          probeOperationId,
          repositoryId,
          sessionId,
          attemptId,
          phase: snapshot.phase,
          exitCode: snapshot.exitCode ?? null,
          reason: `NON_ZERO_EXIT_CODE_${snapshot.exitCode}`,
          qualifications: createDefaultQualifications(false)
        }
      }

      const version = extractGrokVersion(snapshot.stdout ?? '')
      if (!version) {
        return {
          status: 'FAILED',
          probeOperationId,
          repositoryId,
          sessionId,
          attemptId,
          phase: snapshot.phase,
          exitCode: snapshot.exitCode ?? 0,
          reason: 'VERSION_PARSING_FAILED',
          qualifications: createDefaultQualifications(false)
        }
      }

      return {
        status: 'INSTALLED_VERSION_OBSERVED',
        probeOperationId,
        repositoryId,
        sessionId,
        attemptId,
        phase: snapshot.phase,
        exitCode: 0,
        version,
        qualifications: createDefaultQualifications(true)
      }
    }

    if (snapshot.status === 'FAILED' || snapshot.status === 'TIMED_OUT') {
      return {
        status: 'FAILED',
        probeOperationId,
        repositoryId,
        sessionId,
        attemptId,
        phase: snapshot.phase,
        exitCode: snapshot.exitCode ?? null,
        reason: snapshot.diagnostic ?? snapshot.status,
        qualifications: createDefaultQualifications(false)
      }
    }

    return {
      status: 'UNKNOWN',
      probeOperationId,
      repositoryId,
      sessionId,
      attemptId,
      phase: snapshot.phase,
      reason: snapshot.diagnostic,
      qualifications: createDefaultQualifications(false)
    }
  }
}
