import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture, markdown } from '../continuum/continuum-test-fixtures'
import { ValidationLedger } from '../validation-ledger/validation-ledger'
import { inspectExecutionOriginAlignment } from './execution-origin'
import { startCaptureFixture } from './fixtures/native-capture-fixture'
import { correlateNativeArtifact } from './native-artifact-correlation'
import { nativeObservationBatch } from './native-hook-ingestion'
import { nativeBindingPath, nativeDigest, nativeGitIdentity, normalizeNativeHook, prepareNativeSpool, type NativeHookBinding, type NativeHookEnvelope } from './native-hooks'
import { executeSessionTool, SESSION_CONTEXT_TOOLS } from './mcp'
import { registrySources } from './registry-sources'
import { SessionStore, sessionStorePath } from './store'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()) })

function safeRemove(dir: string) {
  execFileSync('node', ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })", dir], { windowsHide: true })
}

function setup(repositoryId = 'repo') {
  const dir = mkdtempSync(join(tmpdir(), 'u2-focal-'))
  cleanup.push(() => safeRemove(dir))
  const continuum = fixture(repositoryId)
  cleanup.push(continuum.close)
  mkdirSync(join(continuum.dir, '.git'))
  const spool = join(continuum.dir, '.code-awareness/native-hooks/spool')
  prepareNativeSpool(spool)
  const wt1 = { worktreeId: '1'.repeat(64), generation: 'a'.repeat(64) }
  const wt2 = { worktreeId: '1'.repeat(64), generation: 'b'.repeat(64) }
  const binding: NativeHookBinding = { schema: 1, enabled: true, repositoryId, ...wt1, ...nativeGitIdentity(continuum.dir), spool }
  const storePath = sessionStorePath(dir, repositoryId)
  let store = new SessionStore(storePath, repositoryId)
  cleanup.push(() => store.close())
  const ledger = new ValidationLedger(join(dir, 'ledger.sqlite'))
  cleanup.push(() => ledger.close())
  const github = { commitPullRequests: vi.fn(async () => []), getPullRequest: vi.fn(), pullRequestCommits: vi.fn() }
  const read = registrySources({ repositoryId, root: continuum.dir, continuum: () => continuum.service, ledger, github, networkAllowed: () => false, assertCurrent: () => {} })
  const call = async (args: object, selectedTarget = wt1, liveTargets = [wt1], accountHash?: string) => {
    const res = await executeSessionTool(store, { refresh: async () => ({}) }, 'list_agent_sessions', args, () => {}, selectedTarget, liveTargets as any, undefined, continuum.dir, undefined, read, accountHash)
    return { isError: !!res.isError, data: JSON.parse((res.content[0] as { text: string }).text) }
  }
  const observeHook = (sessionRaw: string, target: { worktreeId: string; generation: string }, opts: { provider?: 'codex' | 'antigravity'; observedAt?: string; invocationId?: string; event?: NativeHookEnvelope['event'] } = {}) => {
    const providerSource: NativeHookEnvelope['source'] = opts.provider === 'antigravity' ? 'ANTIGRAVITY_NATIVE_HOOK' : 'CODEX_NATIVE_HOOK'
    const agentKey = opts.provider === 'antigravity' ? 'antigravity' : 'codex'
    const sessionId = nativeDigest(JSON.stringify([repositoryId, agentKey, sessionRaw]))
    const facts = {
      schema: 1 as const,
      source: providerSource,
      repositoryId,
      worktreeId: target.worktreeId,
      generation: target.generation,
      sessionId,
      event: opts.event ?? ('SessionStart' as const),
      ...(opts.invocationId ? { invocationId: opts.invocationId } : {})
    }
    const body = { ...facts, observedAt: opts.observedAt ?? '2026-11-17T10:00:00.000Z', eventId: nativeDigest(JSON.stringify(facts)) }
    const env: NativeHookEnvelope = { ...body, digest: nativeDigest(JSON.stringify(body)) }
    store.registry.apply(nativeObservationBatch(env), undefined)
    return sessionId
  }
  const publishWithNative = async (rawMarkdown: string, sessionRaw: string, callId = 'call-1') => {
    const receipt = continuum.service.publish(rawMarkdown)
    const sessionId = nativeDigest(JSON.stringify([repositoryId, 'codex', sessionRaw]))
    const stamp = startCaptureFixture(store.registry, binding, sessionId)
    for (const hook_event_name of ['PreToolUse', 'PostToolUse']) {
      const event = normalizeNativeHook({
        hook_event_name, session_id: sessionRaw, tool_use_id: callId, tool_name: 'mcp__code_awareness_local__publish_artifact', cwd: binding.root, tool_input: { rawMarkdown },
        ...(hook_event_name === 'PostToolUse' ? { tool_response: { content: [{ type: 'text', text: JSON.stringify(receipt) }] } } : {})
      }, binding)
      store.registry.apply(nativeObservationBatch(stamp(event)), undefined)
      await correlateNativeArtifact(store.registry, binding, event.invocationId!, {
        readReceipt: async id => continuum.service.readPublicationReceipt(id),
        associate: async value => continuum.service.associatePublication(value),
        invalidate: async (id, state) => { continuum.service.invalidatePublication(id, state) }
      }, () => {})
    }
    return { receipt, sessionId }
  }
  return { dir, store, continuum, binding, wt1, wt2, read, call, observeHook, publishWithNative,
    restart: () => { store.close(); store = new SessionStore(storePath, repositoryId) } }
}

