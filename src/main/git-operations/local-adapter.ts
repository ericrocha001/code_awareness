import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { authenticatedSessionWitness, deliveryContextRequest, type DeliveryAnchor } from '../../shared/types/delivery-context-types'
import { authorizeArtifactAgent } from '../continuum/agent-authority'
import type { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import { operation, type LocalChannelAdapter, type LocalRequestContext } from '../local-agent-channel/local-channel-types'
import { encodeGitReceiptResult } from './git-operation-receipts'
import { GitOperationsError, type GitOperationsService, type SyncRequest } from './git-operations-service'

export interface GitLocalSessionState {
  repositoryId: string
  repositoryPath: string
  service: GitOperationsService
  isCurrent: () => boolean
}

const samePath = (a: string, b: string) => {
  const left = resolve(realpathSync(a))
  const right = resolve(realpathSync(b))
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
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

export class GitLocalAdapter implements LocalChannelAdapter {
  readonly domain = 'git'
  readonly operations: LocalChannelAdapter['operations']

  constructor(
    private readonly getState: () => GitLocalSessionState | null,
    private readonly continuum: RepositoryContinuumSession
  ) {
    const requireState = (input: Record<string, unknown>, context: LocalRequestContext) => {
      const state = this.getState()
      if (!state || !state.isCurrent() || !context.connected()) throw new Error('NO_ACTIVE_REPOSITORY')
      if (input.repositoryId !== state.repositoryId) throw new Error('REPOSITORY_MISMATCH')
      return state
    }

    const selectWorktree = async (input: Record<string, unknown>, context: LocalRequestContext) => {
      const state = requireState(input, context)
      const worktreeId = text(input.worktreeId, 64)
      if (!/^[a-f0-9]{64}$/.test(worktreeId) || !state.service.worktrees) throw new Error('WORKTREE_UNLINKED')
      const discovery = await state.service.worktrees.discover()
      const record = await state.service.worktrees.revalidateSelection(worktreeId).catch(() => { throw new Error('WORKTREE_UNLINKED') })
      if (!state.isCurrent() || !context.connected()) throw new Error('PROJECT_CONTEXT_CHANGED')
      return { state, worktreeId, discovery, record }
    }

    const deliveryFor = (
      state: GitLocalSessionState,
      worktreeId: string,
      request: Record<string, unknown>,
      context: LocalRequestContext
    ): (() => Promise<DeliveryAnchor | undefined>) | undefined => {
      const activeContinuum = this.continuum.getActiveService()
      if (!activeContinuum || this.continuum.getActiveSession()?.repositoryId !== state.repositoryId || !context.principal) {
        if (request.deliveryContext !== undefined) throw new Error('DELIVERY_CONTEXT_INVALID')
        return undefined
      }
      let deliveryContextError: string | undefined
      let deliveryContext: import('../../shared/types/delivery-context-types').DeliveryContextRequest | undefined
      if (request.deliveryContext !== undefined) {
        const parsed = deliveryContextRequest.safeParse(request.deliveryContext)
        if (!parsed.success) deliveryContextError = 'DELIVERY_CONTEXT_MALFORMED'
        else deliveryContext = parsed.data
      }
      let sessionWitness: import('../../shared/types/delivery-context-types').AuthenticatedSessionWitness | undefined
      if (request.sessionWitness !== undefined) {
        const parsed = authenticatedSessionWitness.safeParse(request.sessionWitness)
        if (!parsed.success) deliveryContextError ??= 'SESSION_WITNESS_INVALID'
        else sessionWitness = parsed.data
      }
      const authority = authorizeArtifactAgent(
        context.principal,
        state.repositoryId,
        () => state.isCurrent() && context.connected(),
        worktreeId,
        deliveryContext || deliveryContextError || sessionWitness
          ? { ...(deliveryContext ? { deliveryContext } : {}), ...(deliveryContextError ? { deliveryContextError } : {}), ...(sessionWitness ? { sessionWitness } : {}) }
          : undefined
      )
      const observe = () => state.service.deliverySnapshot(worktreeId)
      return async () => {
        if (activeContinuum.resolveExecutionContext) {
          return (await activeContinuum.resolveExecutionContext(authority, undefined, observe, { worktreeId })).anchor
        }
        if (deliveryContext) return activeContinuum.prepareDeliveryContext(authority, deliveryContext, observe)
        return undefined
      }
    }

    const unwrapResult = (result: { content: Array<{ type: string; text?: string }>; isError?: true }) => {
      const first = result.content.find(entry => entry.type === 'text')
      const parsed = first?.text ? JSON.parse(first.text) as Record<string, unknown> : {}
      if (result.isError) {
        const code = typeof parsed.code === 'string' && parsed.code ? parsed.code : 'GIT_OPERATION_FAILED'
        throw new GitOperationsError(code, parsed)
      }
      return parsed
    }

    const common = ['repositoryId', 'worktreeId']
    this.operations = {
      status: operation(input => object(input, []), async (_request, context) => {
        const state = this.getState()
        if (!state || !state.isCurrent() || !context.connected()) return { available: false, repository: null }
        const discovery = state.service.worktrees
          ? await state.service.worktrees.discover()
          : { worktrees: [] }
        if (!state.isCurrent()) throw new Error('PROJECT_CONTEXT_CHANGED')
        return {
          available: true,
          repository: { repositoryId: state.repositoryId, checkout: state.repositoryPath },
          worktrees: discovery.worktrees.filter(w => !w.missing && !w.prunable).map(w => ({ worktreeId: w.worktreeId, generation: w.generation, path: w.path, branch: w.branch, head: w.head }))
        }
      }),
      state: operation(input => object(input, common), async (request, context) => {
        const { state, worktreeId } = await selectWorktree(request, context)
        return state.service.inspectWorktree(worktreeId)
      }),
      stage: operation(
        input => object(input, [...common, 'operationId', 'mode', 'paths', 'expectedIndexRevision', 'expectedWorktreeRevision', 'leaseId', 'leaseCredential', 'snapshot']),
        async (request, context) => {
          const { state, worktreeId, record } = await selectWorktree(request, context)
          const operationId = text(request.operationId, 128)
          const mode = text(request.mode, 16) as 'STAGE' | 'UNSTAGE'
          if (!['STAGE', 'UNSTAGE'].includes(mode) || !Array.isArray(request.paths)) throw new Error('INVALID_ARGUMENT')
          const paths = request.paths.map(entry => text(entry, 1024))
          if (request.leaseId !== undefined) {
            return unwrapResult(await state.service.mutateWorktree({
              action: mode,
              worktreeId,
              leaseId: text(request.leaseId, 128),
              leaseCredential: text(request.leaseCredential, 128),
              operationId,
              snapshot: object(request.snapshot, ['branch', 'head', 'indexRevision', 'worktreeRevision', 'operation']) as never,
              paths
            }))
          }
          if (!samePath(record.path, state.repositoryPath)) throw new Error('WORKTREE_OWNERSHIP_REQUIRED')
          const args = {
            mode,
            paths,
            expectedIndexRevision: text(request.expectedIndexRevision, 64),
            expectedWorktreeRevision: text(request.expectedWorktreeRevision, 64)
          }
          return unwrapResult(await state.service.executeReceipted(operationId, 'stage_git_changes', args, async () =>
            encodeGitReceiptResult({ value: await state.service.stage(args) as unknown as Record<string, unknown> })
          ))
        }
      ),
      commit: operation(
        input => object(input, [...common, 'operationId', 'message', 'expectedHead', 'expectedIndexRevision', 'deliveryContext', 'sessionWitness', 'leaseId', 'leaseCredential', 'snapshot']),
        async (request, context) => {
          const { state, worktreeId, record } = await selectWorktree(request, context)
          const operationId = text(request.operationId, 128)
          const message = text(request.message, 10000)
          const prepareDelivery = deliveryFor(state, worktreeId, request, context)
          if (request.leaseId !== undefined) {
            return unwrapResult(await state.service.mutateWorktree({
              action: 'COMMIT',
              worktreeId,
              leaseId: text(request.leaseId, 128),
              leaseCredential: text(request.leaseCredential, 128),
              operationId,
              snapshot: object(request.snapshot, ['branch', 'head', 'indexRevision', 'worktreeRevision', 'operation']) as never,
              message
            }, prepareDelivery))
          }
          if (!samePath(record.path, state.repositoryPath)) throw new Error('WORKTREE_OWNERSHIP_REQUIRED')
          const expectedHead = request.expectedHead === null ? null : text(request.expectedHead, 64)
          const expectedIndexRevision = text(request.expectedIndexRevision, 64)
          const args = { message, expectedHead, expectedIndexRevision }
          return unwrapResult(await state.service.executeReceipted(operationId, 'commit_git_changes', args, async () =>
            encodeGitReceiptResult({ value: await state.service.commit(args) as unknown as Record<string, unknown> })
          , prepareDelivery))
        }
      ),
      sync: operation(
        input => object(input, [...common, 'operationId', 'action', 'remote', 'branch', 'expectedHead', 'leaseId', 'leaseCredential', 'snapshot']),
        async (request, context) => {
          const { state, worktreeId, record } = await selectWorktree(request, context)
          const action = text(request.action, 32)
          if (!['FETCH', 'PULL_FF_ONLY', 'PUSH'].includes(action)) throw new Error('INVALID_ARGUMENT')
          if (action === 'PUSH' && request.leaseId !== undefined) {
            const prepareDelivery = deliveryFor(state, worktreeId, request, context)
            return unwrapResult(await state.service.publishWorktree({
              worktreeId,
              leaseId: text(request.leaseId, 128),
              leaseCredential: text(request.leaseCredential, 128),
              operationId: text(request.operationId, 128),
              snapshot: object(request.snapshot, ['branch', 'head', 'indexRevision', 'worktreeRevision', 'operation']) as never,
              branch: text(request.branch, 255),
              remote: text(request.remote ?? 'origin', 128)
            }, prepareDelivery))
          }
          if (!samePath(record.path, state.repositoryPath)) throw new Error('WORKTREE_OWNERSHIP_REQUIRED')
          if (action === 'FETCH') {
            return state.service.sync({
              action: 'FETCH',
              ...(request.remote !== undefined ? { remote: text(request.remote, 128) } : {}),
              ...(request.branch !== undefined ? { branch: text(request.branch, 255) } : {})
            })
          }
          const args: SyncRequest = {
            action: action as 'PULL_FF_ONLY' | 'PUSH',
            expectedHead: text(request.expectedHead, 64),
            ...(request.remote !== undefined ? { remote: text(request.remote, 128) } : {}),
            ...(request.branch !== undefined ? { branch: text(request.branch, 255) } : {})
          }
          const operationId = text(request.operationId, 128)
          return unwrapResult(await state.service.executeReceipted(operationId, 'sync_git_remote', args as unknown as Record<string, unknown>, async () =>
            encodeGitReceiptResult({ value: await state.service.sync(args) as unknown as Record<string, unknown> })
          ))
        }
      )
    }
  }
}
