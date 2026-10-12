import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { executeGitOperationsTool } from './git-operations-mcp'
import type {
  GitBasicAction,
  GitMutationRequest
} from '../../shared/types/git-management-types'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
import { GitManagementController } from '../ipc/git-management-handler'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GitService } from '../core/git-service'
import { GitOperationsService } from './git-operations-service'
import { GitHubGitTransport } from '../github/github-git-transport'
import {
  createTempGitRepo,
  gitExec,
  writeFile,
  stageAll,
  commit,
  cleanupTempRepo
} from '../core/git-test-helpers'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupTempRepo(root)
})
it('projects all branch tips, real merge parents and page boundaries without modifying Git', async () => {
  const root = await createTempGitRepo()
  roots.push(root)
  await gitExec(root, ['branch', '-m', 'main'])
  writeFile(root, 'root.txt', 'root')
  await stageAll(root)
  await commit(root, 'root')
  const initial = (await gitExec(root, ['rev-parse', 'HEAD'])).trim()
  await gitExec(root, ['switch', '-c', 'topic'])
  writeFile(root, 'topic.txt', 'topic')
  await stageAll(root)
  await commit(root, 'topic')
  const topic = (await gitExec(root, ['rev-parse', 'HEAD'])).trim()
  await gitExec(root, ['switch', 'main'])
  writeFile(root, 'main.txt', 'main')
  await stageAll(root)
  await commit(root, 'main')
  await gitExec(root, ['merge', '--no-ff', 'topic', '-m', 'merge'])
  const merge = (await gitExec(root, ['rev-parse', 'HEAD'])).trim()
  await gitExec(root, ['switch', '-c', 'remote-only', initial])
  writeFile(root, 'remote.txt', 'remote')
  await stageAll(root)
  await commit(root, 'remote')
  const remote = (await gitExec(root, ['rev-parse', 'HEAD'])).trim()
  await gitExec(root, ['update-ref', 'refs/remotes/origin/remote-only', remote])
  await gitExec(root, ['switch', 'main'])
  await gitExec(root, ['branch', '-D', 'remote-only'])
  const before = await gitExec(root, ['status', '--porcelain=v1'])
  const git = new GitService(),
    service = new GitOperationsService(
      root,
      git,
      new GitHubGitTransport(null, git)
    )
  const nodes = []
  let page = await service.getGraphHistory({ limit: 2 })
  const stale = page.nextCursor!
  expect(page.nodes).toHaveLength(2)
  expect(page.pendingParents.length).toBeGreaterThan(0)
  for (;;) {
    nodes.push(...page.nodes)
    if (!page.nextCursor) break
    page = await service.getGraphHistory({ limit: 2, cursor: page.nextCursor })
  }
  expect(new Set(nodes.map((node) => node.sha)).size).toBe(5)
  expect(nodes.find((node) => node.sha === merge)?.parents).toHaveLength(2)
  expect(
    nodes
      .find((node) => node.sha === topic)
      ?.decorations.some((ref) => ref.name === 'topic')
  ).toBe(true)
  expect(
    nodes
      .find((node) => node.sha === remote)
      ?.decorations.some((ref) => ref.kind === 'REMOTE')
  ).toBe(true)
  expect(nodes.find((node) => node.sha === initial)?.parents).toEqual([])
  expect(await service.getCommitDetail({ sha: merge })).toMatchObject({
    comparison: 'FIRST_PARENT',
    files: [{ path: 'topic.txt', status: 'A' }]
  })
  expect(
    await service.getManagementPatch({
      mode: 'COMMIT',
      path: 'topic.txt',
      sha: merge
    })
  ).toMatchObject({ binary: false, patch: expect.stringContaining('+topic') })
  expect(await service.getCommitDetail({ sha: initial })).toMatchObject({
    comparison: 'ROOT',
    files: [{ path: 'root.txt', status: 'A' }]
  })
  expect(
    (
      await service.getManagementPatch({
        mode: 'COMMIT',
        path: 'root.txt',
        sha: initial
      })
    ).patch
  ).toContain('+root')
  expect(await gitExec(root, ['status', '--porcelain=v1'])).toBe(before)
  expect(await git.getCurrentCommitHash(root)).toBe(merge)
  await gitExec(root, [
    'update-ref',
    'refs/remotes/origin/remote-only',
    initial
  ])
  await expect(
    service.getGraphHistory({ limit: 2, cursor: stale })
  ).rejects.toThrow('GIT_STATE_CHANGED')
  await gitExec(root, ['switch', '--detach', remote])
  expect((await service.getGraphHistory({})).refs).toContainEqual(
    expect.objectContaining({
      sha: remote,
      kind: 'HEAD',
      name: 'HEAD (detached)'
    })
  )
}, 30000)