it('U2 validates flat AJV schema and rejects unpaired worktreeId/generation', async () => {
  const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/ajv')
  const def = SESSION_CONTEXT_TOOLS.find(t => t.name === 'list_agent_sessions')!
  const validator = new AjvJsonSchemaValidator().getValidator(def.inputSchema as any)
  expect(validator({ worktreeId: '1'.repeat(64), generation: 'a'.repeat(64), view: 'FOCAL' }).valid).toBe(true)
  expect(validator({ source: 'NATIVE_HOOK', worktreeId: '1'.repeat(64), generation: 'a'.repeat(64), agent: 'codex', after: '2026-11-17T00:00:00Z' }).valid).toBe(true)

  const f = setup()
  const unpaired = await f.call({ worktreeId: '1'.repeat(64) })
  expect(unpaired.isError).toBe(true)
  expect(unpaired.data).toEqual({ code: 'INVALID_ARGUMENT' })
})

it('U2 filters active vs historical removed worktrees, isolates recycled generations, and detects ORIGIN_UNVERIFIED', async () => {
  const f = setup()
  const imported = f.store.ingest({
    provider: 'entire', providerSessionId: 'imp-1', providerVersion: '0.12.2', agent: 'codex',
    state: 'ENDED', coverage: 'PARTIAL', importState: 'METADATA_ONLY', sourceDigest: nativeDigest('imp-1'), sourceBytes: 0, endedAt: '2026-11-17T09:00:00.000Z'
  }, [])
  f.store.observeWorktree(imported.sessionId, f.wt1)
  const natWt1 = f.observeHook('codex-wt1', f.wt1, { provider: 'codex', observedAt: '2026-11-17T10:00:00.000Z' })
  const natWt2 = f.observeHook('ag-wt2', f.wt2, { provider: 'antigravity', observedAt: '2026-11-17T11:00:00.000Z' })

  const active = await f.call({ worktreeId: f.wt1.worktreeId, generation: f.wt1.generation }, f.wt1, [f.wt1])
  expect(active.isError).toBe(false)
  expect(active.data.worktreeState).toBe('ACTIVE')
  expect(active.data.contextMap).toBeUndefined()
  expect(active.data.archiveCoverage).toBeUndefined()
  expect(active.data.nativeCapture).toBeUndefined()
  expect(active.data.sessions).toHaveLength(2)
  expect(active.data.sessions.map((s: any) => s.providerSessionId).sort()).toEqual(['imp-1', natWt1].sort())
  expect(active.data.sessions.every((s: any) => s.worktreeAvailability === 'ACTIVE')).toBe(true)

  const removedWt2 = await f.call({ source: 'NATIVE_HOOK', worktreeId: f.wt2.worktreeId, generation: f.wt2.generation }, f.wt1, [f.wt1])
  expect(removedWt2.data.worktreeState).toBe('HISTORICAL_ONLY')
  expect(removedWt2.data.sessions).toHaveLength(1)
  expect(removedWt2.data.sessions[0]).toMatchObject({ provider: 'antigravity-native', agent: 'antigravity', providerSessionId: natWt2, worktreeAvailability: 'HISTORICAL_ONLY' })

  const unknownWt = await f.call({ worktreeId: '9'.repeat(64), generation: 'f'.repeat(64) }, f.wt1, [f.wt1])
  expect(unknownWt.data.sessions).toEqual([])
  expect(unknownWt.data.worktreeState).toBe('ORIGIN_UNVERIFIED')
  expect(unknownWt.data.reason).toBe('ORIGIN_UNVERIFIED')
})

