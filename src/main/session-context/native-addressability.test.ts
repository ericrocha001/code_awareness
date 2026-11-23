import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { SessionContextClient } from './client'
import { antigravityAppTranscriptPath } from './antigravity-app-locator'
import { executeSessionTool } from './mcp'
import { nativeDigest } from './native-hooks'
import { SessionStore, sessionStorePath } from './store'
import { sourceFingerprint } from './target'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function safeRemove(dir: string) {
  execFileSync('node', ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })", dir], { windowsHide: true })
}

function makeWorkerBundle(baseDir: string): string {
  const workerPath = join(baseDir, 'worker.cjs')
  const built = buildSync({
    entryPoints: ['src/main/session-context/worker.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false
  }).outputFiles[0].text
  writeFileSync(workerPath, `require = require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});\n` + built)
  return workerPath
}

function setupWorkerEnv(repositoryId: string) {
  const base = mkdtempSync(join(tmpdir(), 'u2-addr-'))
  cleanup.push(() => safeRemove(base))
  const root = join(base, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n')
  const storePath = sessionStorePath(base, repositoryId)
  const store = new SessionStore(storePath, repositoryId)
  store.close()
  const configPath = join(dirname(storePath), 'session-context.provider.json')
  const target = { worktreeId: nativeDigest(`wt:${repositoryId}`), generation: nativeDigest(`gen:${repositoryId}`) }
  const fp = sourceFingerprint(root)
  const resolver = Object.assign(
    async () => ({ root, fingerprint: fp, validate: async () => {} }),
    { discover: async () => [{ ...target, root, fingerprint: fp }] }
  )
  const workerPath = makeWorkerBundle(base)
  const client = new SessionContextClient(base, repositoryId, root, () => true, workerPath, resolver as any, 30_000)
  cleanup.push(() => client.dispose())
  const call = async (name: Parameters<SessionContextClient['call']>[0], args: unknown) => {
    const res = await client.call(name, args)
    return { isError: !!res.isError, data: JSON.parse((res.content[0] as { text: string }).text) }
  }
  return { base, root, storePath, configPath, target, call }
}

it('U2 indexes and navigates >8 MiB / >512 Codex sessions incrementally without SQLite text copies, supports append/drift/revocation', async () => {
  const f = setupWorkerEnv('repo-addr-codex')
  const profile = join(f.base, 'codex-profile')
  const sessionUuid = '01a1e000-0000-7000-8000-000000000901'
  const uuidDay = new Date(Number.parseInt(sessionUuid.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).split('-')
  const rolloutDir = join(profile, 'sessions', ...uuidDay)
  mkdirSync(rolloutDir, { recursive: true })
  const accHash = nativeDigest(JSON.stringify(['addr-u', 'addr-a']))
  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-addr-codex',
    nativeSources: { codex: { profile, creatorAccountHash: accHash } }
  }))

  const pad = 'p'.repeat(15_500)
  const secretToken = 'sk-codex999secret999'
  const lines: string[] = [
    JSON.stringify({
      timestamp: '2026-11-18T10:00:00Z',
      type: 'session_meta',
      payload: {
        id: sessionUuid, session_id: sessionUuid, account_scoped: true,
        creator_user_id: 'addr-u', creator_account_id: 'addr-a',
        cwd: f.root, runtime_workspace_roots: [f.root], cli_version: '0.169.0-alpha.11.1'
      }
    }),
    JSON.stringify({ timestamp: '2026-11-18T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: f.root } }),
    JSON.stringify({ timestamp: '2026-11-18T10:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'run_check', call_id: 'call-cross', arguments: '{"check":"addr"}' } })
  ]
  for (let i = 0; i < 595; i++) {
    lines.push(JSON.stringify({
      timestamp: '2026-11-18T10:01:00Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `msg-${i}:${pad}` }] }
    }))
  }
  lines.push(JSON.stringify({ timestamp: '2026-11-18T10:05:00Z', type: 'turn_context', payload: { turn_id: 'turn-deep', cwd: f.root } }))
  lines.push(JSON.stringify({ timestamp: '2026-11-18T10:05:01Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-cross', output: 'Exit code: 0\ncross-chunk OK' } }))
  const deepUtf8Body = `Deep marker éção ${secretToken} at ${join(f.root, 'src', 'index.ts')} ` + 'ω'.repeat(4500)
  lines.push(JSON.stringify({
    timestamp: '2026-11-18T10:05:02Z',
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: deepUtf8Body }] }
  }))

  const rolloutPath = join(rolloutDir, `rollout-2026-11-18T10-00-00-${sessionUuid}.jsonl`)
  writeFileSync(rolloutPath, lines.join('\n') + '\n')
  expect(readFileSync(rolloutPath).length).toBeGreaterThan(8 * 1024 * 1024)

  const listed = await f.call('list_agent_sessions', { ...f.target })
  expect(listed.isError).toBe(false)
  expect(listed.data.sessions).toHaveLength(1)
  const deepen = listed.data.sessions[0].deepen.arguments

  // Before indexing, large session (>512 KiB) returns INDEXING_PENDING without loading body or fake READY revision
  const beforeIdx = await f.call('inspect_agent_session', deepen)
  expect(beforeIdx.isError, JSON.stringify(beforeIdx.data)).toBe(false)
  expect(beforeIdx.data.indexingState).toBe('INDEXING_PENDING')
  expect(beforeIdx.data.revision).toBe(0)
  expect(beforeIdx.data.next.tool).toBe('refresh_agent_sessions')

  const pendingEvents = await f.call('list_agent_session_events', { ...deepen, limit: 15 })
  expect(pendingEvents.isError).toBe(true)
  expect(pendingEvents.data.code).toBe('INDEXING_PENDING')
  expect(pendingEvents.data.next.tool).toBe('refresh_agent_sessions')

  // Multi-step bounded indexing via refresh_agent_sessions (>8 MiB takes >1 step of 2 MiB)
  const states: string[] = []
  let lastProgress = 0
  let readyPayload: any
  for (let step = 0; step < 20; step++) {
    const res = await f.call('refresh_agent_sessions', beforeIdx.data.next.arguments)
    expect(res.isError).toBe(false)
    states.push(res.data.state)
    expect(res.data.indexedBytes).toBeGreaterThanOrEqual(lastProgress)
    lastProgress = res.data.indexedBytes
    if (res.data.state === 'READY') {
      readyPayload = res.data
      break
    }
  }
  expect(states[0]).toBe('INDEXING_PENDING')
  expect(states.at(-1)).toBe('READY')
  expect(readyPayload.indexedEvents).toBe(598)
  expect(readyPayload.indexedBytes).toBeGreaterThan(8 * 1024 * 1024)

  // Verify SQLite holds zero bodies, zero paths, zero leaked checkpoints
  const rawDb = new Database(f.storePath, { readonly: true })
  try {
    expect((rawDb.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0)
    expect((rawDb.prepare('SELECT COUNT(*) AS c FROM native_reference_checkpoints').get() as { c: number }).c).toBe(0)
    const serialized = JSON.stringify({
      sources: rawDb.prepare('SELECT * FROM native_reference_sources').all(),
      events: rawDb.prepare('SELECT * FROM native_reference_events').all(),
      turns: rawDb.prepare('SELECT * FROM native_reference_turns').all()
    })
    expect(serialized).not.toContain('Deep marker')
    expect(serialized).not.toContain(secretToken)
    expect(serialized).not.toContain(rolloutPath)
  } finally {
    rawDb.close()
  }

  const inspected = await f.call('inspect_agent_session', deepen)
  expect(inspected.isError).toBe(false)
  expect(inspected.data.sourceEventCount).toBe(598)
  expect(inspected.data.omittedSourceEvents).toBe(0)
  expect(inspected.data.attemptSummary.dangling).toBe(0)
  expect(inspected.data.attemptSummary.success).toBe(1)

  // Paginate unfiltered events past legacy 512 cap and verify targeted physical byte locator
  let navCursor: string | undefined
  let walkedEvents = 0
  let deepUnfilteredId = ''
  for (;;) {
    const page = await f.call('list_agent_session_events', {
      ...deepen,
      expectedRevision: inspected.data.revision,
      limit: 15,
      ...(navCursor ? { cursor: navCursor } : {})
    })
    expect(page.isError).toBe(false)
    walkedEvents += page.data.events.length
    if (!page.data.nextCursor) {
      deepUnfilteredId = page.data.events.at(-1).eventId
      break
    }
    navCursor = page.data.nextCursor
  }
  expect(walkedEvents).toBe(598)

  const checkLocatorDb = new Database(f.storePath, { readonly: true })
  try {
    const loc = checkLocatorDb.prepare('SELECT lineStart, lineEnd FROM native_reference_events WHERE eventId=?').get(deepUnfilteredId) as { lineStart: number; lineEnd: number }
    expect(loc.lineStart).toBeGreaterThan(8 * 1024 * 1024)
    expect(loc.lineEnd - loc.lineStart).toBeLessThan(16 * 1024)
  } finally {
    checkLocatorDb.close()
  }

  // Filter + query event #598 directly
  const deepEvents = await f.call('list_agent_session_events', {
    ...deepen,
    expectedRevision: inspected.data.revision,
    turnId: 'turn-deep',
    query: 'Deep marker',
    limit: 10
  })
  expect(deepEvents.isError).toBe(false)
  expect(deepEvents.data.events).toHaveLength(1)
  const targetEvent = deepEvents.data.events[0]
  expect(targetEvent.ordinal).toBeGreaterThan(512)

  // Verify UTF-8 literal reading + redaction across pages
  const page1 = await f.call('read_agent_session_event', {
    ...deepen,
    expectedRevision: inspected.data.revision,
    eventId: targetEvent.eventId
  })
  expect(page1.isError).toBe(false)
  expect(page1.data.sanitized).toBe(true)
  expect(page1.data.content).toContain('[REDACTED_TOKEN]')
  expect(page1.data.content).toContain('[REDACTED_PATH]')
  expect(page1.data.content).not.toContain(secretToken)
  expect(page1.data.partial).toBe(true)
  const page2 = await f.call('read_agent_session_event', {
    ...deepen,
    expectedRevision: inspected.data.revision,
    eventId: targetEvent.eventId,
    cursor: page1.data.nextCursor
  })
  expect(page2.isError).toBe(false)
  expect(page2.data.complete).toBe(true)

  // Append-only extension invalidates old expectedRevision and preserves continuity via refresh_agent_sessions
  appendFileSync(rolloutPath, [
    JSON.stringify({ timestamp: '2026-11-18T10:06:00Z', type: 'turn_context', payload: { turn_id: 'turn-appended', cwd: f.root } }),
    JSON.stringify({ timestamp: '2026-11-18T10:06:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Appended event text' }] } })
  ].join('\n') + '\n')

  const conflict = await f.call('inspect_agent_session', { ...deepen, expectedRevision: inspected.data.revision })
  expect(conflict.isError).toBe(true)
  expect(conflict.data.code).toBe('REVISION_CONFLICT')

  let refreshAppend: any
  for (let step = 0; step < 20; step++) {
    const res = await f.call('refresh_agent_sessions', beforeIdx.data.next.arguments)
    expect(res.isError).toBe(false)
    if (res.data.state === 'READY') {
      refreshAppend = res
      break
    }
  }
  expect(refreshAppend.data.state).toBe('READY')
  expect(refreshAppend.data.indexedEvents).toBe(599)

  const afterAppendList = await f.call('list_agent_session_events', {
    ...deepen,
    expectedRevision: refreshAppend.data.revision,
    turnId: 'turn-appended',
    limit: 10
  })
  expect(afterAppendList.isError).toBe(false)
  expect(afterAppendList.data.events).toHaveLength(1)

  // Non-append drift (truncate/rewrite earlier content) rebuilds cleanly without serving corrupt offset
  writeFileSync(rolloutPath, lines.slice(0, 6).join('\n') + '\n')
  const rebuildRefresh = await f.call('refresh_agent_sessions', beforeIdx.data.next.arguments)
  expect(rebuildRefresh.isError).toBe(false)
  expect(rebuildRefresh.data.state).toBe('READY')
  expect(rebuildRefresh.data.indexedEvents).toBe(4)

  // Grant revocation after indexing still blocks reads even with READY row in SQLite
  writeFileSync(f.configPath, JSON.stringify({ repositoryId: 'repo-addr-codex', nativeSources: {} }))
  const revoked = await f.call('inspect_agent_session', deepen)
  expect(revoked.isError).toBe(true)
  expect(revoked.data.code).toBe('SOURCE_NOT_AUTHORIZED')
}, 180_000)

