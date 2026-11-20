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

  // Before indexing, large session (>512 KiB) returns INDEXING_PENDING without loading body
  const beforeIdx = await f.call('inspect_agent_session', deepen)
  expect(beforeIdx.isError, JSON.stringify(beforeIdx.data)).toBe(false)
  expect(beforeIdx.data.indexingState).toBe('INDEXING_PENDING')
  expect(beforeIdx.data.next.tool).toBe('refresh_agent_sessions')

  const pendingEvents = await f.call('list_agent_session_events', { ...deepen, expectedRevision: beforeIdx.data.revision, limit: 15 })
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

  const refreshAppend = await f.call('refresh_agent_sessions', beforeIdx.data.next.arguments)
  expect(refreshAppend.isError).toBe(false)
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
}, 120_000)

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
  for (let i = 0; i < 10; i++) {
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