it('U2 queries NATIVE_HOOK and focal views with agent/after/before filters before pagination and invalidates stale cursors', async () => {
  const f = setup()
  const agOld = f.observeHook('ag-1', f.wt1, { provider: 'antigravity', observedAt: '2026-11-17T08:00:00.000Z' })
  const agNew = f.observeHook('ag-2', f.wt1, { provider: 'antigravity', observedAt: '2026-11-17T10:30:00.000Z' })
  f.observeHook('codex-1', f.wt1, { provider: 'codex', observedAt: '2026-11-17T10:45:00.000Z' })

  const p1 = await f.call({ source: 'NATIVE_HOOK', worktreeId: f.wt1.worktreeId, generation: f.wt1.generation, agent: 'antigravity', after: '2026-11-17T07:00:00.000Z', before: '2026-11-17T11:00:00.000Z', limit: 1 })
  expect(p1.data.sessions).toHaveLength(1)
  expect(p1.data.sessions[0].providerSessionId).toBe(agNew)
  expect(p1.data.nextCursor).toEqual(expect.any(String))

  const mismatch = await f.call({ source: 'NATIVE_HOOK', worktreeId: f.wt1.worktreeId, generation: f.wt1.generation, agent: 'codex', cursor: p1.data.nextCursor })
  expect(mismatch.isError).toBe(true)
  expect(mismatch.data).toEqual({ code: 'CURSOR_STALE' })

  const p2 = await f.call({ source: 'NATIVE_HOOK', worktreeId: f.wt1.worktreeId, generation: f.wt1.generation, agent: 'antigravity', after: '2026-11-17T07:00:00.000Z', before: '2026-11-17T11:00:00.000Z', limit: 1, cursor: p1.data.nextCursor })
  expect(p2.data.sessions).toHaveLength(1)
  expect(p2.data.sessions[0].providerSessionId).toBe(agOld)
  expect(p2.data.nextCursor).toBeUndefined()

  f.observeHook('ag-3', f.wt1, { provider: 'antigravity', observedAt: '2026-11-17T10:15:00.000Z' })
  const mutated = await f.call({ source: 'NATIVE_HOOK', worktreeId: f.wt1.worktreeId, generation: f.wt1.generation, agent: 'antigravity', after: '2026-11-17T07:00:00.000Z', before: '2026-11-17T11:00:00.000Z', limit: 1, cursor: p1.data.nextCursor })
  expect(mutated.isError).toBe(true)
  expect(mutated.data).toEqual({ code: 'CURSOR_STALE' })
})