it('U2 indexes >16,384 Antigravity records with multi-part read, readOnly cross-repo queries, and legacy v8 schema compatibility', async () => {
  const f = setupWorkerEnv('repo-addr-ag')
  const agProfile = join(f.base, 'ag-profile')
  const convId = '019ba000-0000-7000-8000-000000000801'
  const convHash = nativeDigest(JSON.stringify(['repo-addr-ag', 'antigravity', convId]))
  const txPath = antigravityAppTranscriptPath(agProfile, convId)
  mkdirSync(dirname(txPath), { recursive: true })

  const rows: string[] = []
  for (let i = 0; i < 16_399; i++) {
    rows.push(JSON.stringify({
      step_index: i,
      source: i % 2 === 0 ? 'USER_EXPLICIT' : 'MODEL',
      type: i % 2 === 0 ? 'USER_INPUT' : 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: `2026-11-18T11:${String(Math.floor(i / 3600)).padStart(2, '0')}:00Z`,
      content: `ag-step-${i}`
    }))
  }
  rows.push(JSON.stringify({
    step_index: 16_399,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-18T16:00:00Z',
    tool_calls: [{ name: 'run_check', args: { cmd: 'npm test', marker: 'ag-deep-part-marker', secret: 'ag-hidden-secret' } }],
    content: 'Multi-part tail answer éção'
  }))
  writeFileSync(txPath, rows.join('\n') + '\n')

  const db = new Database(join(agProfile, 'conversation_summaries.db'))
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, last_modified_time TEXT)')
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run(convId, JSON.stringify([pathToFileURL(f.root).href]), '2026-11-18 16:00:00+00:00')
  db.close()

  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-addr-ag',
    nativeSources: { antigravityApp: { profile: agProfile, sessionHashes: [convHash] } }
  }))

  const deepen = {
    repositoryId: 'repo-addr-ag',
    sourceSessionId: convId,
    nativeSession: { provider: 'antigravity-native' as const, id: convHash, ...f.target }
  }
  let agReady: any
  for (let i = 0; i < 15; i++) {
    const res = await f.call('refresh_agent_sessions', { nativeSession: deepen.nativeSession, sourceSessionId: convId })
    expect(res.isError).toBe(false)
    if (res.data.state === 'READY') {
      agReady = res.data
      break
    }
  }
  expect(agReady.state).toBe('READY')
  expect(agReady.indexedEvents).toBe(16_401)

  // Verify targeted multi-part events at ordinal 16,400 via readOnly SessionStore
  const roStore = new SessionStore(f.storePath, 'repo-addr-ag', true)
  try {
    const listTail = await executeSessionTool(
      roStore, {}, 'list_agent_session_events',
      { ...deepen, expectedRevision: agReady.revision, tool: 'run_check', query: 'ag-deep-part-marker', limit: 5 },
      () => {}, f.target, [{ ...f.target, root: f.root, fingerprint: 'fp' }], undefined, f.root
    )
    expect(listTail.isError).toBeFalsy()
    const listData = JSON.parse((listTail.content[0] as { text: string }).text)
    expect(listData.events).toHaveLength(1)
    expect(listData.events[0].ordinal).toBe(16_400)

    const readTail = await executeSessionTool(
      roStore, {}, 'read_agent_session_event',
      { ...deepen, expectedRevision: agReady.revision, eventId: listData.events[0].eventId },
      () => {}, f.target, [{ ...f.target, root: f.root, fingerprint: 'fp' }], undefined, f.root
    )
    expect(readTail.isError).toBeFalsy()
    const readData = JSON.parse((readTail.content[0] as { text: string }).text)
    expect(readData.content).toContain('ag-deep-part-marker')
    expect(readData.content).not.toContain('ag-hidden-secret')
    expect(readData.sanitized).toBe(true)

    const listTailReply = await executeSessionTool(
      roStore, {}, 'list_agent_session_events',
      { ...deepen, expectedRevision: agReady.revision, types: ['AGENT_UPDATE'], query: 'Multi-part tail answer', limit: 5 },
      () => {}, f.target, [{ ...f.target, root: f.root, fingerprint: 'fp' }], undefined, f.root
    )
    expect(listTailReply.isError).toBeFalsy()
    const replyData = JSON.parse((listTailReply.content[0] as { text: string }).text)
    expect(replyData.events).toHaveLength(1)
    expect(replyData.events[0].ordinal).toBe(16_400)
    const readTailReply = await executeSessionTool(
      roStore, {}, 'read_agent_session_event',
      { ...deepen, expectedRevision: agReady.revision, eventId: replyData.events[0].eventId },
      () => {}, f.target, [{ ...f.target, root: f.root, fingerprint: 'fp' }], undefined, f.root
    )
    expect(JSON.parse((readTailReply.content[0] as { text: string }).text).content).toBe('Multi-part tail answer éção')
  } finally {
    roStore.close()
  }

  // Legacy v8 readOnly DB without native_reference_* tables opens safely and reports INDEXING_PENDING
  const legacyDir = mkdtempSync(join(tmpdir(), 'u2-legacy-v8-'))
  cleanup.push(() => safeRemove(legacyDir))
  const legacyStorePath = sessionStorePath(legacyDir, 'repo-addr-ag')
  const seed = new SessionStore(legacyStorePath, 'repo-addr-ag')
  seed.close()
  const rawLegacy = new Database(legacyStorePath)
  rawLegacy.exec(`
    DROP TABLE IF EXISTS native_reference_sources;
    DROP TABLE IF EXISTS native_reference_checkpoints;
    DROP TABLE IF EXISTS native_reference_events;
    DROP TABLE IF EXISTS native_reference_turns;
  `)
  rawLegacy.close()
  writeFileSync(join(dirname(legacyStorePath), 'session-context.provider.json'), JSON.stringify({
    repositoryId: 'repo-addr-ag',
    nativeSources: { antigravityApp: { profile: agProfile, sessionHashes: [convHash] } }
  }))

  const roLegacy = new SessionStore(legacyStorePath, 'repo-addr-ag', true)
  try {
    expect(roLegacy.references.native.available).toBe(false)
    const roInspect = await executeSessionTool(
      roLegacy, {}, 'inspect_agent_session', deepen,
      () => {}, f.target, [{ ...f.target, root: f.root, fingerprint: 'fp' }], undefined, f.root
    )
    expect(roInspect.isError).toBeFalsy()
    const data = JSON.parse((roInspect.content[0] as { text: string }).text)
    expect(data.indexingState).toBe('INDEXING_PENDING')
    expect(data.reason).toBe('READ_ONLY_STORE')
  } finally {
    roLegacy.close()
  }
}, 60_000)