it('executes selective stage, exact commit and cross-border receipt replay through the same authority', async () => {
  const root = await createTempGitRepo()
  roots.push(root)
  writeFile(root, 'file.txt', 'base\n')
  await stageAll(root)
  await commit(root, 'base')
  const git = new GitService(),
    service = new GitOperationsService(
      root,
      git,
      new GitHubGitTransport(null, git)
    )
  const state = { revision: 1, project: { id: 'a', name: 'A', path: root } },
    context = { projectId: 'a', revision: 1 }
  const controller = new GitManagementController({ getState: () => state })
  controller.bind(service)
  writeFile(root, 'file.txt', 'prepared\n')
  writeFile(root, 'other.txt', 'leave untracked\n')
  const snapshot = await service.getState(),
    operationId = randomUUID()
  const request: GitMutationRequest = {
    context,
    snapshot,
    operationId,
    operation: { action: 'STAGE', paths: ['file.txt'] }
  }
  expect(await controller.mutate(request)).toMatchObject({
    success: true,
    data: { value: { replayed: false } }
  })
  expect(
    (await service.getChanges('STAGED')).map((change) => change.path)
  ).toEqual(['file.txt'])
  const args = {
    mode: 'STAGE',
    paths: ['file.txt'],
    expectedIndexRevision: snapshot.indexRevision,
    expectedWorktreeRevision: snapshot.worktreeRevision,
    operationId
  }
  expect(
    JSON.parse(
      (await executeGitOperationsTool(service, 'stage_git_changes', args))
        .content[0].text
    )
  ).toMatchObject({ replayed: true })
  writeFile(root, 'file.txt', 'later unstaged\n')
  const inspected = await service.getState(),
    commitId = randomUUID()
  const legacyArgs = {
    message: 'exact index',
    expectedHead: inspected.head,
    expectedIndexRevision: inspected.indexRevision,
    operationId: commitId
  }
  expect(
    JSON.parse(
      (
        await executeGitOperationsTool(
          service,
          'commit_git_changes',
          legacyArgs
        )
      ).content[0].text
    )
  ).toMatchObject({ replayed: false, paths: ['file.txt'] })
  expect(
    await controller.mutate({
      context,
      snapshot: inspected,
      operationId: commitId,
      operation: { action: 'COMMIT', message: 'exact index' }
    })
  ).toMatchObject({
    success: true,
    data: { value: { replayed: true, paths: ['file.txt'] } }
  })
  expect((await gitExec(root, ['show', 'HEAD:file.txt'])).trim()).toBe(
    'prepared'
  )
  expect(
    (await service.getChanges()).map((change) => change.path).sort()
  ).toEqual(['file.txt', 'other.txt'])
  const stale = await service.getState()
  writeFile(root, 'file.txt', 'external change\n')
  const staleRequest: GitMutationRequest = {
    context,
    snapshot: stale,
    operationId: randomUUID(),
    operation: { action: 'STAGE', paths: ['file.txt'] }
  }
  expect(await controller.mutate(staleRequest)).toMatchObject({
    data: { isError: true, value: { code: 'GIT_STATE_CHANGED' } }
  })
  expect(await controller.mutate(staleRequest)).toMatchObject({
    data: {
      isError: true,
      value: { code: 'GIT_STATE_CHANGED', replayed: true }
    }
  })
  expect(
    await controller.mutate({
      ...staleRequest,
      operation: { action: 'STAGE', paths: [] }
    })
  ).toEqual({ success: false, code: 'INVALID_ARGUMENT' })
}, 30000)