it('U2 returns linked sessions with compact witness on Plan/Execution, never merges separate provider aliases, and returns honest empty + nextDiscovery when unlinked', async () => {
  const f = setup()
  const plan = f.continuum.service.publish(markdown('Plan U2'))
  const unlinkedPlan = f.continuum.service.publish(markdown('Unlinked Plan'))
  const { sessionId } = await f.publishWithNative(markdown('Handoff', `executionId: exec-u2\nrelations:\n  - artifactId: ${plan.artifactId}\n    kind: implements\n`, 'Done.'), 'same-label')
  f.store.ingest({
    provider: 'entire', providerSessionId: 'same-label', providerVersion: '0.12.2', agent: 'codex',
    state: 'ENDED', coverage: 'PARTIAL', importState: 'METADATA_ONLY', sourceDigest: nativeDigest('same-label'), sourceBytes: 0, endedAt: '2026-11-17T09:00:00.000Z'
  }, [])

  const byPlan = await f.call({ artifactId: plan.artifactId, view: 'FOCAL' })
  expect(byPlan.isError).toBe(false)
  expect(byPlan.data.contextMap).toBeUndefined()
  expect(byPlan.data.sessions).toHaveLength(1)
  expect(byPlan.data.sessions[0]).toMatchObject({
    provider: 'codex-native',
    providerSessionId: sessionId,
    aliasState: 'NOT_RECONCILED',
    witness: { kind: 'CONTINUUM_TYPED_RELATION', relation: 'implements', strength: 'DECLARED' }
  })

  const byExec = await f.call({ source: 'NATIVE_HOOK', executionId: 'exec-u2', view: 'FOCAL' })
  expect(byExec.data.sessions).toHaveLength(1)
  expect(byExec.data.sessions[0].witness).toBeDefined()

  const empty = await f.call({ artifactId: unlinkedPlan.artifactId, view: 'FOCAL' }, f.wt1, [f.wt1])
  expect(empty.data.sessions).toEqual([])
  expect(empty.data.reason).toBe('NO_ASSOCIATION_OBSERVED')
  expect(empty.data.nextDiscovery).toMatchObject({
    reason: 'NO_FORMAL_LINK_TO_PLAN',
    candidateWorktree: f.wt1,
    tool: 'list_agent_sessions',
    provesPlanMembership: false
  })

  // Foreign account hides codex imported rows while preserving visibility boundaries
  const imp = f.store.ingest({
    provider: 'codex', providerSessionId: 'codex-acc', providerVersion: '0.169', agent: 'codex',
    state: 'ENDED', coverage: 'PARTIAL', importState: 'METADATA_ONLY', sourceDigest: nativeDigest('codex-acc'), sourceBytes: 0, endedAt: '2026-11-17T09:00:00.000Z'
  }, [])
  f.store.recordAssociation({
    repositoryId: 'repo', sessionId: imp.sessionId, providerSessionId: 'codex-acc', provider: 'codex',
    ...f.wt1, providerAccountHash: nativeDigest('account-1'), evidence: 'WORKTREE_VERIFIED', origin: 'CODEX_APP_SERVER'
  }, f.store.catalogRevision())
  const ownerRes = await f.call({ worktreeId: f.wt1.worktreeId, generation: f.wt1.generation }, f.wt1, [f.wt1], nativeDigest('account-1'))
  expect(ownerRes.data.sessions.some((s: any) => s.providerSessionId === 'codex-acc')).toBe(true)
  const foreignRes = await f.call({ worktreeId: f.wt1.worktreeId, generation: f.wt1.generation }, f.wt1, [f.wt1], nativeDigest('account-2'))
  expect(foreignRes.data.sessions.some((s: any) => s.providerSessionId === 'codex-acc')).toBe(false)
}, 20000)