it('U2 enforces exact snapshot identity continuity, rejects interior+append tampering, handles small <4096 chunks, invalidates v2 indexes lazily, and guards mid-scan mutations', async () => {
  const base = mkdtempSync(join(tmpdir(), 'u2-integrity-'))
  cleanup.push(() => safeRemove(base))
  const root = join(base, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n')
  const storePath = sessionStorePath(base, 'repo-integrity')
  const store = new SessionStore(storePath, 'repo-integrity')
  cleanup.push(() => store.close())

  const target = { worktreeId: nativeDigest('wt:integrity'), generation: nativeDigest('gen:integrity') }
  const live = [{ ...target, root, fingerprint: sourceFingerprint(root) }]
  const profile = join(base, 'codex-integrity')
  const sessionUuid = '01a1e000-0000-7000-8000-000000000955'
  const uuidDay = new Date(Number.parseInt(sessionUuid.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).split('-')
  const rolloutDir = join(profile, 'sessions', ...uuidDay)
  mkdirSync(rolloutDir, { recursive: true })
  const accHash = nativeDigest(JSON.stringify(['int-u', 'int-a']))
  const configPath = join(dirname(storePath), 'session-context.provider.json')
  writeFileSync(configPath, JSON.stringify({
    repositoryId: 'repo-integrity',
    nativeSources: { codex: { profile, creatorAccountHash: accHash } }
  }))

  const nativeHash = nativeDigest(JSON.stringify(['repo-integrity', 'codex', sessionUuid]))
  const nativeSession = { provider: 'codex-native' as const, id: nativeHash, ...target }
  const deepen = { repositoryId: 'repo-integrity', sourceSessionId: sessionUuid, nativeSession }

  // Small fixture (~9 KB) crossing 4096 prefix and 512 tail windows cleanly
  const buildLines = (middleTag: string, includeCallOutput = false) => {
    const out: string[] = [
      JSON.stringify({
        timestamp: '2026-11-19T10:00:00Z',
        type: 'session_meta',
        payload: {
          id: sessionUuid, session_id: sessionUuid, account_scoped: true,
          creator_user_id: 'int-u', creator_account_id: 'int-a',
          cwd: root, runtime_workspace_roots: [root], cli_version: '0.169.0-alpha.11.1'
        }
      }),
      JSON.stringify({ timestamp: '2026-11-19T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: root } }),
      // >4096 bytes prefix block before interior region
      ...Array.from({ length: 10 }, (_, i) => JSON.stringify({
        timestamp: '2026-11-19T10:00:02Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `prefix-${i}:${'a'.repeat(450)}` }] }
      })),
      // Interior region past 4096 bytes (including an attempt)
      JSON.stringify({ timestamp: '2026-11-19T10:01:00Z', type: 'response_item', payload: { type: 'function_call', name: 'interior_tool', call_id: 'call-int', arguments: '{}' } }),
      JSON.stringify({ timestamp: '2026-11-19T10:01:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: middleTag }] } }),
      // >512 bytes unchanged tail region
      ...Array.from({ length: 2 }, (_, i) => JSON.stringify({
        timestamp: '2026-11-19T10:02:00Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `tail-${i}:${'z'.repeat(300)}` }] }
      }))
    ]
    if (includeCallOutput) {
      out.push(JSON.stringify({ timestamp: '2026-11-19T10:03:00Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-int', output: 'Exit code: 0\nok' } }))
    }
    return out.join('\n') + '\n'
  }

  const rolloutPath = join(rolloutDir, `rollout-2026-11-19T10-00-00-${sessionUuid}.jsonl`)
  writeFileSync(rolloutPath, buildLines('INTERIOR_V1', false))
  expect(readFileSync(rolloutPath).length).toBeGreaterThan(5000)

  const callTool = async (name: Parameters<typeof executeSessionTool>[2], args: unknown, budget?: { maxBytes?: number; maxLines?: number; onDemandMaxBytes?: number }, assertCurrent = () => {}) => {
    const res = await executeSessionTool(
      store, {}, name, args, assertCurrent, target, live, undefined, root,
      undefined, undefined, undefined, undefined, undefined, false, undefined, undefined, budget
    )
    return { isError: !!res.isError, data: JSON.parse((res.content[0] as { text: string }).text) }
  }

  // (b) Intact snapshot with first chunk < 4096 bytes resumes across checkpoints cleanly
  const smallChunk = { maxBytes: 1800, maxLines: 100, onDemandMaxBytes: 0 }
  const step1 = await callTool('refresh_agent_sessions', { nativeSession, sourceSessionId: sessionUuid }, smallChunk)
  expect(step1.isError).toBe(false)
  expect(step1.data.state).toBe('INDEXING_PENDING')
  expect(step1.data.indexedBytes).toBeLessThan(4096)

  const step2 = await callTool('refresh_agent_sessions', step1.data.next.arguments, smallChunk)
  expect(step2.isError).toBe(false)
  expect(step2.data.state).toBe('INDEXING_PENDING')
  expect(step2.data.indexedBytes).toBeGreaterThan(step1.data.indexedBytes)

  let ready1: any
  for (let i = 0; i < 10; i++) {
    const res = await callTool('refresh_agent_sessions', step1.data.next.arguments, smallChunk)
    if (res.data.state === 'READY') { ready1 = res.data; break }
  }
  expect(ready1.state).toBe('READY')

  const listV1 = await callTool('list_agent_session_events', { ...deepen, expectedRevision: ready1.revision, limit: 5 }, { onDemandMaxBytes: 100_000 })
  expect(listV1.isError).toBe(false)
  expect(listV1.data.nextCursor).toBeDefined()
  const listAllV1 = await callTool('list_agent_session_events', { ...deepen, expectedRevision: ready1.revision, limit: 15 }, { onDemandMaxBytes: 100_000 })
  const interiorEv1 = listAllV1.data.events.find((e: any) => e.ordinal === 14)
  expect(interiorEv1).toBeDefined()
  const readV1 = await callTool('read_agent_session_event', { ...deepen, expectedRevision: ready1.revision, eventId: interiorEv1.eventId }, { onDemandMaxBytes: 100_000 })
  expect(readV1.data.content).toBe('INTERIOR_V1')

  // (a1) Interior alteration + append AFTER READY (preserving exact 4096-byte prefix and 512-byte tail)
  // Must NOT reuse old READY or append tail; old revision, cursor, and eventId must be rejected
  writeFileSync(rolloutPath, buildLines('INTERIOR_TAMPERED_V2', true))
  const staleRevRead = await callTool('read_agent_session_event', { ...deepen, expectedRevision: ready1.revision, eventId: interiorEv1.eventId }, { onDemandMaxBytes: 100_000 })
  expect(staleRevRead.isError).toBe(true)
  expect(staleRevRead.data.code).toBe('REVISION_CONFLICT')

  const staleCursorList = await callTool('list_agent_session_events', { ...deepen, cursor: listV1.data.nextCursor, limit: 15 }, { onDemandMaxBytes: 100_000 })
  expect(staleCursorList.isError).toBe(true)

  const inspectV2 = await callTool('inspect_agent_session', deepen, { onDemandMaxBytes: 100_000 })
  expect(inspectV2.isError).toBe(false)
  expect(inspectV2.data.revision).not.toBe(ready1.revision)
  expect(inspectV2.data.attemptSummary.dangling).toBe(0)
  expect(inspectV2.data.attemptSummary.success).toBe(1)

  const oldEventIdOnNewRev = await callTool('read_agent_session_event', { ...deepen, expectedRevision: inspectV2.data.revision, eventId: interiorEv1.eventId }, { onDemandMaxBytes: 100_000 })
  expect(oldEventIdOnNewRev.isError).toBe(true)
  expect(oldEventIdOnNewRev.data.code).toBe('SOURCE_EVENT_UNAVAILABLE')

  const newQuery = await callTool('list_agent_session_events', { ...deepen, expectedRevision: inspectV2.data.revision, query: 'INTERIOR_TAMPERED_V2', limit: 10 }, { onDemandMaxBytes: 100_000 })
  expect(newQuery.data.events).toHaveLength(1)

  // (a2) Interior alteration + append BETWEEN incomplete checkpoint steps
  writeFileSync(rolloutPath, buildLines('INTERIOR_MID_STAGE1', false))
  const midStep1 = await callTool('refresh_agent_sessions', { nativeSession, sourceSessionId: sessionUuid }, { maxBytes: 2500, maxLines: 100 })
  expect(midStep1.data.state).toBe('INDEXING_PENDING')
  writeFileSync(rolloutPath, buildLines('INTERIOR_MID_STEP_V3', true))
  let rebuiltV3: any
  for (let i = 0; i < 10; i++) {
    const res = await callTool('refresh_agent_sessions', { nativeSession, sourceSessionId: sessionUuid }, { maxBytes: 2500, maxLines: 100 })
    if (res.data.state === 'READY') { rebuiltV3 = res.data; break }
  }
  expect(rebuiltV3.state).toBe('READY')
  const qOldMid = await callTool('list_agent_session_events', { ...deepen, expectedRevision: rebuiltV3.revision, query: 'INTERIOR_MID_STAGE1', limit: 10 }, { onDemandMaxBytes: 100_000 })
  expect(qOldMid.data.events).toHaveLength(0)
  const qNewMid = await callTool('list_agent_session_events', { ...deepen, expectedRevision: rebuiltV3.revision, query: 'INTERIOR_MID_STEP_V3', limit: 10 }, { onDemandMaxBytes: 100_000 })
  expect(qNewMid.data.events).toHaveLength(1)

  // (c1) Legacy v2 normalizer rows are never served silently or written in READ_ONLY, and are lazily rebuilt under v3
  const v2Raw = new Database(storePath)
  v2Raw.prepare("UPDATE native_reference_sources SET normalizer = 'native-codex-v2'").run()
  v2Raw.close()

  const roStore = new SessionStore(storePath, 'repo-integrity', true)
  try {
    const roPending = await executeSessionTool(roStore, {}, 'inspect_agent_session', deepen, () => {}, target, live, undefined, root)
    const roData = JSON.parse((roPending.content[0] as { text: string }).text)
    expect(roData.indexingState).toBe('INDEXING_PENDING')
    expect(roData.reason).toBe('READ_ONLY_STORE')

    const roStaleRev = await executeSessionTool(roStore, {}, 'list_agent_session_events', { ...deepen, expectedRevision: rebuiltV3.revision, limit: 5 }, () => {}, target, live, undefined, root)
    expect(roStaleRev.isError).toBe(true)
    expect(JSON.parse((roStaleRev.content[0] as { text: string }).text).code).toBe('REVISION_CONFLICT')
  } finally {
    roStore.close()
  }

  // Writable refresh lazily replaces only this session's v2 index with v3 without global migration
  const rebuiltFromV2 = await callTool('refresh_agent_sessions', { nativeSession, sourceSessionId: sessionUuid }, { maxBytes: 100_000, maxLines: 100 })
  expect(rebuiltFromV2.data.state).toBe('READY')
  expect(rebuiltFromV2.data.revision).not.toBe(rebuiltV3.revision)

  // (c2) Mid-scan file mutation never promotes incoherent staging; returns actionable SOURCE_STALE / INDEXING_PENDING cleanly
  writeFileSync(rolloutPath, buildLines('INTERIOR_PRE_RACE', false))
  let asserts = 0
  let mutations = 0
  const mutatingRes = await callTool('refresh_agent_sessions', { nativeSession, sourceSessionId: sessionUuid }, { maxBytes: 2500, maxLines: 100 }, () => {
    asserts++
    if ((asserts === 3 || asserts === 7) && mutations < 2) {
      mutations++
      appendFileSync(rolloutPath, JSON.stringify({ timestamp: '2026-11-19T10:09:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `race-${mutations}` }] } }) + '\n')
    }
  })
  expect(mutations).toBe(2)
  expect(mutatingRes.isError).toBe(false)
  expect(mutatingRes.data.state).toBe('INDEXING_PENDING')
  expect(mutatingRes.data.reason).toBe('SOURCE_STALE')
  expect(mutatingRes.data.next.tool).toBe('refresh_agent_sessions')

  const cpCheck = new Database(storePath, { readonly: true })
  try {
    expect((cpCheck.prepare('SELECT COUNT(*) AS c FROM native_reference_checkpoints').get() as { c: number }).c).toBe(0)
  } finally {
    cpCheck.close()
  }
}, 60_000)

it('U2 addresses every Antigravity record (INPUT, TOOL_CALL, AGENT_UPDATE, TOOL_RESULT, OPAQUE, oversized UNAVAILABLE, post-limit) without dumping bodies or exposing opaque text in FTS', async () => {
  const f = setupWorkerEnv('repo-u2-focal')
  const agProfile = join(f.base, '.gemini', 'antigravity')
  const convId = '019ba000-0000-7000-8000-000000000899'
  const convHash = nativeDigest(JSON.stringify(['repo-u2-focal', 'antigravity', convId]))
  const txPath = join(agProfile, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl')
  mkdirSync(dirname(txPath), { recursive: true })

  const oversizedContent = 'X'.repeat(540 * 1024)
  const opaqueSecretMarker = 'opaque_hidden_lexical_phrase_991'
  const rows = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: '2026-11-23T10:00:00Z', content: 'start-input-sentinel token=ag-secret-123' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-11-23T10:00:01Z', tool_calls: [{ name: 'read_file', args: { path: 'a.ts' } }], content: 'planner-update-sentinel' }),
    JSON.stringify({ step_index: 2, type: 'TASK_BOUNDARY', source: 'SYSTEM', created_at: '2026-11-23T10:00:02Z', content: opaqueSecretMarker }),
    JSON.stringify({ step_index: 3, type: 'GENERIC', source: 'MODEL', created_at: '2026-11-23T10:00:03Z', content: 'tool-result-sentinel' }),
    JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-11-23T10:00:04Z', content: oversizedContent }),
    JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-11-23T10:00:05Z', content: 'post-limit-tail-sentinel discriminative_tail_phrase_882' })
  ]
  writeFileSync(txPath, rows.join('\n') + '\n')

  const db = new Database(join(agProfile, 'conversation_summaries.db'))
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, last_modified_time TEXT)')
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run(convId, JSON.stringify([pathToFileURL(f.root).href]), '2026-11-23 10:00:05+00:00')
  db.close()

  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u2-focal',
    nativeSources: { antigravityApp: { profile: agProfile, sessionHashes: [convHash], allowLexicalIndex: true } }
  }))

  const listed = await f.call('list_agent_sessions', { ...f.target })
  expect(listed.isError).toBe(false)
  expect(listed.data.sessions).toHaveLength(1)
  const deepen = listed.data.sessions[0].deepen.arguments

  let ready: any
  for (let i = 0; i < 10; i++) {
    const res = await f.call('refresh_agent_sessions', { nativeSession: deepen.nativeSession, sourceSessionId: deepen.sourceSessionId })
    expect(res.isError).toBe(false)
    if (res.data.state === 'READY') { ready = res.data; break }
  }
  expect(ready.state).toBe('READY')

  const map = await f.call('inspect_agent_session', deepen)
  expect(map.isError).toBe(false)
  expect(map.data.readinessReason).toBe('READY')
  expect(map.data.sourceVariant).toBe('TRANSCRIPT_DOCUMENTED')
  expect(map.data.recordCoverage).toMatchObject({
    recordsTotal: 6,
    recordsAddressable: 6,
    typed: 4,
    opaque: 1,
    unavailable: 1,
    coverage: 'PARTIAL'
  })

  const evPage = await f.call('list_agent_session_events', { ...deepen, expectedRevision: map.data.revision, limit: 15 })
  expect(evPage.isError).toBe(false)
  // 1 INPUT + 2 (TOOL_CALL, AGENT_UPDATE) + 1 OPAQUE + 1 TOOL_RESULT + 1 UNAVAILABLE + 1 AGENT_UPDATE = 7 rows
  expect(evPage.data.events).toHaveLength(7)
  const opaqueEv = evPage.data.events.find((e: any) => e.type === 'OPAQUE')
  const unavailableEv = evPage.data.events.find((e: any) => e.type === 'UNAVAILABLE')
  const inputEv = evPage.data.events.find((e: any) => e.type === 'INPUT')
  const tailEv = evPage.data.events.at(-1)
  expect(opaqueEv).toMatchObject({ ordinal: 3, recordKind: 'OPAQUE', limitation: 'UNRECOGNIZED_FORMAT' })
  expect(unavailableEv).toMatchObject({ ordinal: 5, recordKind: 'UNAVAILABLE', limitation: 'RECORD_TOO_LARGE' })

  const readInput = await f.call('read_agent_session_event', { ...deepen, expectedRevision: map.data.revision, eventId: inputEv.eventId })
  expect(readInput.data.content).toBe('start-input-sentinel token=[REDACTED]')
  expect(readInput.data.sanitized).toBe(true)

  const readOpaque = await f.call('read_agent_session_event', { ...deepen, expectedRevision: map.data.revision, eventId: opaqueEv.eventId })
  expect(readOpaque.isError).toBe(false)
  expect(readOpaque.data).toMatchObject({ recordKind: 'OPAQUE', limitation: 'UNRECOGNIZED_FORMAT', content: '' })
  expect(JSON.stringify(readOpaque.data)).not.toContain(opaqueSecretMarker)

  const readUnavailable = await f.call('read_agent_session_event', { ...deepen, expectedRevision: map.data.revision, eventId: unavailableEv.eventId })
  expect(readUnavailable.isError).toBe(false)
  expect(readUnavailable.data).toMatchObject({ recordKind: 'UNAVAILABLE', limitation: 'RECORD_TOO_LARGE', content: '' })

  const readTail = await f.call('read_agent_session_event', { ...deepen, expectedRevision: map.data.revision, eventId: tailEv.eventId })
  expect(readTail.data.content).toContain('post-limit-tail-sentinel')

  // FTS must find typed tail phrase and must NOT expose opaque content
  const ftsTail = await f.call('search_agent_session_evidence', { ...deepen, query: 'discriminative_tail_phrase_882', limit: 5 })
  expect(ftsTail.isError).toBe(false)
  expect(ftsTail.data.hits).toHaveLength(1)
  const ftsOpaque = await f.call('search_agent_session_evidence', { ...deepen, query: opaqueSecretMarker, limit: 5 })
  expect(ftsOpaque.isError).toBe(false)
  expect(ftsOpaque.data.hits).toHaveLength(0)

  // Snapshot changed -> REVISION_CONFLICT
  appendFileSync(txPath, JSON.stringify({ step_index: 6, type: 'USER_INPUT', source: 'USER', created_at: '2026-11-23T10:00:06Z', content: 'after-append' }) + '\n')
  const staleRead = await f.call('read_agent_session_event', { ...deepen, expectedRevision: map.data.revision, eventId: tailEv.eventId })
  expect(staleRead.isError).toBe(true)
  expect(staleRead.data.code).toBe('REVISION_CONFLICT')

  // Grant revoked -> blocks reads
  writeFileSync(f.configPath, JSON.stringify({ repositoryId: 'repo-u2-focal', nativeSources: {} }))
  const revokedInspect = await f.call('inspect_agent_session', deepen)
  expect(revokedInspect.data.contentAvailability).toBe('SOURCE_UNAVAILABLE')
  expect(revokedInspect.data.readinessReason).toBe('GRANT_MISSING')
  writeFileSync(f.configPath, JSON.stringify({ repositoryId: 'repo-u2-focal', nativeSources: { antigravityApp: { profile: agProfile, sessionHashes: ['0'.repeat(64)] } } }))
  const invalidInspect = await f.call('inspect_agent_session', deepen)
  expect(invalidInspect.data.contentAvailability).toBe('SOURCE_UNAVAILABLE')
  expect(invalidInspect.data.readinessReason).toBe('GRANT_INVALID_OR_REVOKED')
}, 60_000)

it('U4 classifies opaque Codex protocol metadata separately from unqualified/unrecognized records and enforces LEXICAL_INDEX_NOT_AUTHORIZED vs authorized FTS5 search', async () => {
  const f = setupWorkerEnv('repo-u4-lexical')
  const profile = join(f.base, 'codex-profile')
  const sessionUuid = '01a1f300-0000-7000-8000-000000000909'
  const day = new Date(Number.parseInt(sessionUuid.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).split('-')
  const rolloutDir = join(profile, 'sessions', ...day)
  mkdirSync(rolloutDir, { recursive: true })
  const accHash = nativeDigest(JSON.stringify(['u4-u', 'u4-a']))
  const rolloutPath = join(rolloutDir, `rollout-2026-11-23T10-00-00-${sessionUuid}.jsonl`)

  writeFileSync(rolloutPath, [
    JSON.stringify({ timestamp: '2026-11-23T10:00:00Z', type: 'session_meta', payload: { id: sessionUuid, session_id: sessionUuid, account_scoped: true, creator_user_id: 'u4-u', creator_account_id: 'u4-a', cwd: f.root, runtime_workspace_roots: [f.root], cli_version: '0.171.0-alpha.13' } }),
    JSON.stringify({ timestamp: '2026-11-23T10:00:01Z', type: 'turn_context', payload: { turn_id: 't1', cwd: f.root } }),
    JSON.stringify({ timestamp: '2026-11-23T10:00:02Z', type: 'event_msg', payload: { type: 'token_count', total_tokens: 100 } }),
    JSON.stringify({ timestamp: '2026-11-23T10:00:03Z', type: 'event_msg', payload: { type: 'item_completed', item_id: 'i1' } }),
    JSON.stringify({ timestamp: '2026-11-23T10:00:04Z', type: 'event_msg', payload: { type: 'agent_reasoning', text: 'hidden_private_thought_999' } }),
    JSON.stringify({ timestamp: '2026-11-23T10:00:05Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Literal answer with discriminative_u4_token_777' }] } })
  ].join('\n') + '\n')

  // 1. Grant without allowLexicalIndex -> search returns LEXICAL_INDEX_NOT_AUTHORIZED
  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u4-lexical',
    nativeSources: { codex: { profile, creatorAccountHash: accHash, allowLexicalIndex: false } }
  }))

  const listed = await f.call('list_agent_sessions', { ...f.target })
  const deepen = listed.data.sessions[0].deepen.arguments
  const map = await f.call('inspect_agent_session', deepen)
  expect(map.isError).toBe(false)
  expect(map.data.recordCoverage).toMatchObject({
    recordsTotal: 6,
    recordsAddressable: 6,
    typed: 1,
    opaque: 5,
    unavailable: 0,
    interpretedContentCoverage: 'PARTIAL',
    opaqueBreakdown: {
      protocolMetadata: 4,
      unqualifiedContent: 1,
      unrecognizedFormat: 0,
      unavailable: 0
    }
  })

  const deniedSearch = await f.call('search_agent_session_evidence', {
    ...f.target,
    query: 'discriminative_u4_token_777',
    limit: 5
  })
  expect(deniedSearch.isError).toBe(false)
  expect(deniedSearch.data.hits).toHaveLength(0)
  expect(deniedSearch.data.coverage.nativeSource).toMatchObject({
    state: 'LEXICAL_INDEX_NOT_AUTHORIZED',
    reason: 'LEXICAL_INDEX_NOT_AUTHORIZED',
    next: { action: 'ENABLE_LEXICAL_INDEX', requires: ['allowLexicalIndex'] }
  })

  // 2. Enable allowLexicalIndex -> FTS5 indexes typed content (not private reasoning) and returns deepening selector
  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u4-lexical',
    nativeSources: { codex: { profile, creatorAccountHash: accHash, allowLexicalIndex: true } }
  }))
  const refreshed = await f.call('refresh_agent_sessions', { nativeSession: deepen.nativeSession, sourceSessionId: deepen.sourceSessionId })
  expect(refreshed.data.state).toBe('READY')

  const allowedSearch = await f.call('search_agent_session_evidence', {
    ...f.target,
    query: 'discriminative_u4_token_777',
    limit: 5
  })
  expect(allowedSearch.isError).toBe(false)
  expect(allowedSearch.data.coverage.nativeSource.state).toBe('READY')
  expect(allowedSearch.data.hits).toHaveLength(1)
  const hit = allowedSearch.data.hits[0]
  expect(JSON.stringify(hit)).not.toContain('Literal answer')
  const readHit = await f.call('read_agent_session_event', hit.deepen.arguments)
  expect(readHit.data.content).toBe('Literal answer with discriminative_u4_token_777')

  const reasoningSearch = await f.call('search_agent_session_evidence', {
    ...f.target,
    query: 'hidden_private_thought_999',
    limit: 5
  })
  expect(reasoningSearch.data.hits).toHaveLength(0)
}, 60_000)
