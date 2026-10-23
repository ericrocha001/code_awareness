import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { RuntimePreviewOperations, previewRequestSchema } from './operations'

function setup() {
  const tree = { worktreeId: 'tree', generation: 'generation', path: 'checkout', branch: 'topic', head: 'head', detached: false, locked: false, missing: false, prunable: false }
  const branch = { repositoryId: 'repo', ref: 'refs/heads/topic', name: 'topic', namespace: 'LOCAL', revision: 'revision', generation: 'branch-generation', head: 'head', worktrees: [{ worktreeId: 'tree', generation: 'generation' }] }
  const inventory = { branches: [branch], worktrees: [tree] }
  const git = { getBranchInventory: vi.fn(async () => inventory), getCoordinationIdentity: vi.fn(async () => ({ repositoryId: 'repo', record: tree })) }
  const repositories = { open: vi.fn(async () => ({ git, guard: vi.fn() })) }
  const profile = { profileId: 'auto', repositoryId: 'repo', revision: 1 }, resolver = { resolve: vi.fn(async () => profile) }
  let approved = false
  const confirm = vi.fn(async () => true), profiles = { approved: vi.fn(async () => approved), approve: vi.fn(async (_p: unknown, ask: () => Promise<boolean>, guard: () => void) => { if (!await ask()) throw Error('PROFILE_APPROVAL_REQUIRED'); guard(); approved = true }) }
  const record = { sessionId: randomUUID(), state: 'RUNNING', resources: 'RESERVED', observation: 'CURRENT', coverage: [], selection: { repositoryId: 'repo', worktreeId: 'tree', generation: 'generation' }, sourceSnapshot: { branch: 'topic', head: 'head' } }
  const store = { list: vi.fn(() => [] as unknown[]) }, runner = { start: vi.fn(async (input: any) => { await input.guard(); return { ...record, operationId: input.operationId } }) }
  const service = new RuntimePreviewOperations(repositories as any, profiles as any, store as any, runner as any, confirm, undefined, undefined, resolver as any)
  const check = vi.spyOn(service as any, 'check').mockResolvedValue({ kind: 'PREFLIGHT', preflight: { status: 'UNKNOWN', diagnostics: [{ reasonCode: 'ABI_UNVERIFIED' }] }, startAllowed: true })
  const request = { action: 'RUN_BRANCH_APP' as const, repositoryId: 'repo', ref: branch.ref, revision: branch.revision, operationId: randomUUID() }
  const run = async (value = request) => { const pending = await service.handle(value); return (await service.pendingResult()) ?? pending }
  return { service, run, request, tree, branch, inventory, repositories, resolver, confirm, profiles, record, store, runner, check }
}

describe('branch application intent — domain fixtures, no simulated Windows evidence', () => {
  it('resolves exact branch, authorizes and preflights internally before one launch', async () => {
    const f = setup(); expect(await f.run()).toMatchObject({ success: true, data: { kind: 'SESSION', session: { state: 'RUNNING' } } })
    expect(f.resolver.resolve).toHaveBeenCalledWith('repo', 'tree', 'checkout'); expect(f.check).toHaveBeenCalledTimes(2)
    expect(f.confirm).toHaveBeenCalledTimes(1); expect(f.runner.start).toHaveBeenCalledTimes(1)
    await f.run(); expect(f.runner.start).toHaveBeenCalledTimes(1)
  })
  it('cancellation starts nothing and replay does not reopen approval', async () => {
    const f = setup(); f.confirm.mockResolvedValue(false)
    expect(await f.run()).toMatchObject({ data: { kind: 'BRANCH_APP', reasonCode: 'PROFILE_APPROVAL_REQUIRED' } })
    await f.run(); expect(f.confirm).toHaveBeenCalledTimes(1); expect(f.runner.start).not.toHaveBeenCalled()
  })
  it.each(['TRACKING', 'NO_CHECKOUT'])('does not invent a checkout for %s', async kind => {
    const f = setup(); if (kind === 'TRACKING') f.branch.namespace = 'TRACKING'; else f.branch.worktrees = []
    expect(await f.run()).toMatchObject({ data: { reasonCode: 'BRANCH_CHECKOUT_REQUIRED' } }); expect(f.resolver.resolve).not.toHaveBeenCalled()
  })
  it('returns bounded explicit candidates for ambiguity and refuses a foreign selection', async () => {
    const f = setup(), other = { ...f.tree, worktreeId: 'other' }; f.inventory.worktrees.push(other); f.branch.worktrees.push(other)
    expect(await f.run()).toMatchObject({ data: { reasonCode: 'BRANCH_CHECKOUT_AMBIGUOUS', candidates: [f.tree, other] } })
    expect(f.resolver.resolve).not.toHaveBeenCalled()
    expect(await f.run({ ...f.request, operationId: randomUUID(), worktree: { worktreeId: 'foreign', generation: 'generation' } } as any)).toMatchObject({ success: false, code: 'WORKTREE_STALE' })
  })
  it.each(['revision', 'head', 'generation'])('rejects concurrent %s change during approval', async field => {
    const f = setup(); f.confirm.mockImplementation(async () => { if (field === 'generation') f.tree.generation = 'changed'; else (f.branch as any)[field] = 'changed'; return true })
    expect(await f.run()).toMatchObject({ success: false }); expect(f.runner.start).not.toHaveBeenCalled()
  })
  it('keeps security diagnostics and never approves a blocked profile', async () => {
    const f = setup(), preflight = { status: 'INCOMPATIBLE', diagnostics: [{ reasonCode: 'SECURITY_ISOLATION_UNAVAILABLE', missingRequirements: ['enforcement'] }] }
    f.check.mockResolvedValue({ kind: 'PREFLIGHT', preflight, startAllowed: false })
    expect(await f.run()).toMatchObject({ data: { reasonCode: 'APP_PREFLIGHT_BLOCKED', preflight } }); expect(f.confirm).not.toHaveBeenCalled(); expect(f.runner.start).not.toHaveBeenCalled()
  })
  it('does not stop an occupied preview or ask for another approval', async () => {
    const f = setup(); f.store.list.mockReturnValue([f.record])
    expect(await f.run()).toMatchObject({ data: { reasonCode: 'PREVIEW_SESSION_ACTIVE' } }); expect(f.confirm).not.toHaveBeenCalled(); expect(f.runner.start).not.toHaveBeenCalled()
  })
  it('does not hide launch failure behind app readiness', async () => {
    const f = setup(); f.runner.start.mockRejectedValue(Error('JOB_ASSIGNMENT_FAILURE'))
    expect(await f.run()).toMatchObject({ success: false, code: 'JOB_ASSIGNMENT_FAILURE' })
  })
  it('does not allow arbitrary commands or replacement of an operation identity', async () => {
    const f = setup(); expect(previewRequestSchema.safeParse({ ...f.request, command: 'shell' }).success).toBe(false)
    await f.run(); expect(await f.run({ ...f.request, ref: 'refs/heads/other' })).toMatchObject({ success: false, code: 'OPERATION_ID_CONFLICT' })
  })
})
