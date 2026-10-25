import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { RuntimePreviewOperations, previewRequestSchema } from './operations'
import { PreviewSessionStore, type PreviewSessionRecord } from './session-store'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeRuntimePreviewTool } from './mcp'
import { previewStatus } from './status'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }) })
function setup(durable = false) {
  const tree = { worktreeId: 'tree', generation: 'generation', path: 'checkout', branch: 'topic', head: 'head', detached: false, locked: false, missing: false, prunable: false }
  const branch = { repositoryId: 'repo', ref: 'refs/heads/topic', name: 'topic', namespace: 'LOCAL', revision: 'revision', generation: 'branch-generation', head: 'head', worktrees: [{ worktreeId: 'tree', generation: 'generation' }] }
  const inventory = { branches: [branch], worktrees: [tree] }
  const git = { getBranchInventory: vi.fn(async () => inventory), getCoordinationIdentity: vi.fn(async () => ({ repositoryId: 'repo', record: tree })) }
  const repositories = { open: vi.fn(async () => ({ git, guard: vi.fn() })), resolve: vi.fn(() => ({ guard() {} })) }
  const profile = { profileId: 'auto', repositoryId: 'repo', revision: 1 }, resolver = { resolve: vi.fn(async () => profile) }
  let approved = false
  const confirm = vi.fn(async () => true), profiles = { approved: vi.fn(async () => approved), approve: vi.fn(async (_p: unknown, ask: () => Promise<boolean>, guard: () => void) => { if (!await ask()) throw Error('PROFILE_APPROVAL_REQUIRED'); guard(); approved = true }) }
  const at = new Date().toISOString()
  const record: PreviewSessionRecord = { schemaVersion: 1, persistence: 'PERSISTED', sessionId: randomUUID(), operationId: randomUUID(), state: 'RUNNING', resources: 'RESERVED',
    selection: { repositoryId: 'repo', worktreeId: 'tree', generation: 'generation', profileId: 'auto', fingerprint: 'a'.repeat(64) },
    sourceSnapshot: { branch: 'topic', head: 'a'.repeat(40), indexRevision: 'index', worktreeRevision: 'source', dirty: false },
    profileRevision: 1, gitFingerprint: 'source', revision: 0, at, startedAt: at, endedAt: null, reconciliation: 'NOT_REQUIRED', failure: null,
    readiness: 'READY', liveness: 'VERIFIED', attestation: { artifact: 'VERIFIED', loadedCode: 'VERIFIED' },
    process: { pid: 123, created: '100', rootSignaled: false, knownHandlesClosed: false, activeProcesses: 3, jobClosed: false, eventClosed: false, assignedAtCreation: true, ownerOutsideJob: true, phase: 'RUNNING' },
    coverage: ['TARGET_CHECKOUT', 'ENDPOINT', 'BEHAVIOR'].map(stage => ({ stage, component: 'TARGET', status: stage === 'BEHAVIOR' ? 'NOT_OBSERVED' : 'VERIFIED', fingerprint: null, evidenceRef: null, at, reasonCode: 'fixture' })) as PreviewSessionRecord['coverage'],
    resourceInventory: [], recoveryObservation: null, shutdown: { graceMs: 0, forceMs: 1000, graceful: false } }
  let store: any = { list: vi.fn(() => [] as unknown[]) }
  if (durable) { const directory = mkdtempSync(join(tmpdir(), 'branch-intent-')); directories.push(directory); store = new PreviewSessionStore(directory) }
  const runner = { owns: vi.fn(() => true), inspect: vi.fn(), stop: vi.fn(), start: vi.fn(async (input: any) => { await input.guard(); const value = { ...record, selection: input.selection, operationId: input.operationId }; if (durable) store.reserve(value); return value }) }
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

describe('agent intent and durable compact status', () => {
  const intent = () => ({ repositoryId: 'repo', branch: 'topic', operationId: randomUUID() })
  it('uses the UI executor, preserves native consent and recovers exact identity without history output', async () => {
    const f = setup(true), input = intent()
    expect(await executeRuntimePreviewTool(f.service, 'run_branch_app', input, () => {})).toMatchObject({ structuredContent: { data: { phase: 'PREPARING', ready: false } }, content: [] })
    await f.service.pendingResult()
    const status = await f.service.getStatus({ operationId: input.operationId })
    expect(status).toMatchObject({ data: { phase: 'RUNNING', ready: true, branch: 'topic', head: 'a'.repeat(40), worktreeId: 'tree', recommendedAction: 'ASK_HUMAN_REVIEW' } })
    expect(f.confirm).toHaveBeenCalledTimes(1); expect(f.check).toHaveBeenCalledTimes(2); expect(f.runner.start).toHaveBeenCalledTimes(1)
    expect(f.runner.inspect).not.toHaveBeenCalled()
    expect(JSON.stringify(status)).not.toMatch(/coverage|qualifications|lastOperation|sourceSnapshot|checkout|VALIDATED/)
    expect(await f.service.getStatus({ operationId: input.operationId })).toEqual(status)
    await f.service.runBranchApp(input); expect(f.runner.start).toHaveBeenCalledTimes(1)
    expect(await f.service.runBranchApp({ ...input, branch: 'other' })).toMatchObject({ success: false, code: 'OPERATION_ID_CONFLICT' })
  })
  it.each(['missing', 'head', 'cancel', 'changed', 'ambiguous', 'preflight', 'active'])('refuses %s before a second launch and preserves the refusal after restart', async kind => {
    const f = setup(true), input = intent()
    if (kind === 'missing') f.branch.worktrees = []
    if (kind === 'head') Object.assign(input, { expectedHead: 'b'.repeat(40) })
    if (kind === 'cancel') f.confirm.mockResolvedValue(false)
    if (kind === 'changed') f.confirm.mockImplementation(async () => { f.branch.head = 'changed'; return true })
    if (kind === 'ambiguous') { const other = { ...f.tree, worktreeId: 'other' }; f.inventory.worktrees.push(other); f.branch.worktrees.push(other) }
    if (kind === 'preflight') f.check.mockResolvedValue({ preflight: { diagnostics: [{ reasonCode: 'SECURITY_ISOLATION_UNAVAILABLE' }] }, startAllowed: false } as any)
    if (kind === 'active') f.store.reserve(f.record)
    await f.service.runBranchApp(input); await f.service.pendingResult()
    expect(await f.service.getStatus({ operationId: input.operationId })).toMatchObject({ data: { phase: 'BLOCKED', ready: false } })
    const restarted = new RuntimePreviewOperations(f.repositories as any, {} as any, new PreviewSessionStore(f.store.root), f.runner as any, f.confirm)
    expect(await restarted.runBranchApp(input)).toMatchObject({ data: { phase: 'BLOCKED', ready: false } })
    expect(f.runner.start).not.toHaveBeenCalled()
  })
  it('requires an exact ref and validates a selected checkout authoritatively', async () => {
    const f = setup(true), input = intent()
    await f.service.runBranchApp({ ...input, branch: 'top' }); await f.service.pendingResult()
    expect(await f.service.getStatus({ operationId: input.operationId })).toMatchObject({ data: { reasonCode: 'BRANCH_NOT_FOUND' } })
    const other = { ...f.tree, worktreeId: 'other' }; f.inventory.worktrees.push(other); f.branch.worktrees.push(other)
    const selected = { ...intent(), worktreeId: 'other' }
    await f.service.runBranchApp(selected); await f.service.pendingResult()
    expect(f.resolver.resolve).toHaveBeenCalledWith('repo', 'other', 'checkout')
    expect(f.runner.start).toHaveBeenCalledTimes(1)
  })
  it('retains uncertain interrupted operations, forbids a new start and never restores READY after restart', async () => {
    const f = setup(true), input = intent()
    let release!: () => void
    f.repositories.open.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ git: { getBranchInventory: async () => f.inventory } as any, guard: vi.fn() }) }))
    await f.service.runBranchApp(input)
    expect(await f.service.runBranchApp(intent())).toMatchObject({ code: 'PREVIEW_OPERATION_BUSY' })
    const restarted = new RuntimePreviewOperations(f.repositories as any, {} as any, new PreviewSessionStore(f.store.root), { owns: () => false } as any, f.confirm)
    expect(await restarted.runBranchApp(input)).toMatchObject({ data: { phase: 'UNKNOWN', ready: false, reasonCode: 'OPERATION_INTERRUPTED' } })
    expect(await restarted.runBranchApp(intent())).toMatchObject({ code: 'PREVIEW_OPERATION_UNCERTAIN' })
    release(); await f.service.pendingResult()
    expect(await restarted.getStatus({ operationId: input.operationId })).toMatchObject({ data: { phase: 'UNKNOWN', ready: false, reasonCode: 'RUNTIME_RECONCILIATION_REQUIRED' } })
  })
  it('keeps the default status bounded independently of deterministic history size', async () => {
    const f = setup(true), input = intent()
    await f.service.runBranchApp(input); await f.service.pendingResult()
    const original = await f.service.getStatus({ operationId: input.operationId })
    const readHistory = vi.spyOn(f.store, 'list').mockReturnValue(Array.from({ length: 20 }, () => ({ ...f.record, sessionId: randomUUID(), operationId: randomUUID() })))
    const history = await f.service.handle({ action: 'LIST', repositoryId: 'repo', limit: 20 })
    readHistory.mockClear()
    const status = await f.service.getStatus({ operationId: input.operationId })
    expect(status).toEqual(original); expect(readHistory).not.toHaveBeenCalled()
    expect(JSON.stringify(status).length).toBeLessThan(JSON.stringify(history).length)
    expect(JSON.stringify(status)).not.toMatch(/coverage|qualifications|sessions|lastOperation|result|checkout/)
  })
  it('bounds intent retention and keeps completed receipts immutable', () => {
    const f = setup(true), store: PreviewSessionStore = f.store
    const receipt = { operationId: randomUUID(), key: 'a'.repeat(64), repositoryId: 'repo', branch: 'topic', at: new Date().toISOString(), revision: 0 as const, sessionId: null, reasonCode: null, phase: 'PREPARING' as const }
    store.appendIntent(receipt)
    const completed = { ...receipt, revision: 1 as const, phase: 'BLOCKED' as const, reasonCode: 'PROFILE_APPROVAL_REQUIRED' }
    store.appendIntent(completed)
    expect(() => store.appendIntent(completed)).toThrow('INTENT_RECEIPT_UNVERIFIABLE')
    expect(new PreviewSessionStore(store.root).readIntent(receipt.operationId)).toEqual(completed)
    for (let index = 1; index < 128; index++) store.appendIntent({ ...receipt, operationId: randomUUID() })
    expect(() => store.appendIntent({ ...receipt, operationId: randomUUID() })).toThrow('INTENT_RETENTION_LIMIT')
  })
  it('reports STOPPING until cleanup is proved and reads the terminal receipt after restart', async () => {
    const f = setup(true), input = intent()
    await f.service.runBranchApp(input); await f.service.pendingResult()
    const record = f.store.read(f.record.sessionId)
    let finish!: (record: PreviewSessionRecord) => void
    f.runner.stop.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = await executeRuntimePreviewTool(f.service, 'stop_runtime_preview', { sessionId: record.sessionId }, () => {})
    expect(pending).toMatchObject({ structuredContent: { data: { phase: 'STOPPING', ready: false, resourcesReleased: false } }, content: [] })
    const stopped = { ...record, revision: 1, state: 'STOPPED', resources: 'RELEASED', endedAt: record.at,
      process: { ...record.process!, activeProcesses: 0, rootSignaled: true, knownHandlesClosed: true, jobClosed: true, eventClosed: true } }
    f.store.append(stopped); finish(stopped); await f.service.pendingResult()
    expect(await f.service.getStatus({ sessionId: record.sessionId })).toMatchObject({ data: { phase: 'STOPPED', activeProcesses: 0, handlesClosed: true, resourcesReleased: true, recommendedAction: 'NONE' } })
    f.runner.owns.mockReturnValue(false)
    expect(await f.service.getStatus({ operationId: input.operationId })).toMatchObject({ data: { phase: 'STOPPED' } })
  })
  it('does not promote stale attestation, missing ownership or incomplete cleanup', () => {
    const { record } = setup()
    expect(previewStatus(undefined, { ...record, attestation: { artifact: 'VERIFIED', loadedCode: 'STALE' } }, { owned: true }).ready).toBe(false)
    expect(previewStatus(undefined, { ...record, attestation: { artifact: 'UNVERIFIABLE', loadedCode: 'VERIFIED' } }, { owned: true })).toMatchObject({ ready: true, recommendedAction: 'ASK_HUMAN_REVIEW' })
    expect(previewStatus(undefined, record, { owned: false })).toMatchObject({ phase: 'UNKNOWN', ready: false })
    expect(previewStatus(undefined, { ...record, state: 'STOPPED', resources: 'RELEASED' })).toMatchObject({ phase: 'UNKNOWN', resourcesReleased: false })
    expect(previewStatus(undefined, { ...record, state: 'FAILED', failure: 'UNEXPECTED_PROCESS_EXIT', resources: 'RELEASED',
      process: { ...record.process!, activeProcesses: 0, rootSignaled: true, knownHandlesClosed: true, jobClosed: true, eventClosed: true } })).toMatchObject({ phase: 'FAILED', reasonCode: 'UNEXPECTED_PROCESS_EXIT' })
  })
  it('rejects injected selection policy and requires canonical repository context when omitted', async () => {
    const { service, runner } = setup(true)
    expect(await service.runBranchApp({ ...intent(), fingerprint: 'a'.repeat(64) })).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(await service.runBranchApp({ branch: 'topic', operationId: randomUUID() })).toMatchObject({ code: 'REPOSITORY_REQUIRED' })
    expect(runner.start).not.toHaveBeenCalled()
  })
  it.each([{}, { operationId: randomUUID(), sessionId: randomUUID() }, { sessionId: randomUUID(), coverage: true }])('rejects ambiguous and unbounded selectors %j', async selector => {
    expect(await setup(true).service.getStatus(selector)).toEqual({ success: false, code: 'INVALID_ARGUMENT' })
  })
})