it('creates and switches branches safely, refuses occupied branches and protects stale/project contexts', async () => {
  const root = await createTempGitRepo()
  roots.push(root)
  await gitExec(root, ['branch', '-m', 'main'])
  writeFile(root, 'file.txt', 'base\n')
  await stageAll(root)
  await commit(root, 'base')
  const git = new GitService(),
    service = new GitOperationsService(
      root,
      git,
      new GitHubGitTransport(null, git)
    )
  const run = async (operation: GitBasicAction) =>
    service.executeManagementMutation(
      {
        context: { projectId: 'a', revision: 1 },
        snapshot: await service.getState(),
        operationId: randomUUID(),
        operation
      },
      () => {}
    )
  writeFile(root, 'file.txt', 'dirty but compatible\n')
  expect(await run({ action: 'CREATE', branch: 'topic' })).toMatchObject({
    value: { branch: 'main' }
  })
  expect(await run({ action: 'SWITCH', branch: 'topic' })).toMatchObject({
    value: { branch: 'topic' }
  })
  const linked = root + '-linked'
  roots.push(linked)
  await gitExec(root, ['worktree', 'add', linked, 'main'])
  const occupied = {
    context: { projectId: 'a', revision: 1 },
    snapshot: await service.getState(),
    operationId: randomUUID(),
    operation: { action: 'SWITCH' as const, branch: 'main' }
  }
  expect(
    await service.executeManagementMutation(occupied, () => {})
  ).toMatchObject({
    isError: true,
    value: { code: 'WORKTREE_BRANCH_OCCUPIED' }
  })
  expect(
    await service.executeManagementMutation(occupied, () => {})
  ).toMatchObject({
    isError: true,
    value: { code: 'WORKTREE_BRANCH_OCCUPIED', replayed: true }
  })
  const contextChanged = {
    ...occupied,
    operationId: randomUUID(),
    operation: { action: 'CREATE' as const, branch: 'blocked' }
  }
  expect(
    await service.executeManagementMutation(contextChanged, () => {
      throw new Error('PROJECT_CONTEXT_CHANGED')
    })
  ).toMatchObject({ isError: true, value: { code: 'PROJECT_CONTEXT_CHANGED' } })
  const branches = await service.manageBranch({ action: 'LIST' })
  expect(
    Array.isArray(branches) && branches.some((ref) => ref.branch === 'blocked')
  ).toBe(false)
}, 30000)

it('fetches, pulls only fast-forward, pushes without force and replays dirty refusals', async () => {
  const root = await createTempGitRepo()
  roots.push(root)
  await gitExec(root, ['branch', '-m', 'main'])
  writeFile(root, 'file.txt', 'base\n')
  await stageAll(root)
  await commit(root, 'base')
  const remote = await createTempGitRepo()
  roots.push(remote)
  await gitExec(remote, ['config', 'core.bare', 'true'])
  const git = new GitService(),
    service = new GitOperationsService(
      root,
      git,
      new GitHubGitTransport(null, git)
    )
  await git.addRemote(root, 'origin', remote)
  const run = async (operation: GitBasicAction) =>
    service.executeManagementMutation(
      {
        context: { projectId: 'a', revision: 1 },
        snapshot: await service.getState(),
        operationId: randomUUID(),
        operation
      },
      () => {}
    )
  expect(await run({ action: 'PUSH' })).toMatchObject({
    value: { pushedHead: await git.getCurrentCommitHash(root) }
  })
  expect(await run({ action: 'FETCH' })).toMatchObject({
    value: { result: 'FETCHED' }
  })
  const peer = await createTempGitRepo()
  roots.push(peer)
  await git.addRemote(peer, 'origin', remote)
  await git.fetchRemote(peer, 'origin')
  await gitExec(peer, ['switch', '-c', 'main', 'origin/main'])
  writeFile(peer, 'remote.txt', 'from remote\n')
  await stageAll(peer)
  await commit(peer, 'remote advance')
  await git.push(peer, 'origin', 'main')
  writeFile(root, 'file.txt', 'dirty\n')
  const dirty = {
    context: { projectId: 'a', revision: 1 },
    snapshot: await service.getState(),
    operationId: randomUUID(),
    operation: { action: 'PULL_FF_ONLY' as const }
  }
  expect(
    await service.executeManagementMutation(dirty, () => {})
  ).toMatchObject({ isError: true, value: { code: 'DIRTY_WORKTREE' } })
  expect(
    await service.executeManagementMutation(dirty, () => {})
  ).toMatchObject({
    isError: true,
    value: { code: 'DIRTY_WORKTREE', replayed: true }
  })
  await gitExec(root, ['restore', 'file.txt'])
  expect(await run({ action: 'PULL_FF_ONLY' })).toMatchObject({
    value: { head: await git.getCurrentCommitHash(peer) }
  })
  writeFile(root, 'local.txt', 'local\n')
  await stageAll(root)
  await commit(root, 'local advance')
  expect(await run({ action: 'PUSH' })).toMatchObject({
    value: { pushedHead: await git.getCurrentCommitHash(root) }
  })
  await gitExec(root, ['remote', 'set-url', 'origin', root + '-missing'])
  expect(await run({ action: 'FETCH' })).toMatchObject({
    isError: true,
    value: { code: 'OPERATION_OUTCOME_UNKNOWN' }
  })
}, 60000)

