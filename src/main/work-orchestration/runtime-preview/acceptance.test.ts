import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { previewRequestSchema, RuntimePreviewOperations } from './operations'
import { ACCEPTANCE_SCENARIOS } from './acceptance-scenarios'
import { executeRuntimePreviewTool, RUNTIME_PREVIEW_TOOLS } from './mcp'

const source = vi.hoisted(() => ({ fingerprints: [] as string[] }))
vi.mock('../../validation-execution/validation-source', () => ({
  captureValidationSource: async () => ({ repositoryId: 'repo', worktreeId: 'tree', generation: 'generation', head: 'a'.repeat(40), branch: 'feature', indexRevision: 'index', worktreeRevision: 'source', cwd: 'checkout' }),
  validationSourceFingerprint: () => source.fingerprints.shift() ?? 'fp-1'
}))

const selection = { repositoryId: 'repo', worktreeId: 'tree', generation: 'generation', profileId: 'app', fingerprint: 'a'.repeat(64) }
const sessionId = randomUUID()
const running = { sessionId, operationId: randomUUID(), selection, revision: 3, state: 'RUNNING', readiness: 'READY', liveness: 'VERIFIED', persistence: 'PERSISTED', coverage: [], startedAt: '2026-10-22T00:00:00Z', at: '2026-10-22T00:01:00Z' }
const request = { action: 'ACCEPT' as const, sessionId, scenarioId: ACCEPTANCE_SCENARIOS[0].id, bindingId: 'binding', criterionId: 'criterion' }
const profile = { adapter: { artifacts: [{ component: 'ELECTRON_RENDERER', path: 'renderer/index.js' }] } }

function setup(options: { observer?: (...args: any[]) => Promise<string>; channel?: boolean; profile?: unknown } = {}) {
  const guard = vi.fn()
  const repositories = { resolve: vi.fn(() => ({ guard })), open: vi.fn(async () => ({ guard, git: { getCoordinationIdentity: async () => ({ record: { path: 'checkout' } }) } })) }
  const store = { read: vi.fn(() => running), list: vi.fn(() => [running]) }
  const runner = { inspect: vi.fn(async () => running), linkValidation: vi.fn(async () => ({ ...running, revision: 4 })) }
  const ledger = { getProofWithFreshness: vi.fn(), recordProof: vi.fn((input: any) => ({ proofId: 'proof-1', ...input })) }
  const observer = options.observer ?? vi.fn(async () => 'APPROVED')
  const service = new RuntimePreviewOperations(repositories as any, {} as any, store as any, runner as any, async () => true, ledger as any, undefined, undefined, options.channel === false ? undefined : observer as any)
  vi.spyOn(service as any, 'profile').mockResolvedValue(options.profile ?? profile)
  vi.spyOn(service as any, 'binding').mockResolvedValue({ bindingId: 'binding', executionId: 'execution' })
  vi.spyOn(service as any, 'assess').mockResolvedValue({ status: 'PASSED', reasons: [] })
  vi.spyOn(service as any, 'view').mockResolvedValue({ sessionId })
  const accept = async () => { const started = await service.handle(request); expect(started).toMatchObject({ success: true, data: { pending: true } }); return service.pendingResult() }
  return { service, runner, ledger, observer, accept }
}

