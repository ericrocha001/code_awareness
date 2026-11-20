import { authenticatedSessionWitness, deliveryContextRequest, type DeliveryAnchor, type DeliveryContextRequest } from '../../shared/types/delivery-context-types'
import { authorizeArtifactAgent } from '../continuum/agent-authority'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import { operation, type LocalChannelAdapter, type LocalRequestContext } from '../local-agent-channel/local-channel-types'
import type { GitHubIntegrationService } from './github-integration-service'
import { validateCreatePullRequest, type PullRequestExecutionContext } from './github-pull-requests'
import { validateOperationId } from './github-pr-integration'

export interface GitHubLocalSessionState {
  repositoryId: string
  repositoryPath: string
  integration: GitHubIntegrationService
  gitOperations?: GitOperationsService
  isCurrent: () => boolean
}

const object = (value: unknown, allowed: string[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARGUMENT')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !allowed.includes(key))) throw new Error('INVALID_ARGUMENT')
  return record
}

const text = (value: unknown, max = 512) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error('INVALID_ARGUMENT')
  return value
}

export class GitHubLocalAdapter implements LocalChannelAdapter {
  readonly domain = 'github'
  readonly operations: LocalChannelAdapter['operations']

  constructor(
    private readonly getState: () => GitHubLocalSessionState | null,
    private readonly continuum: RepositoryContinuumSession
  ) {
    const requireState = async (input: Record<string, unknown>, context: LocalRequestContext) => {
      const state = this.getState()
      if (!state || !state.isCurrent() || !context.connected()) throw new Error('NO_ACTIVE_REPOSITORY')
      if (input.repositoryId !== state.repositoryId) throw new Error('REPOSITORY_MISMATCH')
      const worktreeId = text(input.worktreeId, 64)
      if (!/^[a-f0-9]{64}$/.test(worktreeId) || !state.gitOperations?.worktrees) throw new Error('WORKTREE_UNLINKED')
      await state.gitOperations.worktrees.discover()
      await state.gitOperations.worktrees.revalidateSelection(worktreeId).catch(() => { throw new Error('WORKTREE_UNLINKED') })
      if (!state.isCurrent() || !context.connected()) throw new Error('PROJECT_CONTEXT_CHANGED')
      return { state, worktreeId }
    }

    const common = ['repositoryId', 'worktreeId']
    this.operations = {
      pr_access: operation(input => object(input, common), async (request, context) => {
        const { state } = await requireState(request, context)
        return state.integration.getPullRequestAccess(state.repositoryPath)
      }),
      pr_status: operation(input => object(input, [...common, 'operationId']), async (request, context) => {
        const { state } = await requireState(request, context)
        validateOperationId(request.operationId)
        return state.integration.getPullRequestOperation(state.repositoryPath, String(request.operationId))
      }),
      create_pr: operation(
        input => object(input, [...common, 'headBranch', 'baseBranch', 'expectedHeadSha', 'title', 'body', 'operationId', 'deliveryContext', 'sessionWitness']),
        async (request, context) => {
          const { state, worktreeId } = await requireState(request, context)
          const { repositoryId: _repo, deliveryContext: rawDelivery, sessionWitness: rawWitness, ...prFields } = request
          let deliveryContextError: string | undefined
          let deliveryContext: DeliveryContextRequest | undefined
          if (rawDelivery !== undefined) {
            const parsed = deliveryContextRequest.safeParse(rawDelivery)
            if (!parsed.success) deliveryContextError = 'DELIVERY_CONTEXT_MALFORMED'
            else deliveryContext = parsed.data
          }
          let sessionWitness: import('../../shared/types/delivery-context-types').AuthenticatedSessionWitness | undefined
          if (rawWitness !== undefined) {
            const parsed = authenticatedSessionWitness.safeParse(rawWitness)
            if (!parsed.success) deliveryContextError ??= 'SESSION_WITNESS_INVALID'
            else sessionWitness = parsed.data
          }
          const prInput = {
            ...prFields,
            worktreeId,
            ...(deliveryContext ? { deliveryContext } : {})
          } as Parameters<GitHubIntegrationService['createPullRequest']>[1]
          validateCreatePullRequest(prInput)

          const activeContinuum = this.continuum.getActiveService()
          const authority = context.principal
            ? authorizeArtifactAgent(
              context.principal,
              state.repositoryId,
              () => state.isCurrent() && context.connected(),
              worktreeId,
              deliveryContext || deliveryContextError || sessionWitness
                ? { ...(deliveryContext ? { deliveryContext } : {}), ...(deliveryContextError ? { deliveryContextError } : {}), ...(sessionWitness ? { sessionWitness } : {}) }
                : undefined
            )
            : undefined

          const resolveScoped = async (explicit?: DeliveryContextRequest, targetWorktreeId?: string, optional = false): Promise<DeliveryAnchor | undefined> => {
            if (!activeContinuum || this.continuum.getActiveSession()?.repositoryId !== state.repositoryId || !state.gitOperations) {
              if (!optional || explicit) throw new Error('DELIVERY_CONTEXT_INVALID')
              return undefined
            }
            const scopedId = targetWorktreeId ?? worktreeId
            const observe = () => state.gitOperations!.deliverySnapshot(scopedId)
            if (activeContinuum.resolveExecutionContext) {
              const resolved = await activeContinuum.resolveExecutionContext(authority, explicit, observe, { worktreeId: scopedId })
              if (!resolved.anchor && !optional) throw new Error('DELIVERY_CONTEXT_MISSING')
              return resolved.anchor
            }
            if (!explicit) {
              if (optional) return undefined
              throw new Error('DELIVERY_CONTEXT_INVALID')
            }
            return activeContinuum.prepareDeliveryContext(authority, explicit, observe, { worktreeId: scopedId })
          }

          const execution: PullRequestExecutionContext = {
            prepareDelivery: async (req, targetWorktreeId) => (await resolveScoped(req, targetWorktreeId, false))!,
            resolveDelivery: (req, targetWorktreeId) => resolveScoped(req, targetWorktreeId, true),
            defaultDeliveryContext: deliveryContext,
            deliveryContextError,
            defaultWorktreeId: worktreeId,
            isActive: () => state.isCurrent() && context.connected(),
            inspectWorktree: id => state.gitOperations!.inspectWorktree(id)
          }
          return state.integration.createPullRequest(state.repositoryPath, prInput, execution)
        }
      )
    }
  }
}