it('selects and pages native sessions in SQL before record projection, keeps target past 12-worktree bound, and returns Pure Signal FOCAL', async () => {
  const f = setup()
  const sOld = f.observeHook('ag-old', f.wt1, { provider: 'antigravity', observedAt: '2026-11-17T08:00:00.000Z' })
  const sMid = f.observeHook('ag-mid', f.wt1, { provider: 'antigravity', observedAt: '2026-11-17T09:00:00.000Z' })
  const sNew = f.observeHook('ag-new', f.wt1, { provider: 'antigravity', observedAt: '2026-11-17T10:00:00.000Z' })
  const sOtherWt = f.observeHook('ag-other', f.wt2, { provider: 'antigravity', observedAt: '2026-11-17T11:00:00.000Z' })
  f.observeHook('codex-other', f.wt1, { provider: 'codex', observedAt: '2026-11-17T12:00:00.000Z' })

  // Unproven/stale edge must never be selected for wt1
  const sStale = nativeDigest(JSON.stringify(['repo', 'antigravity', 'ag-stale']))
  f.store.registry.apply({
    repositoryId: 'repo',
    source: 'NATIVE_HOOK:stale-only',
    revision: 'stale-rev',
    status: 'REPLACED',
    edges: [
      { from: { kind: 'EXECUTION', id: 'native-observation:' + nativeDigest('stale-obs') }, relation: 'SessionStart', to: { kind: 'SESSION', id: 'antigravity-native:' + sStale }, evidenceKind: 'NATIVE_HOOK_OBSERVED', evidenceRef: 'stale', digest: nativeDigest('stale'), freshness: 'OBSERVED_SNAPSHOT' },
      { from: { kind: 'EXECUTION', id: 'native-observation:' + nativeDigest('stale-obs') }, relation: 'observed-in', to: { kind: 'WORKTREE', id: `${f.wt1.worktreeId}:${f.wt1.generation}` }, evidenceKind: 'NATIVE_HOOK_OBSERVED', evidenceRef: 'stale', digest: nativeDigest('stale'), freshness: 'OBSERVED_SNAPSHOT' }
    ]
  }, undefined)

  // Session observed in 13 worktrees where the 13th (oldest) is queried: truncation to 12 must not drop it
  const wtOldest = { worktreeId: '7'.repeat(64), generation: '7'.repeat(64) }
  f.observeHook('ag-multi', wtOldest, { provider: 'antigravity', observedAt: '2026-11-17T07:00:00.000Z' })
  for (let i = 1; i <= 12; i++) {
    const gen = i.toString(16).padStart(64, 'c')
    f.observeHook('ag-multi', { worktreeId: '8'.repeat(64), generation: gen }, { provider: 'antigravity', observedAt: `2026-11-17T07:${String(i).padStart(2, '0')}:00.000Z` })
  }

  const recordSpy = vi.spyOn(f.store.registry as any, 'nativeSessionRecord')

  const focalPage1 = await f.call({
    source: 'NATIVE_HOOK',
    view: 'FOCAL',
    worktreeId: f.wt1.worktreeId,
    generation: f.wt1.generation,
    agent: 'antigravity',
    after: '2026-11-17T07:30:00.000Z',
    before: '2026-11-17T10:30:00.000Z',
    limit: 1
  })
  expect(focalPage1.isError).toBe(false)
  expect(focalPage1.data.sessions).toHaveLength(1)
  expect(focalPage1.data.sessions[0].providerSessionId).toBe(sNew)
  expect(focalPage1.data.sessions[0].deepen).toEqual({
    tool: 'inspect_agent_session',
    arguments: { repositoryId: 'repo', nativeSession: { provider: 'antigravity-native', id: sNew, ...f.wt1 } }
  })
  expect(focalPage1.data.contextMap).toBeUndefined()
  expect(focalPage1.data.windows).toBeUndefined()
  expect(focalPage1.data.pipeline).toBeUndefined()
  // Only limit + 1 = 2 page rows projected, never all 7 sessions in the repository
  expect(recordSpy).toHaveBeenCalledTimes(2)

  recordSpy.mockClear()
  const focalPage2 = await f.call({
    source: 'NATIVE_HOOK',
    view: 'FOCAL',
    worktreeId: f.wt1.worktreeId,
    generation: f.wt1.generation,
    agent: 'antigravity',
    after: '2026-11-17T07:30:00.000Z',
    before: '2026-11-17T10:30:00.000Z',
    limit: 1,
    cursor: focalPage1.data.nextCursor
  })
  expect(focalPage2.data.sessions.map((s: any) => s.providerSessionId)).toEqual([sMid])
  expect(recordSpy).toHaveBeenCalledTimes(2)

  // Global FOCAL query excludes windows/pipeline diagnostics and still orders accurately
  recordSpy.mockClear()
  const globalFocal = await f.call({ source: 'NATIVE_HOOK', view: 'FOCAL', agent: 'antigravity', limit: 1 })
  expect(globalFocal.data.sessions[0].providerSessionId).toBe(sOtherWt)
  expect(globalFocal.data.windows).toBeUndefined()
  expect(globalFocal.data.pipeline).toBeUndefined()
  expect(recordSpy).toHaveBeenCalledTimes(2)

  // Proven 13th worktree is found even when projection bounds worktrees to 12
  recordSpy.mockClear()
  const boundedRes = await f.call({ source: 'NATIVE_HOOK', view: 'FOCAL', worktreeId: wtOldest.worktreeId, generation: wtOldest.generation }, wtOldest, [wtOldest])
  expect(boundedRes.data.sessions).toHaveLength(1)
  expect(boundedRes.data.sessions[0].worktrees).toHaveLength(12)
  expect(boundedRes.data.sessions[0].worktrees).toContainEqual(wtOldest)
  expect(boundedRes.data.sessions.some((s: any) => s.providerSessionId === sOld)).toBe(false)
})

