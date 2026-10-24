import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { previewRequestSchema, RuntimePreviewOperations } from './operations'
import { executeRuntimePreviewTool, RUNTIME_PREVIEW_TOOLS } from './mcp'

const selection = { repositoryId: 'repo', worktreeId: 'tree', generation: 'generation', profileId: 'web', fingerprint: 'a'.repeat(64) }
const sessionId = randomUUID()
vi.mock('../../validation-execution/validation-source', () => ({ captureValidationSource: async () => ({ repositoryId: 'repo', worktreeId: 'tree', generation: 'generation', head: 'head', branch: 'branch', indexRevision: 'index', worktreeRevision: 'source', cwd: 'checkout' }), validationSourceFingerprint: () => 'source-fingerprint' }))
const record = { sessionId, operationId: randomUUID(), selection, profileRevision: 1, revision: 0, at: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null,
  sourceSnapshot: null, state: 'CLEANUP_INCOMPLETE', persistence: 'PERSISTED', readiness: 'UNVERIFIABLE', liveness: 'UNVERIFIABLE', resources: 'UNVERIFIABLE', failure: 'ENDPOINT_RELEASE_UNVERIFIED',
  coverage: [], process: null, resourceInventory: [{ name: 'private', kind: 'SESSION_DIRECTORY', reference: 'PRIVATE_HANDLE_AND_PATH', state: 'UNVERIFIABLE' }], processEvidence: { members: [{ pid: 123, created: 'private' }] } }