describe('guided acceptance on an isolated preview session', () => {
  beforeEach(() => { source.fingerprints.length = 0 })

  it('records only the operator answer as a USER proof bound to session, Worktree, head and criterion, then links it', async () => {
    const f = setup()
    const result = await f.accept()
    expect(f.observer).toHaveBeenCalledWith({ sessionId, scenario: expect.objectContaining({ id: 'ACADEMY_DOWNLOAD_BUSY' }), identity: { repositoryId: 'repo', worktreeId: 'tree', branch: 'feature', head: 'a'.repeat(40) } })
    expect(f.ledger.recordProof).toHaveBeenCalledOnce()
    expect(f.ledger.recordProof.mock.calls[0][0]).toMatchObject({ kind: 'MANUAL_ACCEPTANCE', producer: 'USER', status: 'PASSED', scope: ['renderer/index.js'], sourceFingerprint: 'fp-1',
      evidenceFor: ['criterion', 'runtime-preview:' + sessionId, 'execution:execution'], commandProfile: { command: 'runtime-preview:guided-acceptance', cwd: 'checkout' } })
    expect(f.runner.linkValidation).toHaveBeenCalledWith(sessionId, expect.objectContaining({ proofId: 'proof-1', criterionId: 'criterion', executionId: 'execution' }), 3, expect.any(Function))
    expect(result).toMatchObject({ success: true, data: { kind: 'ACCEPTANCE', outcome: 'APPROVED', proofId: 'proof-1', qualification: { status: 'PASSED' } } })
  })

  it('records a rejection as FAILED behavior, never as success', async () => {
    const f = setup({ observer: vi.fn(async () => 'REJECTED') })
    const result = await f.accept()
    expect(f.ledger.recordProof.mock.calls[0][0]).toMatchObject({ producer: 'USER', status: 'FAILED' })
    expect(result).toMatchObject({ success: true, data: { outcome: 'REJECTED', proofId: 'proof-1' } })
  })

  it.each(['CANCELLED', 'NOT_VERIFIABLE'])('%s produces no proof and no link', async outcome => {
    const f = setup({ observer: vi.fn(async () => outcome) })
    expect(await f.accept()).toMatchObject({ success: true, data: { kind: 'ACCEPTANCE', outcome, proofId: null, qualification: null } })
    expect(f.ledger.recordProof).not.toHaveBeenCalled()
    expect(f.runner.linkValidation).not.toHaveBeenCalled()
  })

  it('refuses an unknown scenario or a session whose profile cannot show it, before asking the operator', async () => {
    const unknown = setup()
    expect(await unknown.service.handle({ ...request, scenarioId: 'UNKNOWN' })).toEqual({ success: false, code: 'UNSUPPORTED_SCENARIO' })
    expect(unknown.observer).not.toHaveBeenCalled()
    const web = setup({ profile: { adapter: { artifacts: [{ component: 'WEB', path: 'index.html' }] } } })
    expect(await web.accept()).toEqual({ success: false, code: 'UNSUPPORTED_SCENARIO' })
    expect(web.observer).not.toHaveBeenCalled()
    expect(web.ledger.recordProof).not.toHaveBeenCalled()
  })

  it('does not ask the operator when the session is not READY', async () => {
    const f = setup()
    f.runner.inspect.mockResolvedValue({ ...running, readiness: 'NOT_READY' } as any)
    expect(await f.accept()).toEqual({ success: false, code: 'SESSION_NOT_READY' })
    expect(f.observer).not.toHaveBeenCalled()
  })

  it('does not promote an answer when the source changes while the operator decides', async () => {
    const f = setup()
    source.fingerprints.push('fp-before', 'fp-after')
    expect(await f.accept()).toEqual({ success: false, code: 'VALIDATION_SOURCE_CHANGED' })
    expect(f.ledger.recordProof).not.toHaveBeenCalled()
  })

  it('does not promote an answer when the session expired during the decision', async () => {
    const f = setup()
    f.runner.inspect.mockResolvedValueOnce(running as any).mockResolvedValueOnce({ ...running, state: 'STOPPED' } as any)
    expect(await f.accept()).toEqual({ success: false, code: 'PREVIEW_SESSION_EXPIRED' })
    expect(f.ledger.recordProof).not.toHaveBeenCalled()
  })

  it('fails honestly without a native operator channel or Ledger', async () => {
    const f = setup({ channel: false })
    expect(await f.service.handle(request)).toEqual({ success: false, code: 'ACCEPTANCE_CHANNEL_UNAVAILABLE' })
    expect(f.ledger.recordProof).not.toHaveBeenCalled()
  })

  it('cannot be fed an outcome by the caller and is exposed as one fixed MCP tool', async () => {
    expect(previewRequestSchema.safeParse({ ...request, outcome: 'APPROVED' }).success).toBe(false)
    expect(previewRequestSchema.safeParse({ ...request, status: 'PASSED', producer: 'USER' }).success).toBe(false)
    const tool = RUNTIME_PREVIEW_TOOLS.find(value => value.name === 'request_runtime_preview_acceptance')!
    expect(tool.inputSchema.additionalProperties).toBe(false)
    expect(Object.keys(tool.inputSchema.properties as object).sort()).toEqual(['bindingId', 'criterionId', 'scenarioId', 'sessionId'])
    const f = setup()
    const invoked = await executeRuntimePreviewTool(f.service, 'request_runtime_preview_acceptance', { sessionId, scenarioId: 'UNKNOWN', bindingId: 'b', criterionId: 'c', outcome: 'APPROVED' }, () => {})
    expect(invoked.isError).toBe(true)
    expect(f.observer).not.toHaveBeenCalled()
  })
})