it('uses focal existence check in inspectExecutionOriginAlignment without calling queryNativeSessions or projecting records', () => {
  const f = setup()
  const agBindingPath = nativeBindingPath(f.continuum.dir, 'antigravity')
  mkdirSync(dirname(agBindingPath), { recursive: true })
  writeFileSync(agBindingPath, JSON.stringify({ ...f.binding, provider: 'antigravity' }))
  f.observeHook('ag-target', f.wt1, { provider: 'antigravity', observedAt: '2026-11-17T10:00:00.000Z' })
  f.observeHook('codex-other', f.wt2, { provider: 'codex', observedAt: '2026-11-17T11:00:00.000Z' })

  const querySpy = vi.spyOn(f.store.registry, 'queryNativeSessions')
  const existsSpy = vi.spyOn(f.store.registry, 'hasNativeSession')
  const recordSpy = vi.spyOn(f.store.registry as any, 'nativeSessionRecord')

  const observed = inspectExecutionOriginAlignment(f.store, f.continuum.dir, f.wt1)
  expect(observed.captureStatus).toBe('CAPTURE_OBSERVED')
  expect(observed.ready).toBe(true)
  expect(observed.origin.state).toBe('TARGET_SESSION_OBSERVED')
  expect(existsSpy).toHaveBeenCalled()
  expect(querySpy).not.toHaveBeenCalled()
  expect(recordSpy).not.toHaveBeenCalled()

  existsSpy.mockClear()
  const wt2Dir = join(f.dir, 'wt2-pending')
  mkdirSync(join(wt2Dir, '.git'), { recursive: true })
  const wt2BindingPath = nativeBindingPath(wt2Dir, 'antigravity')
  mkdirSync(dirname(wt2BindingPath), { recursive: true })
  writeFileSync(wt2BindingPath, JSON.stringify({ ...f.binding, provider: 'antigravity', ...f.wt2, ...nativeGitIdentity(wt2Dir), spool: join(wt2Dir, 'spool') }))
  const pending = inspectExecutionOriginAlignment(f.store, wt2Dir, f.wt2, { agent: 'antigravity' })
  expect(pending.captureStatus).toBe('PENDING_FIRST_SESSION')
  expect(pending.ready).toBe(false)
  expect(pending.origin).toMatchObject({ state: 'UNKNOWN', reason: 'PENDING_FIRST_SESSION', observedOnTarget: false })
  expect(existsSpy).toHaveBeenCalled()
  expect(querySpy).not.toHaveBeenCalled()
  expect(recordSpy).not.toHaveBeenCalled()
})