it('represents an unborn repository as an empty graph', async () => {
  const root = await createTempGitRepo()
  roots.push(root)
  const git = new GitService()
  expect(
    await new GitOperationsService(
      root,
      git,
      new GitHubGitTransport(null, git)
    ).getGraphHistory({})
  ).toMatchObject({ nodes: [], head: null, nextCursor: null })
})

it('distinguishes index and worktree versions, renames, binaries and bounded patches', async () => {
  const root = await createTempGitRepo()
  roots.push(root)
  writeFile(root, 'file.txt', 'base\n')
  await stageAll(root)
  await commit(root, 'base')
  const git = new GitService(),
    service = new GitOperationsService(
      root,
      git,
      new GitHubGitTransport(null, git)
    )
  writeFile(root, 'file.txt', 'staged\n')
  await stageAll(root)
  writeFile(root, 'file.txt', 'unstaged\n')
  writeFile(root, 'new.txt', 'new\n')
  const observed = await service.getManagementOverview()
  expect(observed.changes).toContainEqual(
    expect.objectContaining({
      path: 'file.txt',
      stagedState: 'M',
      unstagedState: 'M'
    })
  )
  expect(observed.changes).toContainEqual(
    expect.objectContaining({ path: 'new.txt', untracked: true })
  )
  expect(
    (await service.getManagementPatch({ mode: 'STAGED', path: 'file.txt' }))
      .patch
  ).toContain('+staged')
  expect(
    (await service.getManagementPatch({ mode: 'WORKTREE', path: 'file.txt' }))
      .patch
  ).toContain('+unstaged')
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2]))
  expect(
    (await service.getManagementPatch({ mode: 'WORKTREE', path: 'binary.bin' }))
      .binary
  ).toBe(true)
  writeFile(root, 'large.txt', 'large line\n'.repeat(5000))
  const first = await service.getManagementPatch({
    mode: 'WORKTREE',
    path: 'large.txt'
  })
  expect(first.truncated).toBe(true)
  expect(first.patch.length).toBeLessThanOrEqual(24000)
  writeFile(root, 'large.txt', 'changed\n')
  await expect(
    service.getManagementPatch({
      mode: 'WORKTREE',
      path: 'large.txt',
      cursor: first.nextCursor!
    })
  ).rejects.toThrow('GIT_STATE_CHANGED')
  writeFile(root, 'huge.txt', 'long line\n'.repeat(70000))
  await expect(
    service.getManagementPatch({ mode: 'WORKTREE', path: 'huge.txt' })
  ).rejects.toThrow('DIFF_TOO_LARGE')
  await gitExec(root, ['mv', 'file.txt', 'renamed.txt'])
  await stageAll(root)
  await commit(root, 'rename')
  const detail = await service.getCommitDetail({
    sha: (await git.getCurrentCommitHash(root))!
  })
  expect(detail.files.some((file) => file.path === 'renamed.txt')).toBe(true)
}, 30000)
