import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'

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

async function createFixture(options: { approve?: WorktreeApprovalPort; repositoryId?: string; readOnlyWorktree?: boolean } = {}) {
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
  const repositoryId = options.repositoryId ?? 'repo-code-editing'
  const service = new GitOperationsService(
    root,
    git,
    new GitHubGitTransport(null, git),
    { repositoryId: 'repo-code-editing', isActive: () => active },
    options.readOnlyWorktree ?? false,
    async request => {
      approvalCalls++
      if (!options.approve) throw new Error('APPROVAL_MUST_NOT_BE_CALLED')
      return options.approve(request)
    }
  )
  const adapter = new ChannelMcpAdapter({
    projectId: 'repo-code-editing',
    repoRoot: root,
    navigation: {} as ProjectContextNavigation,
    gitOperations: service
  })
  const server = createMcpHttpServer(
    adapter,
    () => {},
    undefined,
    undefined,
    (headers, connected) => {
      const wtHeader = typeof headers['x-test-worktree'] === 'string' ? headers['x-test-worktree'] : undefined
      return authorizeArtifactAgent(authenticatedAgentPrincipal('MCP', connected), repositoryId, connected, wtHeader)
    }
  )
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing port')

  const rpc = async (method: string, params: unknown, extraHeaders: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close', ...extraHeaders },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
    return (await response.json() as { result: any }).result
  }
  const callRaw = (name: string, args: unknown, extraHeaders?: Record<string, string>) => rpc('tools/call', { name, arguments: args }, extraHeaders)
  const call = async (name: string, args: unknown, extraHeaders?: Record<string, string>) => {
    const res = await callRaw(name, args, extraHeaders)
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

describe('autonomous worktree text editing through real MCP HTTP', () => {
  it('edits two files and creates one file autonomously without lease or approval, preserves sibling/HEAD/index, replays idempotently, and repeats cleanly', async () => {
    const f = await createFixture() // approve throws if invoked!
    try {
      const catalog = await f.rpc('tools/list', {})
      const tool = catalog.tools.find((t: { name: string }) => t.name === 'edit_worktree_text')
      expect(tool).toBeDefined()
      expect(tool.inputSchema.required).not.toContain('leaseId')
      expect(tool.inputSchema.required).not.toContain('leaseCredential')

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

      const inspectedA = (await f.call('inspect_worktree', { worktreeId: wtA.worktreeId })).data
      const readAlpha = (await f.call('read_worktree_file', { worktreeId: wtA.worktreeId, path: 'src/alpha.ts', startLine: 1, endLine: 3 })).data
      const readBeta = (await f.call('read_worktree_file', { worktreeId: wtA.worktreeId, path: 'src/beta.ts', startLine: 1, endLine: 1 })).data
      expect(readAlpha.revisionKind).toBe('FILE_BYTES_SHA256')

      // Decisive negative without lease: stale hash in item 2 refuses whole batch without touching disk
      const rejected = await f.call('edit_worktree_text', {
        worktreeId: wtA.worktreeId,
        generation: wtA.generation,
        snapshot: snap(inspectedA),
        operationId: 'op-auto-stale',
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
      expect(f.getApprovalCalls()).toBe(0)

      // Autonomous batch: edit 2 files + create 1 file without leaseId/leaseCredential/handoff/Plan binding
      const applyArgs = {
        worktreeId: wtA.worktreeId,
        generation: wtA.generation,
        snapshot: snap(inspectedA),
        operationId: 'op-auto-1',
        intent: { description: 'Autonomous edit alpha/beta and create alpha.test.ts' },
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
        operationId: 'op-auto-1',
        replayed: false
      })
      expect(applied.data.files).toHaveLength(3)
      expect(applied.data.diff.patch).toContain('+export const label = "revisão ✅"')
      expect(applied.data.diff.bytes).toBeLessThanOrEqual(8192)
      expect(f.getApprovalCalls()).toBe(0)

      const rereadAlpha = (await f.call('read_worktree_file', { worktreeId: wtA.worktreeId, path: 'src/alpha.ts', startLine: 1, endLine: 3 })).data
      expect(rereadAlpha.fileRevision).toBe(applied.data.files[0].afterSha256)
      expect(rereadAlpha.content).toBe('// Alpha\r\nexport const label = "revisão ✅"\r\nexport const keep = 1\r\n')
      expect(readFileSync(join(f.a, 'src/alpha.test.ts'), 'utf8')).toBe('export const tested = true\n')

      // Isolation: root and agent-b untouched; agent-a HEAD and index untouched
      expect(await f.git.getCurrentCommitHash(f.root)).toBe(rootHeadBefore)
      expect(await f.git.getIndexRevision(f.root)).toBe(rootIndexBefore)
      expect(await f.git.getCurrentCommitHash(f.a)).toBe(aHeadBefore)
      expect(await f.git.getIndexRevision(f.a)).toBe(aIndexBefore)
      expect(await f.git.getCurrentCommitHash(f.b)).toBe(bHeadBefore)
      expect(await f.git.getIndexRevision(f.b)).toBe(bIndexBefore)
      expect(readFileSync(join(f.b, 'src/alpha.ts'), 'utf8')).toBe(readAlpha.content)
      expect(existsSync(join(f.b, 'src/alpha.test.ts'))).toBe(false)

      // Replay and IDEMPOTENCY_CONFLICT
      const replayed = await f.call('edit_worktree_text', applyArgs)
      expect(replayed.isError).toBe(false)
      expect(replayed.data).toMatchObject({ state: 'APPLIED', replayed: true, diff: { omitted: 'REPLAY' } })

      const divergent = await f.call('edit_worktree_text', { ...applyArgs, intent: { description: 'divergent' } })
      expect(divergent.isError).toBe(true)
      expect(divergent.data).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

      // Second consecutive autonomous edit with updated snapshot/hash (still 0 approvals)
      const second = await f.call('edit_worktree_text', {
        worktreeId: wtA.worktreeId,
        generation: wtA.generation,
        snapshot: applied.data.snapshot,
        operationId: 'op-auto-2',
        intent: { description: 'Second autonomous edit' },
        changes: [
          { operation: 'EDIT', path: 'src/beta.ts', expectedSha256: applied.data.files[1].afterSha256, replacements: [{ oldText: 'v2', newText: 'v3' }] }
        ]
      })
      expect(second.isError).toBe(false)
      expect(second.data.state).toBe('APPLIED')
      expect(readFileSync(join(f.a, 'src/beta.ts'), 'utf8')).toBe(readBeta.content.replace('initial', 'v3'))
      expect(f.getApprovalCalls()).toBe(0)

      // Refusal on reference/root worktree without approval
      const inspectedMain = (await f.call('inspect_worktree', { worktreeId: mainWt.worktreeId })).data
      const mainRefused = await f.call('edit_worktree_text', {
        worktreeId: mainWt.worktreeId,
        generation: mainWt.generation,
        snapshot: snap(inspectedMain),
        operationId: 'op-main-refused',
        intent: { description: 'Cannot edit primary checkout' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: sha(readFileSync(join(f.root, 'src/beta.ts'))), replacements: [{ oldText: 'initial', newText: 'bad' }] }]
      })
      expect(mainRefused.isError).toBe(true)
      expect(mainRefused.data).toMatchObject({ code: 'WORKTREE_PRIMARY_PROTECTED' })
      expect(f.getApprovalCalls()).toBe(0)

      // Expired legacy grant from a prior runtime instance (UNKNOWN_OR_STALE) auto-reconciles to RELEASED without approval
      const commonDir = await f.git.getCommonDirectory(f.root)
      const ownershipDir = join(commonDir, 'code-awareness-worktree-ownership')
      mkdirSync(ownershipDir, { recursive: true })
      const staleGrantFile = join(ownershipDir, `${wtA.worktreeId}.json`)
      const inspectedBeforeStale = (await f.call('inspect_worktree', { worktreeId: wtA.worktreeId })).data
      writeFileSync(staleGrantFile, JSON.stringify({
        instanceId: 'prior-restarted-instance',
        requestId: 'stale-req-1',
        observation: {
          repositoryId: 'repo-code-editing',
          commonDirectory: commonDir,
          administrativeDirectory: await f.git.getWorktreeDirectory(f.a),
          worktreeId: wtA.worktreeId,
          generation: wtA.generation,
          path: wtA.path,
          snapshot: snap(inspectedBeforeStale),
          contentRevision: '1'.repeat(64)
        },
        scope: { operations: ['STAGE'], paths: ['src/beta.ts'], branches: [] },
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        credentialHash: '2'.repeat(64),
        state: 'GRANTED'
      }))
      const afterStaleReconcile = await f.call('edit_worktree_text', {
        worktreeId: wtA.worktreeId,
        generation: wtA.generation,
        snapshot: snap(inspectedBeforeStale),
        operationId: 'op-auto-stale-grant',
        intent: { description: 'Auto-reconcile expired grant' },
        changes: [
          { operation: 'EDIT', path: 'src/beta.ts', expectedSha256: second.data.files[0].afterSha256, replacements: [{ oldText: 'v3', newText: 'v4' }] }
        ]
      })
      expect(afterStaleReconcile.isError).toBe(false)
      expect(afterStaleReconcile.data.state).toBe('APPLIED')
      expect(JSON.parse(readFileSync(staleGrantFile, 'utf8'))).toMatchObject({
        state: 'RELEASED',
        reconciliationReason: 'EXPIRED_AUTONOMOUS_RECONCILIATION'
      })
      expect(f.getApprovalCalls()).toBe(0)
    } finally {
      await f.close()
    }
  }, 600_000)

  it('enforces channel write access, authority scope, protected branch, active incompatible grant, concurrency, lost ack, and PARTIAL drift', async () => {
    const f = await createFixture({ approve: async () => true })
    const fReadOnly = await createFixture({ readOnlyWorktree: true })
    const fWrongRepo = await createFixture({ repositoryId: 'other-repo' })
    try {
      const discovered = (await f.call('discover_worktrees', {})).data.worktrees
      const wtA = discovered.find((w: any) => w.path === f.a)
      const wtB = discovered.find((w: any) => w.path === f.b)
      const inspectedA = (await f.call('inspect_worktree', { worktreeId: wtA.worktreeId })).data
      const readBeta = (await f.call('read_worktree_file', { worktreeId: wtA.worktreeId, path: 'src/beta.ts', startLine: 1, endLine: 1 })).data
      const readAlpha = (await f.call('read_worktree_file', { worktreeId: wtA.worktreeId, path: 'src/alpha.ts', startLine: 1, endLine: 3 })).data

      // Read-only channel refusal
      const roWtA = (await fReadOnly.call('discover_worktrees', {})).data.worktrees.find((w: any) => w.path === fReadOnly.a)
      const roInspected = (await fReadOnly.call('inspect_worktree', { worktreeId: roWtA.worktreeId })).data
      const roRes = await fReadOnly.call('edit_worktree_text', {
        worktreeId: roWtA.worktreeId,
        generation: roWtA.generation,
        snapshot: snap(roInspected),
        operationId: 'op-ro',
        intent: { description: 'Read-only channel' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'x' }] }]
      })
      expect(roRes.isError).toBe(true)
      expect(roRes.data).toMatchObject({ code: 'WORKTREE_OWNERSHIP_REQUIRED' })
      expect(readFileSync(join(fReadOnly.a, 'src/beta.ts'), 'utf8')).toBe(readBeta.content)

      // ChannelMcpAdapter without gitOperations refusal
      const noGitAdapter = new ChannelMcpAdapter({ projectId: 'p', repoRoot: f.root, navigation: {} as ProjectContextNavigation })
      expect(noGitAdapter.listTools().some(t => t.name === 'edit_worktree_text')).toBe(false)
      expect(await noGitAdapter.callTool('edit_worktree_text', {})).toMatchObject({ isError: true, content: [{ text: 'GIT_OPERATIONS_UNAVAILABLE' }] })

      // Wrong repository authority & mismatched worktree authority
      const wrongRepoWt = (await fWrongRepo.call('discover_worktrees', {})).data.worktrees.find((w: any) => w.path === fWrongRepo.a)
      const wrongRepoInsp = (await fWrongRepo.call('inspect_worktree', { worktreeId: wrongRepoWt.worktreeId })).data
      const wrongRepoRes = await fWrongRepo.call('edit_worktree_text', {
        worktreeId: wrongRepoWt.worktreeId,
        generation: wrongRepoWt.generation,
        snapshot: snap(wrongRepoInsp),
        operationId: 'op-wrong-repo',
        intent: { description: 'Wrong repo authority' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'x' }] }]
      })
      expect(wrongRepoRes.isError).toBe(true)
      expect(wrongRepoRes.data).toMatchObject({ code: 'REPOSITORY_MISMATCH' })

      const scopedConflict = await f.call('edit_worktree_text', {
        worktreeId: wtA.worktreeId,
        generation: wtA.generation,
        snapshot: snap(inspectedA),
        operationId: 'op-scope-conflict',
        intent: { description: 'Wrong worktree scope' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'x' }] }]
      }, { 'x-test-worktree': wtB.worktreeId })
      expect(scopedConflict.isError).toBe(true)
      expect(scopedConflict.data).toMatchObject({ code: 'DELIVERY_CONTEXT_INVALID', reason: 'WORKTREE_SCOPE_CONFLICT' })

      // Wrong generation & stale snapshot
      const badGen = await f.call('edit_worktree_text', {
        worktreeId: wtA.worktreeId,
        generation: '9'.repeat(64),
        snapshot: snap(inspectedA),
        operationId: 'op-bad-gen',
        intent: { description: 'Wrong generation' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'x' }] }]
      })
      expect(badGen.isError).toBe(true)
      expect(badGen.data).toMatchObject({ code: 'WORKTREE_STALE' })

      const badSnap = await f.call('edit_worktree_text', {
        worktreeId: wtA.worktreeId,
        generation: wtA.generation,
        snapshot: { ...snap(inspectedA), worktreeRevision: '8'.repeat(64) },
        operationId: 'op-bad-snap',
        intent: { description: 'Stale snapshot' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'x' }] }]
      })
      expect(badSnap.isError).toBe(true)
      expect(badSnap.data).toMatchObject({ code: 'GIT_STATE_CHANGED' })

      // Active incompatible worktree grant (STAGE) blocks autonomous edit without stealing grant
      const stageGrant = await f.grant(wtA.worktreeId, ['STAGE'], ['src/beta.ts'])
      const blockedByGrant = await f.call('edit_worktree_text', {
        worktreeId: wtA.worktreeId,
        generation: wtA.generation,
        snapshot: snap(inspectedA),
        operationId: 'op-blocked-by-grant',
        intent: { description: 'Blocked by active STAGE grant' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'x' }] }]
      })
      expect(blockedByGrant.isError).toBe(true)
      expect(blockedByGrant.data).toMatchObject({ code: 'WORKTREE_OWNERSHIP_REQUIRED' })
      expect(readFileSync(join(f.a, 'src/beta.ts'), 'utf8')).toBe(readBeta.content)

      // Invalid legacy credential never falls back to autonomous path
      const badLegacyCred = await f.call('edit_worktree_text', {
        worktreeId: wtA.worktreeId,
        generation: wtA.generation,
        leaseId: stageGrant.leaseId,
        leaseCredential: '0'.repeat(64),
        snapshot: snap(inspectedA),
        operationId: 'op-bad-legacy-cred',
        intent: { description: 'Bad legacy cred' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'x' }] }]
      })
      expect(badLegacyCred.isError).toBe(true)
      expect(badLegacyCred.data).toMatchObject({ code: 'WORKTREE_OWNERSHIP_REQUIRED' })
      await f.call('handoff_worktree_for_git', { action: 'RELEASE', worktreeId: wtA.worktreeId, leaseId: stageGrant.leaseId, leaseCredential: stageGrant.leaseCredential })

      // Lost ack recovery
      const completeSpy = vi.spyOn(f.git, 'completeOperationReceipt').mockRejectedValueOnce(new Error('ack lost'))
      const lostAck = await f.call('edit_worktree_text', {
        worktreeId: wtA.worktreeId,
        generation: wtA.generation,
        snapshot: snap(inspectedA),
        operationId: 'op-lost-ack',
        intent: { description: 'Simulate lost ack' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'once' }] }]
      })
      const betaOnce = readBeta.content.replace('initial', 'once')
      completeSpy.mockRestore()
      expect(lostAck.isError).toBe(true)
      expect(lostAck.data).toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN', operationId: 'op-lost-ack' })
      expect(readFileSync(join(f.a, 'src/beta.ts'), 'utf8')).toBe(betaOnce)

      const lostReplay = await f.call('edit_worktree_text', {
        worktreeId: wtA.worktreeId,
        generation: wtA.generation,
        snapshot: snap(inspectedA),
        operationId: 'op-lost-ack',
        intent: { description: 'Simulate lost ack' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBeta.fileRevision, replacements: [{ oldText: 'initial', newText: 'once' }] }]
      })
      expect(lostReplay.isError).toBe(true)
      expect(lostReplay.data).toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN' })

      // Mid-batch external drift -> PARTIAL without rollback (content change with identical porcelain status '?? foreign.txt')
      writeFileSync(join(f.a, 'foreign.txt'), 'external-v1')
      const inspectedAfterOnce = (await f.call('inspect_worktree', { worktreeId: wtA.worktreeId })).data
      const origCaptureEdit = f.git.captureWorktreeEditObservation.bind(f.git)
      let captureCalls = 0
      const captureSpy = vi.spyOn(f.git, 'captureWorktreeEditObservation').mockImplementation(async (dir, excluded, opts) => {
        captureCalls++
        if (captureCalls === 3) {
          writeFileSync(join(f.a, 'foreign.txt'), 'external-v2')
        }
        return origCaptureEdit(dir, excluded, opts)
      })
      const partial = await f.call('edit_worktree_text', {
        worktreeId: wtA.worktreeId,
        generation: wtA.generation,
        snapshot: snap(inspectedAfterOnce),
        operationId: 'op-mid-batch-external',
        intent: { description: 'Detect external content change mid-batch' },
        changes: [
          { operation: 'EDIT', path: 'src/alpha.ts', expectedSha256: readAlpha.fileRevision, replacements: [{ oldText: 'ação 😀', newText: 'first-done' }] },
          { operation: 'EDIT', path: 'src/beta.ts', expectedSha256: sha(betaOnce), replacements: [{ oldText: 'once', newText: 'second-blocked' }] }
        ]
      })
      captureSpy.mockRestore()
      expect(partial.isError).toBe(true)
      expect(partial.data.state).toBe('PARTIAL')
      expect(partial.data.code).toBe('EDIT_PARTIAL')
      expect(partial.data.files[0]).toMatchObject({ path: 'src/alpha.ts', state: 'CONFIRMED' })
      expect(partial.data.files[1]).toMatchObject({ path: 'src/beta.ts', state: 'CONFLICT', code: 'GIT_STATE_CHANGED' })
      expect(readFileSync(join(f.a, 'src/alpha.ts'), 'utf8')).toContain('first-done')
      expect(readFileSync(join(f.a, 'src/beta.ts'), 'utf8')).toBe(betaOnce)
      expect(readFileSync(join(f.a, 'foreign.txt'), 'utf8')).toBe('external-v2')

      // Protected branch refusal on secondary worktree checked out to main
      await gitExec(f.b, ['checkout', '-b', 'main'])
      const inspectedBMain = (await f.call('inspect_worktree', { worktreeId: wtB.worktreeId })).data
      const readBMain = (await f.call('read_worktree_file', { worktreeId: wtB.worktreeId, path: 'src/beta.ts', startLine: 1, endLine: 1 })).data
      const mainBranchRefused = await f.call('edit_worktree_text', {
        worktreeId: wtB.worktreeId,
        generation: wtB.generation,
        snapshot: snap(inspectedBMain),
        operationId: 'op-main-branch-refused',
        intent: { description: 'Protected branch main' },
        changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: readBMain.fileRevision, replacements: [{ oldText: 'initial', newText: 'nope' }] }]
      })
      expect(mainBranchRefused.isError).toBe(true)
      expect(mainBranchRefused.data).toMatchObject({ code: 'WORKTREE_BRANCH_PROTECTED' })

      // Concurrent autonomous mutations
      const inspectedBeforeConcurrent = (await f.call('inspect_worktree', { worktreeId: wtA.worktreeId })).data
      const [c1, c2] = await Promise.all([
        f.call('edit_worktree_text', {
          worktreeId: wtA.worktreeId,
          generation: wtA.generation,
          snapshot: snap(inspectedBeforeConcurrent),
          operationId: 'op-concurrent-1',
          intent: { description: 'Concurrent 1' },
          changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: sha(betaOnce), replacements: [{ oldText: 'once', newText: 'win1' }] }]
        }),
        f.call('edit_worktree_text', {
          worktreeId: wtA.worktreeId,
          generation: wtA.generation,
          snapshot: snap(inspectedBeforeConcurrent),
          operationId: 'op-concurrent-2',
          intent: { description: 'Concurrent 2' },
          changes: [{ operation: 'EDIT', path: 'src/beta.ts', expectedSha256: sha(betaOnce), replacements: [{ oldText: 'once', newText: 'win2' }] }]
        })
      ])
      const successes = [c1, c2].filter(r => !r.isError)
      const failures = [c1, c2].filter(r => r.isError)
      expect(successes).toHaveLength(1)
      expect(failures).toHaveLength(1)
      expect(['WORKTREE_TRANSACTION_BUSY', 'GIT_STATE_CHANGED', 'FILE_REVISION_CONFLICT']).toContain(failures[0].data.code)
    } finally {
      await f.close()
      await fReadOnly.close()
      await fWrongRepo.close()
    }
  }, 600_000)
})