describe('Runtime Preview bounded operations (contract fixtures)', () => {
  it.each([
    { action: 'START', selection, operationId: randomUUID(), command: 'arbitrary' },
    { action: 'STOP', sessionId: 'all' },
    { action: 'PROBE', sessionId, probes: ['READINESS', 'READINESS'] },
    { action: 'PROBE', sessionId, probes: ['READINESS'] },
    { action: 'PROBE', sessionId, probes: ['SHELL'] },
    { action: 'EVIDENCE', sessionId, section: 'RUNTIME', path: '../credentials' },
    { action: 'EVIDENCE', sessionId, section: 'COVERAGE', limit: 17 },
    { action: 'LIST', repositoryId: 'repo', limit: 21 },
    { action: 'QUALIFY', sessionId, bindingId: '', proofId: 'proof', criterionId: 'criterion' }
  ])('rejects unbounded or arbitrary requests: %j', request => expect(previewRequestSchema.safeParse(request).success).toBe(false))

  function setup() {
    const guard = vi.fn(), repositories = { resolve: vi.fn(() => ({ guard })), open: vi.fn(async () => ({ guard, worktrees: [] })) }
    const store = { read: vi.fn(() => record), list: vi.fn(() => [record]) }
    const runner = { inspect: vi.fn(async () => record), stop: vi.fn(async () => record), start: vi.fn() }
    const service = new RuntimePreviewOperations(repositories as any, {} as any, store as any, runner as any, async () => false)
    return { service, runner, store, repositories, guard }
  }
  it('never reads operational history by probing or exposing private resource references', async () => {
    const { service, runner } = setup()
    const result = await service.handle({ action: 'LIST', repositoryId: 'repo' })
    expect(result.success).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_HANDLE_AND_PATH|processEvidence|"pid"/)
    expect(JSON.stringify(result)).toContain('CLEANUP_INCOMPLETE')
    expect(JSON.stringify(result)).toContain('UNVERIFIABLE')
    expect(runner.inspect).not.toHaveBeenCalled()
  })
  it('reads only a selected immutable evidence revision and bounded public fields', async () => {
    const { service, store } = setup()
    const result = await service.handle({ action: 'EVIDENCE', sessionId, revision: 0, section: 'RUNTIME', limit: 1 })
    expect(store.read).toHaveBeenLastCalledWith(sessionId, 0)
    expect(result).toMatchObject({ success: true, data: { kind: 'EVIDENCE', revision: 0, nextOffset: 1 } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_HANDLE_AND_PATH')
  })
  it('exposes termination summary separately from the bounded operational receipt', async () => {
    const { service, store } = setup()
    const termination = { kind: 'UNEXPECTED_EXIT', reasonCode: 'UNEXPECTED_PROCESS_EXIT', observedAt: record.at,
      rootExit: { status: 'KNOWN', code: 23, reasonCode: 'EXIT_CODE_OBSERVED', observedAt: record.at },
      supervisor: { status: 'RESPONDING', phase: 'ROOT_EXITED', pid: 123, created: '100' }, process: null }
    store.read.mockReturnValue({ ...record, state: 'FAILED', termination } as any)
    store.list.mockReturnValue([{ ...record, state: 'FAILED', termination }] as any)
    const listed = await service.handle({ action: 'LIST', repositoryId: 'repo' })
    expect(listed).toMatchObject({ success: true, data: { sessions: [{ termination: { kind: 'UNEXPECTED_EXIT', rootExit: { code: 23 } } }] } })
    expect(JSON.stringify(listed)).not.toMatch(/supervisor|PRIVATE_HANDLE_AND_PATH/)
    const evidence = await service.handle({ action: 'EVIDENCE', sessionId, revision: 0, section: 'RUNTIME', limit: 1 })
    expect(evidence).toMatchObject({ success: true, data: { entries: [{ termination, stopIntent: null }] } })
  })
  it('retains an incomplete shutdown and idempotently shares pending stop work', async () => {
    const { service, runner } = setup()
    let finish!: (value: any) => void
    runner.stop.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    expect(await service.handle({ action: 'STOP', sessionId })).toMatchObject({ success: true, data: { pending: true } })
    await service.handle({ action: 'STOP', sessionId })
    expect(runner.stop).toHaveBeenCalledTimes(1)
    finish(record)
    expect(await service.pendingResult()).toMatchObject({ success: true, data: { session: { state: 'CLEANUP_INCOMPLETE', observation: 'UNVERIFIABLE' } } })
  })
  it('rejects a stale project before discovering any repository', async () => {
    const { service, repositories } = setup()
    expect(await service.handle({ action: 'WORKTREES', repositoryId: 'repo' }, () => { throw Error('PROJECT_CONTEXT_CHANGED') })).toEqual({ success: false, code: 'PROJECT_CONTEXT_CHANGED' })
    expect(repositories.open).not.toHaveBeenCalled()
  })
  it('rechecks the project after asynchronous discovery', async () => {
    const { service } = setup(); let calls = 0
    const result = await service.handle({ action: 'WORKTREES', repositoryId: 'repo' }, () => { if (++calls === 2) throw Error('PROJECT_CONTEXT_CHANGED') })
    expect(result).toEqual({ success: false, code: 'PROJECT_CONTEXT_CHANGED' })
  })
  it('can stop its recorded session after the repository becomes unavailable, without rediscovery', async () => {
    const { service, repositories, runner } = setup()
    repositories.resolve.mockImplementation(() => { throw Error('REPOSITORY_UNAVAILABLE') })
    expect(await service.handle({ action: 'STOP', sessionId })).toMatchObject({ success: true, data: { pending: true } })
    expect(await service.pendingResult()).toMatchObject({ success: true, data: { session: { state: 'CLEANUP_INCOMPLETE' } } })
    expect(runner.stop).toHaveBeenCalledWith(sessionId)
    expect(repositories.resolve).not.toHaveBeenCalled()
  })
  it.each([true, false])('authorizes asynchronously and reuses a current approval (%s)', async approved => {
    const guard = vi.fn(), confirm = vi.fn(async () => true), profile = { profileId: 'web' }
    const repositories = { resolve: () => ({ guard }), open: async () => ({ guard, git: { getCoordinationIdentity: async () => ({ record: { generation: selection.generation, path: 'checkout' } }) } }) }
    const profiles = { approved: async () => approved, assertExternal: vi.fn(), approve: vi.fn(async (_profile, callback) => callback(profile)) }
    const service = new RuntimePreviewOperations(repositories as any, profiles as any, {} as any, {} as any, confirm)
    vi.spyOn(service as any, 'profile').mockResolvedValue(profile)
    vi.spyOn(service as any, 'check').mockResolvedValue({ kind: 'PREFLIGHT' })
    expect(await service.handle({ action: 'AUTHORIZE', selection })).toMatchObject({ success: true, data: { pending: true } })
    expect(await service.pendingResult()).toEqual({ success: true, data: { kind: 'PREFLIGHT' } })
    expect(confirm).toHaveBeenCalledTimes(approved ? 0 : 1)
    expect(profiles.assertExternal).toHaveBeenCalledWith('checkout')
  })
  it('rejects the wrong generation before requesting asynchronous approval', async () => {
    const confirm = vi.fn(async () => true)
    const service = new RuntimePreviewOperations({ resolve: () => ({ guard() {} }), open: async () => ({ guard() {}, git: { getCoordinationIdentity: async () => ({ record: { generation: 'different' } }) } }) } as any, {} as any, {} as any, {} as any, confirm)
    vi.spyOn(service as any, 'profile').mockResolvedValue({})
    await service.handle({ action: 'AUTHORIZE', selection })
    expect(await service.pendingResult()).toEqual({ success: false, code: 'WORKTREE_STALE' })
    expect(confirm).not.toHaveBeenCalled()
  })
  it('exposes only twelve fixed tools and returns structured errors, without action injection', async () => {
    const { service } = setup()
    expect(RUNTIME_PREVIEW_TOOLS).toHaveLength(12)
    expect(RUNTIME_PREVIEW_TOOLS.every(tool => tool.inputSchema.additionalProperties === false)).toBe(true)
    const invalid = await executeRuntimePreviewTool(service, 'stop_runtime_preview', { sessionId, action: 'START' }, () => {})
    expect(invalid.isError).toBe(true)
    const valid = await executeRuntimePreviewTool(service, 'read_runtime_preview_evidence', { sessionId, section: 'COVERAGE' }, () => {})
    expect(valid.structuredContent).toMatchObject({ success: true, data: { kind: 'EVIDENCE' } })
    expect(JSON.parse((valid.content[0] as any).text)).toEqual(valid.structuredContent)
  })
  it.each([
    ['complete', {}, 'PASSED', []],
    ['typecheck', { kind: 'TYPECHECK' }, 'INCONCLUSIVE', ['BEHAVIOR_NOT_OBSERVED']],
    ['zero executed E2E', { kind: 'E2E', metrics: { testsPassed: 0, testsFailed: 0 } }, 'INCONCLUSIVE', ['BEHAVIOR_EVIDENCE_INSUFFICIENT']],
    ['stale proof', { freshness: 'SOURCE_STALE' }, 'INCONCLUSIVE', ['VALIDATION_PROOF_NOT_CURRENT']],
    ['unattested scope', { scope: ['other-file.js'] }, 'INCONCLUSIVE', ['VALIDATION_SCOPE_UNATTESTED']],
    ['failed behavior', { status: 'FAILED' }, 'FAILED', []]
    ,['failed executed E2E', { kind: 'E2E', status: 'FAILED', metrics: { testsPassed: 0, testsFailed: 1 } }, 'FAILED', []]
  ])('qualifies %s using existing behavior and full source chain', async (_name, patch, status, reasons) => {
    const binding = { bindingId: 'binding', executionId: 'execution', proofId: 'proof', criterionId: 'criterion', evidenceRevision: 0, sourceFingerprint: 'source-fingerprint' }
    const source = { head: 'head', branch: 'branch', indexRevision: 'index', worktreeRevision: 'source' }
    const evidence = { ...record, startedAt: '2026-10-22T00:00:00Z', at: '2026-10-22T00:01:00Z', sourceSnapshot: { ...source, worktreeRevision: 'metadata-only-revision' }, state: 'RUNNING', readiness: 'READY', liveness: 'VERIFIED',
      coverage: [{ stage: 'TARGET_CHECKOUT', status: 'VERIFIED' }, { stage: 'ENDPOINT', status: 'VERIFIED' }, { stage: 'LOADED_COMPONENT', component: 'WEB', evidenceRef: 'app.js', fingerprint: 'loaded', status: 'VERIFIED' }, { stage: 'SERVED_ARTIFACT', component: 'WEB', evidenceRef: 'app.js', fingerprint: 'served', status: 'VERIFIED' }] }
    const proof = { sourceFingerprint: 'source-fingerprint', scope: ['app.js'], commandProfile: { cwd: 'checkout', source: { ...source, ...selection, cwd: 'checkout' } }, evidenceFor: ['criterion', 'runtime-preview:' + sessionId, 'execution:execution'], kind: 'MANUAL_ACCEPTANCE', status: 'PASSED', freshness: 'CURRENT', startedAt: '2026-10-22T00:00:10Z', finishedAt: '2026-10-22T00:00:20Z', ...patch }
    const profile = { adapter: { artifacts: [{ component: 'WEB', path: 'app.js' }] } }
    const service = new RuntimePreviewOperations({ open: async () => ({ guard() {}, git: { getCoordinationIdentity: async () => ({ record: { generation: selection.generation, path: 'checkout', head: 'head', branch: 'branch' } }) } }) } as any,
      { approved: async () => true } as any, { read: () => evidence } as any, {} as any, async () => true, { getProofWithFreshness: async () => proof } as any)
    vi.spyOn(service as any, 'binding').mockResolvedValue(binding)
    vi.spyOn(service as any, 'profile').mockResolvedValue(profile)
    expect(await (service as any).assess(evidence, binding)).toMatchObject({ status, reasons })
    expect(await (service as any).assess(evidence, { ...binding, sourceFingerprint: undefined })).toMatchObject({ status: 'INCONCLUSIVE', reasons: expect.arrayContaining(['SESSION_SOURCE_CONTENT_UNVERIFIABLE']) })
    evidence.coverage[2].status = 'STALE'
    expect(await (service as any).assess(evidence, binding)).toMatchObject({ status: 'INCONCLUSIVE', reasons: expect.arrayContaining(['LOADED_COMPONENT_INCOMPLETE:WEB']) })
    proof.evidenceFor = ['criterion']
    await expect((service as any).assess(evidence, binding)).rejects.toThrow('VALIDATION_IDENTITY_MISMATCH')
  })
})