it('addresses every persisted native observation past 256 by filter and cursor, emits a reusable selector, and refuses stale or ambiguous origins', async () => {
  const f = setup()
  const raw = 'long-session'
  const at = (i: number) => new Date(Date.UTC(2026, 10, 17, 10, 0, i)).toISOString()
  let sessionId = ''
  for (let i = 0; i < 256; i++) sessionId = f.observeHook(raw, f.wt1, { provider: 'antigravity', observedAt: at(i), event: 'PreToolUse', invocationId: nativeDigest('inv' + i) })
  const late = nativeDigest('inv-late')
  f.observeHook(raw, f.wt1, { provider: 'antigravity', observedAt: at(300), event: 'PostToolUse', invocationId: late })
  const call = async (name: any, args: object, target = f.wt1) => {
    const res = await executeSessionTool(f.store, { refresh: async () => ({}) }, name, args, () => {}, target, [target] as any, undefined, f.continuum.dir)
    return { isError: !!res.isError, data: JSON.parse((res.content[0] as { text: string }).text) }
  }

  const listed = await call('list_agent_sessions', { source: 'NATIVE_HOOK', view: 'FOCAL', agent: 'antigravity' })
  expect(listed.data.sessions[0].deepen.arguments.nativeSession).toEqual({ provider: 'antigravity-native', id: sessionId, ...f.wt1 })
  const map = await call('inspect_agent_session', listed.data.sessions[0].deepen.arguments)
  expect(map.isError).toBe(false)
  expect(map.data).toMatchObject({ observedEventCount: 257, origin: 'OBSERVED_WORKTREE', sourceCoverage: 'OBSERVED_EVENTS_ONLY' })
  expect(map.data.hookEvents).toEqual([{ type: 'PreToolUse', count: 256 }, { type: 'PostToolUse', count: 1 }])

  const nativeSession = listed.data.sessions[0].deepen.arguments.nativeSession
  const filtered = await call('list_agent_session_events', { nativeSession, hookEvents: ['PostToolUse'] })
  expect(filtered.data.events).toHaveLength(1)
  expect(filtered.data.events[0]).toMatchObject({ type: 'PostToolUse', invocationId: late })

  const first = await call('list_agent_session_events', { nativeSession, limit: 15 })
  expect(first.data.events).toHaveLength(15)
  expect(first.data.nextCursor).toEqual(expect.any(String))
  f.observeHook(raw, f.wt1, { provider: 'antigravity', observedAt: at(301), event: 'PostToolUse', invocationId: nativeDigest('inv-after-cursor') })
  const stale = await call('list_agent_session_events', { nativeSession, limit: 15, cursor: first.data.nextCursor })
  expect(stale.data).toEqual({ code: 'CURSOR_STALE' })

  f.observeHook(raw, f.wt2, { provider: 'antigravity', observedAt: at(400), event: 'PreToolUse', invocationId: nativeDigest('inv-wt2') })
  const bareSelector = { provider: 'antigravity-native', id: sessionId }
  const multiMap = await call('inspect_agent_session', { nativeSession: bareSelector })
  expect(multiMap.data.origin).toBe('ORIGIN_UNVERIFIED')
  expect(multiMap.data.events).toBeUndefined()
  expect(multiMap.data.originSelection.arguments.mapView).toBe('ORIGINS')
  const originsPage = await call('inspect_agent_session', { ...multiMap.data.originSelection.arguments, limit: 1 })
  expect(originsPage.data.origins).toHaveLength(1)
  expect(originsPage.data.nextCursor).toEqual(expect.any(String))
  expect((await call('list_agent_session_events', { nativeSession: bareSelector })).data).toEqual({ code: 'ORIGIN_UNVERIFIED' })
  const scoped = await call('list_agent_session_events', { nativeSession: { ...bareSelector, ...f.wt2 } }, f.wt2)
  expect(scoped.data.events).toHaveLength(1)
}, 30000)
