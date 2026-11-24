import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitService } from '../core/git-service'
import { cleanupTempRepo, commit, createTempDir, createTempGitRepo, gitExec, stageAll } from '../core/git-test-helpers'
import { GitHubGitTransport } from '../github/github-git-transport'
import { GitOperationsService } from '../git-operations/git-operations-service'
import type { WorktreeApprovalPort, WorktreeSnapshot } from '../git-operations/git-worktree-ownership'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupTempRepo(root)
})

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const snap = (s: WorktreeSnapshot): WorktreeSnapshot => ({
  branch: s.branch,
  head: s.head,
  indexRevision: s.indexRevision,
  worktreeRevision: s.worktreeRevision,
  operation: s.operation
})

async function createFixture(approve?: WorktreeApprovalPort) {
  const root = await createTempGitRepo(); roots.push(root)
  const external = createTempDir('code-editing-wt-'); roots.push(external)
  mkdirSync(join(root, 'src'), { recursive: true })
  const alphaInitial = '// Alpha\r\nexport const label = "ação 😀"\r\nexport const keep = 1\r\n'
  const betaInitial = 'export const beta = "initial"\n'
  writeFileSync(join(root, 'src/alpha.ts'), alphaInitial)
  writeFileSync(join(root, 'src/beta.ts'), betaInitial)
  await stageAll(root)
  await commit(root, 'baseline')

  const a = join(external, 'agent-a')
  const b = join(external, 'agent-b')
  await gitExec(root, ['worktree', 'add', '-b', 'agent-a', a])
  await gitExec(root, ['worktree', 'add', '-b', 'agent-b', b])

  const git = new GitService()
  let active = true
  let approvalCalls = 0
  const service = new GitOperationsService(
    root,
    git,
    new GitHubGitTransport(null, git),
    { repositoryId: 'repo-code-editing', isActive: () => active },
    false,
    async request => {
      approvalCalls++
      return approve ? approve(request) : true
    }
  )
  const adapter = new ChannelMcpAdapter({
    projectId: 'repo-code-editing',
    repoRoot: root,
    navigation: {} as ProjectContextNavigation,
    gitOperations: service
  })
  const server = createMcpHttpServer(adapter, () => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing port')

  const rpc = async (method: string, params: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
    return (await response.json() as { result: any }).result
  }
  const callRaw = (name: string, args: unknown) => rpc('tools/call', { name, arguments: args })
  const call = async (name: string, args: unknown) => {
    const res = await callRaw(name, args)
    return { isError: Boolean(res.isError), data: JSON.parse(res.content[0].text) }
  }

  async function grant(worktreeId: string, operations: string[], paths: string[], recovery = false) {
    const inspected = (await call('inspect_worktree', { worktreeId })).data
    const req = (await call('handoff_worktree_for_git', {
      action: recovery ? 'RECOVER' : 'REQUEST',
      worktreeId,
      snapshot: snap(inspected),
      scope: { operations, paths, branches: [] },
      durationSeconds: 300
    })).data
    for (let i = 0; i < 600; i++) {
      const acc = (await call('handoff_worktree_for_git', {
        action: 'ACCEPT',
        requestId: req.requestId,
        requestCredential: req.requestCredential
      })).data
      if (acc.state === 'KNOWN_GRANTED') {
        return { worktreeId, generation: inspected.generation, leaseId: acc.leaseId, leaseCredential: acc.leaseCredential, snapshot: snap(inspected) }
      }
      if (acc.state !== 'PENDING') throw new Error(acc.code ?? acc.state)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error('APPROVAL_TIMEOUT')
  }

  return {
    root,
    a,
    b,
    git,
    service,
    rpc,
    callRaw,
    call,
    grant,
    getApprovalCalls: () => approvalCalls,
    deactivate: () => { active = false },
    close: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  }
}

describe('governed worktree text editing through real MCP HTTP', () => {
  it('discovers, inspects, reads fileRevision, edits two files and creates one test in one batch, preserves sibling/HEAD/index, reuses grant, and feeds mutate_worktree', async () => {
    const f = await createFixture()
    try {
      const catalog = await f.rpc('tools/list', {})
      expect(catalog.tools.some((t: { name: string }) => t.name === 'edit_worktree_text')).toBe(true)

      const discovered = (await f.call('discover_worktrees', {})).data.worktrees
      const mainWt = discovered.find((w: any) => w.path === f.root)
      const wtA = discovered.find((w: any) => w.path === f.a)
      const wtB = discovered.find((w: any) => w.path === f.b)

      const rootHeadBefore = await f.git.getCurrentCommitHash(f.root)
      const rootIndexBefore = await f.git.getIndexRevision(f.root)
      const aHeadBefore = await f.git.getCurrentCommitHash(f.a)
      const aIndexBefore = await f.git.getIndexRevision(f.a)
      const bHeadBefore = await f.git.getCurrentCommitHash(f.b)
      const bIndexBefore = await f.git.getIndexRevision(f.b)

      const readAlpha = (await f.call('read_worktree_file', { worktreeId: wtA.worktreeId, path: 'src/alpha.ts', startLine: 1, endLine: 3 })).data
      const readBeta = (await f.call('read_worktree_file', { worktreeId: wtA.worktreeId, path: 'src/beta.ts', startLine: 1, endLine: 1 })).data
      expect(readAlpha.revisionKind).toBe('FILE_BYTES_SHA256')

      const ownership = await f.grant(wtA.worktreeId, ['EDIT_TEXT', 'STAGE', 'COMMIT'], ['src/alpha.ts', 'src/beta.ts', 'src/alpha.test.ts'])
      expect(f.getApprovalCalls()).toBe(1)

      // Decisive negative: stale hash in item 2 refuses whole batch without touching disk and preserves grant
      const rejected = await f.call('edit_worktree_text', {
        ...ownership,
        operationId: 'op-stale-negative',
        intent: { description: 'Should reject stale second file' },
        changes: [
          { operation: 'EDIT', path: 'src/alpha.ts', expectedSha256: readAlpha.fileRevision, replacements: [{ oldText: 'ação 😀', newText: 'mutated' }] },
          { operation: 'EDIT', path: 'src/beta.ts', expectedSha256: '0'.repeat(64), replacements: [{ oldText: 'initial', newText: 'updated' }] },
          { operation: 'CREATE', path: 'src/alpha.test.ts', text: 'test\n' }
        ]
      })
      expect(rejected.isError).toBe(true)
      expect(rejected.data).toMatchObject({ state: 'REJECTED', code: 'FILE_REVISION_CONFLICT' })
      expect(readFileSync(join(f.a, 'src/alpha.ts'), 'utf8')).toBe(readAlpha.content)
      expect(existsSync(join(f.a, 'src/alpha.test.ts'))).toBe(false)

      // Happy path batch using the same grant (approvalCalls stays 1)
      const applyArgs = {
        ...ownership,
        operationId: 'op-batch-1',
        intent: { description: 'Edit alpha/beta and create alpha.test.ts' },
        changes: [
          { operation: 'EDIT', path: 'src/alpha.ts', expectedSha256: readAlpha.fileRevision, replacements: [{ oldText: 'ação 😀', newText: 'revisão ✅' }] },
          { operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'v2' }] },
          { operation: 'CREATE', path: 'src/alpha.test.ts', text: 'export const tested = true\n' }
        ]
      }
      const applied = await f.call('edit_worktree_text', applyArgs)
      expect(applied.isError).toBe(false)
      expect(applied.data).toMatchObject({
        state: 'APPLIED',
        worktreeId: wtA.worktreeId,
        generation: wtA.generation,
        operationId: 'op-batch-1',
        replayed: false
      })
      expect(applied.data.files).toHaveLength(3)
      expect(applied.data.files[0]).toMatchObject({ path: 'src/alpha.ts', operation: 'EDIT', beforeSha256: readAlpha.fileRevision, changed: true, state: 'CONFIRMED' })
      expect(applied.data.files[2]).toMatchObject({ path: 'src/alpha.test.ts', operation: 'CREATE', beforeSha256: null, changed: true, state: 'CONFIRMED' })
      expect(applied.data.diff.patch).toContain('+export const label = "revisão ✅"')
      expect(applied.data.diff.bytes).toBeLessThanOrEqual(8192)
      expect(f.getApprovalCalls()).toBe(1)

      // Reread bytes via read_worktree_file and disk; verify isolation
      const rereadAlpha = (await f.call('read_worktree_file', { worktreeId: wtA.worktreeId, path: 'src/alpha.ts', startLine: 1, endLine: 3 })).data
      expect(rereadAlpha.fileRevision).toBe(applied.data.files[0].afterSha256)
      expect(rereadAlpha.content).toBe('// Alpha\r\nexport const label = "revisão ✅"\r\nexport const keep = 1\r\n')
      expect(readFileSync(join(f.a, 'src/alpha.test.ts'), 'utf8')).toBe('export const tested = true\n')

      expect(await f.git.getCurrentCommitHash(f.root)).toBe(rootHeadBefore)
      expect(await f.git.getIndexRevision(f.root)).toBe(rootIndexBefore)
      expect(await f.git.getCurrentCommitHash(f.a)).toBe(aHeadBefore)
      expect(await f.git.getIndexRevision(f.a)).toBe(aIndexBefore)
      expect(await f.git.getCurrentCommitHash(f.b)).toBe(bHeadBefore)
      expect(await f.git.getIndexRevision(f.b)).toBe(bIndexBefore)
      expect(readFileSync(join(f.b, 'src/alpha.ts'), 'utf8')).toBe(readAlpha.content)
      expect(existsSync(join(f.b, 'src/alpha.test.ts'))).toBe(false)
      expect(existsSync(join(f.root, 'src/alpha.test.ts'))).toBe(false)

      // Replay with same operationId + payload omits diff and does not re-apply
      const replayed = await f.call('edit_worktree_text', applyArgs)
      expect(replayed.isError).toBe(false)
      expect(replayed.data).toMatchObject({ state: 'APPLIED', replayed: true, diff: { omitted: 'REPLAY' } })

      // Divergent payload with same operationId refuses with IDEMPOTENCY_CONFLICT
      const conflict = await f.call('edit_worktree_text', {
        ...applyArgs,
        intent: { description: 'divergent intent' }
      })
      expect(conflict.isError).toBe(true)
      expect(conflict.data).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

      // Second consecutive edit with the SAME grant using returned snapshot (still approvalCalls === 1)
      const secondEdit = await f.call('edit_worktree_text', {
        ...ownership,
        snapshot: applied.data.snapshot,
        operationId: 'op-batch-2',
        intent: { description: 'Second edit on same lease' },
        changes: [
          { operation: 'EDIT', path: 'src/beta.ts', expectedSha256: applied.data.files[1].afterSha256, replacements: [{ oldText: 'v2', newText: 'v3' }] }
        ]
      })
      expect(secondEdit.isError).toBe(false)
      expect(secondEdit.data.state).toBe('APPLIED')
      expect(readFileSync(join(f.a, 'src/beta.ts'), 'utf8')).toBe(readBeta.content.replace('initial', 'v3'))
      expect(f.getApprovalCalls()).toBe(1)

      // Consumption by Git Operations (STAGE + COMMIT with the same grant)
      const stage = await f.call('mutate_worktree', {
        worktreeId: wtA.worktreeId,
        leaseId: ownership.leaseId,
        leaseCredential: ownership.leaseCredential,
        snapshot: secondEdit.data.snapshot,
        operationId: 'op-stage-all',
        action: 'STAGE',
        paths: ['src/alpha.ts', 'src/beta.ts', 'src/alpha.test.ts']
      })
      expect(stage.isError).toBe(false)
      const committed = await f.call('mutate_worktree', {
        worktreeId: wtA.worktreeId,
        leaseId: ownership.leaseId,
        leaseCredential: ownership.leaseCredential,
        snapshot: snap(stage.data),
        operationId: 'op-commit-all',
        action: 'COMMIT',
        message: 'feat: governed batch edit'
      })
      expect(committed.isError).toBe(false)
      expect(committed.data.head).not.toBe(aHeadBefore)
      expect(await f.git.getCurrentCommitHash(f.root)).toBe(rootHeadBefore)

      // Refusal on reference/root worktree
      const mainGrant = await f.grant(mainWt.worktreeId, ['EDIT_TEXT'], ['src/beta.ts'])
      const mainRefused = await f.call('edit_worktree_text', {
        ...mainGrant,
        operationId: 'op-main-refused',
        intent: { description: 'Cannot edit primary checkout' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: sha(readFileSync(join(f.root, 'src/beta.ts'))), replacements: [{ oldText: 'initial', newText: 'bad' }] }]
      })
      expect(mainRefused.isError).toBe(true)
      expect(mainRefused.data).toMatchObject({ code: 'WORKTREE_PRIMARY_PROTECTED' })
    } finally {
      await f.close()
    }
  }, 600_000)

  it('recovers safely from lost receipt ack, detects mid-batch external changes as PARTIAL, and refuses unauthorized scopes and concurrent mutations', async () => {
    const f = await createFixture()
    try {
      const discovered = (await f.call('discover_worktrees', {})).data.worktrees
      const wtA = discovered.find((w: any) => w.path === f.a)
      const wtB = discovered.find((w: any) => w.path === f.b)
      const inspectedA = (await f.call('inspect_worktree', { worktreeId: wtA.worktreeId })).data
      const readBeta = (await f.call('read_worktree_file', { worktreeId: wtA.worktreeId, path: 'src/beta.ts', startLine: 1, endLine: 1 })).data
      const readAlpha = (await f.call('read_worktree_file', { worktreeId: wtA.worktreeId, path: 'src/alpha.ts', startLine: 1, endLine: 3 })).data

      // Missing grant
      const noGrant = await f.call('edit_worktree_text', {
        worktreeId: wtA.worktreeId,
        generation: wtA.generation,
        leaseId: 'missing',
        leaseCredential: '1'.repeat(64),
        operationId: 'op-no-grant',
        snapshot: snap(inspectedA),
        intent: { description: 'No grant' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'x' }] }]
      })
      expect(noGrant.isError).toBe(true)
      expect(noGrant.data).toMatchObject({ code: 'WORKTREE_OWNERSHIP_REQUIRED' })

      // Grant without EDIT_TEXT intent
      const stageGrant = await f.grant(wtA.worktreeId, ['STAGE'], ['src/beta.ts'])
      const wrongIntent = await f.call('edit_worktree_text', {
        ...stageGrant,
        operationId: 'op-wrong-intent',
        intent: { description: 'Missing EDIT_TEXT' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'x' }] }]
      })
      expect(wrongIntent.isError).toBe(true)
      expect(wrongIntent.data).toMatchObject({ code: 'WORKTREE_INTENT_NOT_GRANTED' })
      const releasedStage = await f.call('handoff_worktree_for_git', { action: 'RELEASE', worktreeId: wtA.worktreeId, leaseId: stageGrant.leaseId, leaseCredential: stageGrant.leaseCredential })
      expect(releasedStage.isError).toBe(false)
      expect(releasedStage.data).toMatchObject({ state: 'RELEASED' })
      const afterRelease = await f.call('edit_worktree_text', {
        ...stageGrant,
        operationId: 'op-after-release',
        intent: { description: 'After release' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'bad' }] }]
      })
      expect(afterRelease.isError).toBe(true)
      expect(afterRelease.data).toMatchObject({ code: 'WORKTREE_RECOVERY_REQUIRED' })

      // Grant with EDIT_TEXT only for src/beta.ts: reject path out of scope, wrong generation, stale snapshot, protected branch
      const betaOnly = await f.grant(wtA.worktreeId, ['EDIT_TEXT'], ['src/beta.ts', 'src/alpha.ts'])
      const badGen = await f.call('edit_worktree_text', {
        ...betaOnly,
        generation: '9'.repeat(64),
        operationId: 'op-bad-gen',
        intent: { description: 'Wrong generation' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'x' }] }]
      })
      expect(badGen.isError).toBe(true)
      expect(badGen.data).toMatchObject({ code: 'WORKTREE_STALE' })

      const badSnap = await f.call('edit_worktree_text', {
        ...betaOnly,
        snapshot: { ...betaOnly.snapshot, worktreeRevision: '8'.repeat(64) },
        operationId: 'op-bad-snap',
        intent: { description: 'Stale snapshot' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'x' }] }]
      })
      expect(badSnap.isError).toBe(true)
      expect(badSnap.data).toMatchObject({ code: 'GIT_STATE_CHANGED' })

      // After failed pre-effect gate, recover grant for lost-ack test
      const recovered1 = await f.grant(wtA.worktreeId, ['EDIT_TEXT'], ['src/beta.ts'], true)
      const completeSpy = vi.spyOn(f.git, 'completeOperationReceipt').mockRejectedValueOnce(new Error('ack lost'))
      const lostAck = await f.call('edit_worktree_text', {
        ...recovered1,
        operationId: 'op-lost-ack',
        intent: { description: 'Simulate lost ack' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'once' }] }]
      })
      const betaOnce = readBeta.content.replace('initial', 'once')
      completeSpy.mockRestore()
      expect(lostAck.isError).toBe(true)
      expect(lostAck.data).toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN', operationId: 'op-lost-ack' })
      expect(readFileSync(join(f.a, 'src/beta.ts'), 'utf8')).toBe(betaOnce)

      // Replay of op-lost-ack must not re-apply
      const lostReplay = await f.call('edit_worktree_text', {
        ...recovered1,
        operationId: 'op-lost-ack',
        intent: { description: 'Simulate lost ack' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'once' }] }]
      })
      expect(lostReplay.isError).toBe(true)
      expect(lostReplay.data).toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN' })

      // Grant requires RECOVER after unknown outcome
      const needsRecover = await f.call('edit_worktree_text', {
        ...recovered1,
        operationId: 'op-needs-recover',
        intent: { description: 'Should require recovery' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: sha(betaOnce), replacements: [{ oldText: 'once', newText: 'twice' }] }]
      })
      expect(needsRecover.isError).toBe(true)
      expect(needsRecover.data).toMatchObject({ code: 'WORKTREE_RECOVERY_REQUIRED' })

      // External concurrent change mid-batch -> PARTIAL without rollback
      const recovered2 = await f.grant(wtA.worktreeId, ['EDIT_TEXT'], ['src/alpha.ts', 'src/beta.ts'], true)
      const outOfScope = await f.call('edit_worktree_text', {
        ...recovered2,
        operationId: 'op-out-of-scope',
        intent: { description: 'Path not in scope' },
        changes: [{ operation: 'CREATE', path: 'src/extra.ts', text: 'nope' }]
      })
      expect(outOfScope.isError).toBe(true)
      expect(outOfScope.data).toMatchObject({ code: 'WORKTREE_PATH_NOT_GRANTED' })

      const recovered3 = await f.grant(wtA.worktreeId, ['EDIT_TEXT'], ['src/alpha.ts', 'src/beta.ts'], true)
      const origExcluding = f.git.getWorktreeRevisionExcluding.bind(f.git)
      let excludingCalls = 0
      const excludingSpy = vi.spyOn(f.git, 'getWorktreeRevisionExcluding').mockImplementation(async (dir, excluded) => {
        excludingCalls++
        if (excludingCalls === 3) {
          writeFileSync(join(f.a, 'foreign.txt'), 'external-change')
        }
        return origExcluding(dir, excluded)
      })
      const partial = await f.call('edit_worktree_text', {
        ...recovered3,
        operationId: 'op-mid-batch-external',
        intent: { description: 'Detect external change mid-batch' },
        changes: [
          { operation: 'EDIT', path: 'src/alpha.ts', expectedSha256: readAlpha.fileRevision, replacements: [{ oldText: 'ação 😀', newText: 'first-done' }] },
          { operation: 'EDIT', path: 'src/beta.ts', expectedSha256: sha(betaOnce), replacements: [{ oldText: 'once', newText: 'second-blocked' }] }
        ]
      })
      excludingSpy.mockRestore()
      expect(partial.isError).toBe(true)
      expect(partial.data.state).toBe('PARTIAL')
      expect(partial.data.code).toBe('EDIT_PARTIAL')
      expect(partial.data.files[0]).toMatchObject({ path: 'src/alpha.ts', state: 'CONFIRMED' })
      expect(partial.data.files[1]).toMatchObject({ path: 'src/beta.ts', state: 'CONFLICT', code: 'GIT_STATE_CHANGED' })
      expect(readFileSync(join(f.a, 'src/alpha.ts'), 'utf8')).toContain('first-done')
      expect(readFileSync(join(f.a, 'src/beta.ts'), 'utf8')).toBe(betaOnce)
      expect(readFileSync(join(f.a, 'foreign.txt'), 'utf8')).toBe('external-change')

      // Protected branch refusal on secondary worktree checked out to main
      await gitExec(f.b, ['checkout', '-b', 'main'])
      const readBMain = (await f.call('read_worktree_file', { worktreeId: wtB.worktreeId, path: 'src/beta.ts', startLine: 1, endLine: 1 })).data
      const mainBranchGrant = await f.grant(wtB.worktreeId, ['EDIT_TEXT'], ['src/beta.ts'])
      const mainBranchRefused = await f.call('edit_worktree_text', {
        ...mainBranchGrant,
        operationId: 'op-main-branch-refused',
        intent: { description: 'Protected branch main' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBMain.fileRevision, replacements: [{ oldText: 'initial', newText: 'nope' }] }]
      })
      expect(mainBranchRefused.isError).toBe(true)
      expect(mainBranchRefused.data).toMatchObject({ code: 'WORKTREE_BRANCH_PROTECTED' })

      // Concurrent mutation lock
      const recovered4 = await f.grant(wtA.worktreeId, ['EDIT_TEXT'], ['src/beta.ts'], true)
      const [c1, c2] = await Promise.all([
        f.call('edit_worktree_text', {
          ...recovered4,
          operationId: 'op-concurrent-1',
          intent: { description: 'Concurrent 1' },
          changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: sha(betaOnce), replacements: [{ oldText: 'once', newText: 'win1' }] }]
        }),
        f.call('edit_worktree_text', {
          ...recovered4,
          operationId: 'op-concurrent-2',
          intent: { description: 'Concurrent 2' },
          changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: sha(betaOnce), replacements: [{ oldText: 'once', newText: 'win2' }] }]
        })
      ])
      const successes = [c1, c2].filter(r => !r.isError)
      const failures = [c1, c2].filter(r => r.isError)
      expect(successes).toHaveLength(1)
      expect(failures).toHaveLength(1)
      expect(['WORKTREE_TRANSACTION_BUSY', 'GIT_STATE_CHANGED', 'FILE_REVISION_CONFLICT', 'WORKTREE_RECOVERY_REQUIRED']).toContain(failures[0].data.code)
    } finally {
      await f.close()
    }
  }, 600_000)
})
