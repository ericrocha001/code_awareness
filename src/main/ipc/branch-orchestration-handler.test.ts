import { expect, it, vi } from 'vitest'
import { BranchOrchestrationController } from './branch-orchestration-handler'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
const context = { projectId: 'a', revision: 1 }
it('rejects unavailable preview access, arbitrary commands and stale UI context', async () => {
  const inventory = vi.fn(async () => ({ repositoryId: 'a' }))
  const controller = new BranchOrchestrationController({ getState: () => ({ project: { id: 'a' }, revision: 1 }) as any }, async () => false)
  controller.bind({ getBranchInventory: inventory } as any, {} as any, '/a')
  expect(await controller.request({ context, operation: { action: 'PREVIEW_PROFILES', repositoryId: 'inactive' } })).toEqual({ success: false, code: 'PREVIEW_UNAVAILABLE' })
  expect(await controller.request({ context, operation: { action: 'PREVIEW_PREFLIGHT', selection: { repositoryId: 'a', worktreeId: 'tree', generation: 'gen', profileId: 'web', fingerprint: 'hash', command: 'anything' } } } as any)).toEqual({ success: false, code: 'INVALID_ARGUMENT' })
  expect(await controller.request({ context: { ...context, revision: 0 }, operation: { action: 'PREVIEW_PROFILES', repositoryId: 'a' } })).toEqual({ success: false, code: 'PROJECT_CONTEXT_CHANGED' })
})
it('rejects malformed arguments and stale contexts before touching providers', async () => {
  const inventory = vi.fn(), controller = new BranchOrchestrationController({ getState: () => ({ project: { id: 'a' }, revision: 1 }) as any }, async () => false)
  controller.bind({ getBranchInventory: inventory } as any, {} as any, '/a')
  for (const request of [null, {}, { context }, { context, operation: { action: 'INVENTORY', repositoryId: 'other' } }, { context, operation: { action: 'EXECUTE_DISCARD', request: { previewId: 'x', operationId: 'x', confirmed: false, preserveExclusive: true } } }, { context, operation: { action: 'PR_COMMITS', number: 0, head: 'a'.repeat(40), page: 1 } }]) {
    expect(await controller.request(request as any)).toEqual({ success: false, code: 'INVALID_ARGUMENT' })
  }
  expect(await controller.request({ context: { ...context, revision: 0 }, operation: { action: 'INVENTORY' } })).toEqual({ success: false, code: 'PROJECT_CONTEXT_CHANGED' })
  expect(inventory).not.toHaveBeenCalled()
})
it('drops delayed inventory and PR responses after project replacement', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const controller = new BranchOrchestrationController({ getState: () => ({ project: { id: 'a' }, revision: 1 }) as any }, async () => false)
  const git = { getBranchInventory: async () => { await gate; return { repositoryId: 'a', revision: 'one' } } }
  controller.bind(git as any, {} as any, '/a')
  const pending = controller.request({ context, operation: { action: 'INVENTORY' } })
  await controller.deactivate(); release()
  expect(await pending).toEqual({ success: false, code: 'PROJECT_CONTEXT_CHANGED' })
})
it('revalidates inventory before attaching PRs and mutation context inside the owner', async () => {
  const controller = new BranchOrchestrationController({ getState: () => ({ project: { id: 'a' }, revision: 1 }) as any }, async () => false)
  const inventory = vi.fn().mockResolvedValueOnce({ revision: 'one' }).mockResolvedValueOnce({ revision: 'two' })
  const github = { branchPullRequests: vi.fn(async () => ({ catalog: {} })) }
  controller.bind({ getBranchInventory: inventory } as any, github as any, '/a')
  expect(await controller.request({ context, operation: { action: 'PULL_REQUESTS', inventoryRevision: 'one' } })).toEqual({ success: false, code: 'GIT_STATE_CHANGED' })
  let guard!: () => void
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  controller.bind({ executeBranchDiscard: async (_r: unknown, _remote: unknown, check: () => void) => { guard = check; await gate; check(); return {} } } as any, {} as any, '/a')
  const pending = controller.request({ context, operation: { action: 'EXECUTE_DISCARD', request: { previewId: 'preview', operationId: 'once', confirmed: true, preserveExclusive: true } } })
  const ending = controller.deactivate()
  expect(() => guard()).toThrow('PROJECT_CONTEXT_CHANGED')
  release(); await ending
  expect(await pending).toEqual({ success: false, code: 'PROJECT_CONTEXT_CHANGED' })
})

it('transports both PR directions in one repository snapshot and rejects delayed project drift', async () => {
  const controller = new BranchOrchestrationController({ getState: () => ({ project: { id: 'a' }, revision: 1 }) as any }, async () => false)
  const inventory = { repositoryId: 'a', revision: 'one' }
  const pullRequests = { repositoryId: 'a', catalog: { revision: 'catalog' }, relations: [{ branchKey: 'topic' }], received: [{ branchKey: 'main', classification: 'DECLARED_DESTINATION' }], orphaned: [{ number: 32 }] }
  const github = { branchPullRequests: vi.fn(async () => pullRequests) }
  controller.bind({ getBranchInventory: async () => inventory } as any, github as any, '/a')
  expect(await controller.request({ context, operation: { action: 'PULL_REQUESTS', inventoryRevision: 'one' } })).toEqual({ success: true, context, data: { kind: 'PULL_REQUESTS', inventoryRevision: 'one', pullRequests } })
  expect(github.branchPullRequests).toHaveBeenCalledExactlyOnceWith('/a', inventory)
  let release!: (value: any) => void
  github.branchPullRequests.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const delayed = controller.request({ context, operation: { action: 'PULL_REQUESTS', inventoryRevision: 'one' } })
  await vi.waitFor(() => expect(release).toBeDefined())
  await controller.deactivate()
  release(pullRequests)
  expect(await delayed).toEqual({ success: false, code: 'PROJECT_CONTEXT_CHANGED' })
})
