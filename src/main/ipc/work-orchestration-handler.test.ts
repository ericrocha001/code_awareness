import { expect, it, vi } from 'vitest'
import { WorkOrchestrationController } from './work-orchestration-handler'
import type { OrchestrationGitReader } from '../work-orchestration/work-orchestration-service'
import type { OrchestrationContinuumReader } from '../work-orchestration/worktree-document-context'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
it('guards document requests and drops a document response after project replacement', async () => {
  const id = 'a'.repeat(64), context = { projectId: 'a', revision: 1 }
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const git = { discoverCoordinationWorktrees: vi.fn(), getCoordinationSnapshot: vi.fn(), getCoordinationCommitPaths: vi.fn(),
    getCoordinationIdentity: vi.fn(async () => { await gate; return { repositoryId: 'repo', record: { worktreeId: id, generation: 'g', path: 'root' } } }) } as unknown as OrchestrationGitReader
  const port = { repositoryId: 'repo', isCurrent: () => true, list: vi.fn(() => ({ artifacts: [], nextCursor: null })), declaration: vi.fn(), graph: vi.fn() } as unknown as OrchestrationContinuumReader
  const controller = new WorkOrchestrationController({ getState: () => ({ project: { id: 'a' }, revision: 1 }) as any })
  controller.bind(git, port)
  for (const documents of [{ worktreeId: id, generation: 'g', mode: 'RELATED' }, { worktreeId: id, generation: 'g', mode: 'EXACT', artifactId: 'x' }, { worktreeId: id, generation: 'g', mode: 'ALL' }])
    expect(await controller.read({ context, documents } as any)).toEqual({ success: false, code: 'INVALID_ARGUMENT' })
  expect(port.list).not.toHaveBeenCalled(); expect(git.getCoordinationIdentity).not.toHaveBeenCalled()
  const pending = controller.read({ context, documents: { worktreeId: id, generation: 'g', mode: 'EXACT' } })
  controller.bind(git, port); finish()
  expect(await pending).toEqual({ success: false, code: 'PROJECT_CONTEXT_CHANGED' })
  expect(await controller.read({ context, documents: { worktreeId: id, generation: 'g', mode: 'EXACT' } })).toMatchObject({ success: true, data: { artifacts: [], coverage: 'COMPLETE' } })
})
it('rejects old project revisions and discards responses after switching repositories', async () => {
  let state = { project: { id: 'a' }, revision: 1 }
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const git = {
    discoverCoordinationWorktrees: vi.fn(async () => { await gate; return { repositoryId: 'a', worktrees: [], revision: 'r', nextCursor: null } }),
    getCoordinationSnapshot: vi.fn(), getCoordinationCommitPaths: vi.fn()
  } satisfies OrchestrationGitReader
  const controller = new WorkOrchestrationController({ getState: () => state as any })
  controller.bind(git)
  expect(await controller.read({ context: { projectId: 'a', revision: 0 } })).toEqual({ success: false, code: 'PROJECT_CONTEXT_CHANGED' })
  const pending = controller.read({ context: { projectId: 'a', revision: 1 } })
  controller.deactivate(); state = { project: { id: 'b' }, revision: 2 }; controller.bind(git); finish()
  expect(await pending).toEqual({ success: false, code: 'PROJECT_CONTEXT_CHANGED' })
  expect(await controller.read({ context: { projectId: 'b', revision: 2 } })).toMatchObject({ success: true })
})
it('rejects the removed manual pair endpoint and arbitrary checkout paths without reading Git', async () => {
  const git = { discoverCoordinationWorktrees: vi.fn(), getCoordinationSnapshot: vi.fn(), getCoordinationCommitPaths: vi.fn() } satisfies OrchestrationGitReader
  const controller = new WorkOrchestrationController({ getState: () => ({ project: { id: 'a' }, revision: 1 }) as any })
  controller.bind(git)
  for (const request of [
    { context: { projectId: 'a', revision: 1 }, path: 'C:/arbitrary' },
    { context: { projectId: 'a', revision: 1 }, pair: { leftId: '../a', rightId: 'b' } },
    { context: { projectId: 'a', revision: 1 }, pair: { leftId: 'a'.repeat(64), rightId: 'b'.repeat(64) } },
    { context: { projectId: 'a', revision: -1 } },
    { context: { projectId: 'a', revision: 1 }, worktree: { worktreeId: 'a'.repeat(64), path: 'C:/arbitrary' } },
    { context: { projectId: 'a', revision: 1 }, worktree: { worktreeId: 'a'.repeat(64) }, pair: { leftId: 'a'.repeat(64), rightId: 'b'.repeat(64) } }
  ]) expect(await controller.read(request as any)).toEqual({ success: false, code: 'INVALID_ARGUMENT' })
  expect(git.discoverCoordinationWorktrees).not.toHaveBeenCalled()
  expect(git.getCoordinationSnapshot).not.toHaveBeenCalled()
  expect(git.getCoordinationCommitPaths).not.toHaveBeenCalled()
})
