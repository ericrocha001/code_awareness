import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
import { GitManagementController } from './git-management-handler'
import type { GitOperationsService } from '../git-operations/git-operations-service'
import type { GitMutationRequest } from '../../shared/types/git-management-types'

it('routes only typed correlation reads, binds continuation to project context and drops late results', async () => {
  let state = { project: { id: 'a', path: '/a', name: 'A' }, revision: 1 }, finish!: (value: any) => void
  const service = { getWorktreeCommits: vi.fn(async () => ({ direction: 'WORKTREE_COMMITS' })), getCommitWorktrees: vi.fn(() => new Promise(resolve => { finish = resolve })) } as unknown as GitOperationsService
  const controller = new GitManagementController({ getState: () => state }); controller.bind(service)
  const context = { projectId: 'a', revision: 1 }
  expect(await controller.correlation({ context, direction: 'WORKTREE_COMMITS', worktreeId: 'a'.repeat(64), generation: 'g' })).toMatchObject({ success: true, data: { direction: 'WORKTREE_COMMITS' } })
  expect(service.getWorktreeCommits).toHaveBeenCalledWith({ worktreeId: 'a'.repeat(64), generation: 'g', contextKey: 'a:1' })
  expect(await controller.correlation({ context, direction: 'COMMIT_WORKTREES', sha: 'a'.repeat(40), path: 'outside' } as any)).toEqual({ success: false, code: 'INVALID_ARGUMENT' })
  expect(service.getCommitWorktrees).not.toHaveBeenCalled()
  const pending = controller.correlation({ context, direction: 'COMMIT_WORKTREES', sha: 'a'.repeat(40) })
  state = { project: { id: 'b', path: '/b', name: 'B' }, revision: 2 }; controller.bind(service); finish({ direction: 'COMMIT_WORKTREES' })
  expect(await pending).toEqual({ success: false, code: 'PROJECT_CONTEXT_CHANGED' })
  expect(await controller.correlation({ context, direction: 'COMMIT_WORKTREES', sha: 'a'.repeat(40) })).toEqual({ success: false, code: 'PROJECT_CONTEXT_CHANGED' })
})

it('rejects obsolete contexts and discards requests completing after a project change', async () => {
  let state = { project: { id: 'a', path: '/a', name: 'A' }, revision: 1 }
  const controller = new GitManagementController({ getState: () => state })
  const service = {} as GitOperationsService
  controller.bind(service)
  let finish!: (value: string) => void
  const pending = controller.read(
    { projectId: 'a', revision: 1 },
    () =>
      new Promise<string>((resolve) => {
        finish = resolve
      })
  )
  state = { project: { id: 'b', path: '/b', name: 'B' }, revision: 2 }
  controller.bind(service)
  finish('old')
  expect(await pending).toEqual({
    success: false,
    code: 'PROJECT_CONTEXT_CHANGED'
  })
  const call = vi.fn()
  expect(await controller.read({ projectId: 'a', revision: 1 }, call)).toEqual({
    success: false,
    code: 'PROJECT_CONTEXT_CHANGED'
  })
  expect(call).not.toHaveBeenCalled()
})

it('quiesces mutations during project transition and rechecks authority inside execution', async () => {
  const state = { project: { id: 'a', path: '/a', name: 'A' }, revision: 1 }
  const controller = new GitManagementController({ getState: () => state })
  let release!: () => void
  const execute = vi.fn(async (_request, guard) => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    guard()
    return { value: {} }
  })
  controller.bind({
    executeManagementMutation: execute
  } as unknown as GitOperationsService)
  const request = {
    context: { projectId: 'a', revision: 1 },
    operationId: 'operation-a',
    snapshot: {
      head: null,
      branch: 'main',
      operation: null,
      indexRevision: 'a'.repeat(64),
      worktreeRevision: 'b'.repeat(64)
    },
    operation: { action: 'FETCH' }
  } as GitMutationRequest
  const mutation = controller.mutate(request)
  let drained = false
  const transition = controller.deactivate().then(() => {
    drained = true
  })
  expect(drained).toBe(false)
  release()
  expect(await mutation).toEqual({
    success: false,
    code: 'PROJECT_CONTEXT_CHANGED'
  })
  await transition
  expect(drained).toBe(true)
  expect(
    await controller.mutate({
      ...request,
      operation: { action: 'DELETE', branch: 'main' }
    } as unknown as GitMutationRequest)
  ).toEqual({ success: false, code: 'INVALID_ARGUMENT' })
})
