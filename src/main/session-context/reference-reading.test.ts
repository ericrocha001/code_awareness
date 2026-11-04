import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SessionStore, sessionStorePath } from './store'
import { EntireProvider, runReadOnly, type CommandRunner } from './entire-provider'
import { executeSessionTool } from './mcp'
import { digest } from './privacy'
import { legacyStoreFixture } from './fixtures/legacy-store-fixture'
import { reconcileRegistry } from './registry-reconciliation'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup.length = 0 })
const data = (result: { content: readonly unknown[] }) => JSON.parse((result.content[0] as { text: string }).text)
async function fixture(legacyText?: string) {
  const base = mkdtempSync(join(tmpdir(), 'reference-reading-')), root = join(base, 'repo')
  mkdirSync(root); cleanup.push(() => rmSync(base, { recursive: true, force: true }))
  await runReadOnly('git', ['init', '-q'], root, 4096)
  const path = sessionStorePath(base, 'repo')
  if (legacyText !== undefined) {
    const legacy = legacyStoreFixture(path, 'repo', base)
    legacy.ingest({ providerSessionId: 'legacy', providerVersion: '0.12.2', agent: 'codex', state: 'UNKNOWN', coverage: 'COMPLETE', sourceDigest: digest('old-source'), sourceBytes: 100 }, [{ type: 'INPUT', text: legacyText, sourcePosition: 2 }])
    legacy.close()
  }
  const store = new SessionStore(path, 'repo'); cleanup.push(() => store.close())
  const executable = join(base, process.platform === 'win32' ? 'entire.exe' : 'entire'); writeFileSync(executable, 'fixture Entire executable')
  writeFileSync(join(dirname(store.path), 'session-context.provider.json'), JSON.stringify({ enabled: true, repositoryId: 'repo', executable, version: '0.12.2', sha256: digest('fixture Entire executable') }))
  mkdirSync(join(root, '.entire')); writeFileSync(join(root, '.entire/settings.local.json'), JSON.stringify({ strategy_options: { push_sessions: false }, telemetry: false }))
  const sessions: { session_id: string; agent: string; status: string; worktree_path: string }[] = []
  const calls: string[][] = []
  const run: CommandRunner = async (_exe, args, cwd, limit, consume, timeout) => {
    calls.push(args)
    if (args.includes('ls-files')) return { code: 1, text: '', limited: false }
    if (args.includes('--git-common-dir')) return { code: 0, text: join(root, '.git'), limited: false }
    if (_exe === 'git') return runReadOnly(_exe, args, cwd, limit, consume, timeout)
    if (args[0] === 'version') return { code: 0, text: 'Entire CLI 0.12.2', limited: false }
    if (args.includes('--help')) return { code: 0, text: '--json --transcript', limited: false }
    if (args.includes('--transcript')) throw new Error('FIXTURE_MUST_USE_ENTIRE_COPY')
    return { code: 0, text: JSON.stringify(args[1] === 'list' ? sessions : sessions.find(session => session.session_id === args[2])), limited: false }
  }
  const provider = new EntireProvider(store, root, () => {}, run)
  let indexFailure: unknown
  const commit = store.references.commit.bind(store.references)
  vi.spyOn(store.references, 'commit').mockImplementation((...args) => { try { return commit(...args) } catch (error) { indexFailure = error; throw error } })
  const add = (id: string, agent: string, records: object[]) => {
    sessions.push({ session_id: id, agent, status: 'ACTIVE', worktree_path: root })
    const directory = join(root, '.entire/metadata', id); mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'full.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n')
  }
  return { base, root, store, provider, sessions, calls, add, run, failure: () => { if (indexFailure) throw indexFailure } }
}
it('indexes distinct Entire agents through SQLite and MCP without a vendor account or body persistence', async () => {
  const f = await fixture()
  f.add('codex-session', 'Codex', [{ type: 'session_meta', payload: { id: 'codex-session', cwd: f.root } }, { type: 'event_msg', payload: { type: 'user_message', message: 'CODEX_LITERAL_PRIVATE' } }])
  f.add('antigravity-session', 'Antigravity', [{ step_index: 0, type: 'USER_INPUT', source: 'user', content: 'ANTIGRAVITY_LITERAL_PRIVATE', created_at: '2026-11-04T00:00:00Z' }])
  expect(await f.provider.refresh()).toMatchObject({ imported: 2, transcriptImported: false })
  for (const agent of ['codex', 'antigravity']) {
    const session = f.store.byProvider(agent + '-session', 'entire', agent)!
    const indexed = await f.provider.refresh(session.id); f.failure()
    expect(indexed, JSON.stringify(indexed)).toMatchObject({ importState: 'TRANSCRIPT_REFERENCED', eventCount: 1 })
    const list = data(await executeSessionTool(f.store, f.provider, 'list_agent_sessions', { agent }, () => {}))
    expect(list.sessions).toHaveLength(1); expect(list.sessions[0].agent).toBe(agent)
    const event = f.store.events(session.id, {}, 0, 1)[0]
    const literal = data(await executeSessionTool(f.store, f.provider, 'read_agent_session_event', { sessionId: session.id, eventId: event.id, expectedRevision: f.store.session(session.id).revision }, () => {}))
    expect(literal.content).toBe(agent === 'codex' ? 'CODEX_LITERAL_PRIVATE' : 'ANTIGRAVITY_LITERAL_PRIVATE')
  }
  const db = new Database(f.store.path, { readonly: true })
  try {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='event_payloads'").get()).toBeUndefined()
    expect((db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).some(column => column.name === 'summary')).toBe(false)
  } finally { db.close() }
  expect(f.calls.some(args => args.includes('app-server') || args.includes('--transcript'))).toBe(false)
})
it('reopens the literal from a verified checkpoint blob when the local Entire copy disappears', async () => {
  const f = await fixture(), checkpoint = 'abcdef123456'
  f.add('checkpoint-session', 'codex', [{ type: 'session_meta', payload: { id: 'checkpoint-session', cwd: f.root } }, { type: 'event_msg', payload: { type: 'user_message', message: 'checkpoint literal token=private-fixture' } }])
  await f.provider.refresh()
  const session = f.store.byProvider('checkpoint-session')!
  const git = (args: string[], input?: string | Buffer) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: f.root, input, encoding: 'utf8', windowsHide: true }).trim()
  const blob = (text: string | Buffer) => git(['hash-object', '-w', '--stdin'], text)
  const sourcePath = join(f.root, '.entire/metadata/checkpoint-session/full.jsonl')
  const full = blob(readFileSync(sourcePath))
  const metadata = blob(JSON.stringify({ cli_version: '0.12.2', checkpoint_id: checkpoint, session_id: 'checkpoint-session', agent: 'Codex' }))
  const tree = git(['mktree'], `100644 blob ${metadata}\tmetadata.json\n100644 blob ${full}\tfull.jsonl\n`)
  const top = blob(JSON.stringify({ cli_version: '0.12.2', checkpoint_id: checkpoint, sessions: [{}] }))
  const root = git(['mktree'], `040000 tree ${tree}\t0\n100644 blob ${top}\tmetadata.json\n`)
  const commit = git(['commit-tree', root], `fixture\n\nEntire-Checkpoint: ${checkpoint}\n`)
  git(['update-ref', `refs/entire/checkpoints/56/${checkpoint}`, commit])
  await reconcileRegistry(f.store, f.run, f.root, { kind: 'COMMIT', id: commit }, () => {})
  unlinkSync(sourcePath)
  expect(await f.provider.refresh(session.id)).toMatchObject({ importState: 'TRANSCRIPT_REFERENCED', eventCount: 1 })
  expect(f.store.references.source(session.id)?.locator.kind).toBe('ENTIRE_CHECKPOINT')
  const result = data(await executeSessionTool(f.store, f.provider, 'read_agent_session_event', { sessionId: session.id, eventId: f.store.events(session.id, {}, 0, 1)[0].id, expectedRevision: f.store.session(session.id).revision }, () => {}))
  expect(result.content).toBe('checkpoint literal token=[REDACTED]')
  expect(result.complete).toBe(true)
}, 30000)
it('discards legacy text explicitly and reads the available Entire source after restart without comparing old content', async () => {
  const f = await fixture('old content intentionally discarded'), session = f.store.byProvider('legacy')!, event = f.store.events(session.id, {}, 0, 1)[0]
  const identity = f.store.registry.sessionIdentity(session.id)
  f.add('legacy', 'codex', [{ type: 'session_meta', payload: { id: 'legacy', cwd: f.root } }, { type: 'event_msg', payload: { type: 'user_message', message: 'available Entire literal' } }])
  expect(await f.provider.refresh(session.id)).toMatchObject({ code: 'LEGACY_TEXT_DISCARD_REQUIRED' })
  const result = data(await executeSessionTool(f.store, f.provider, 'refresh_agent_sessions', { discardLegacyText: true }, () => {}, { worktreeId: 'a'.repeat(64), generation: 'b'.repeat(64) }))
  expect(result).toMatchObject({ state: 'LEGACY_TEXT_DISCARDED', discardedSessions: 1 })
  expect(await f.provider.refresh(session.id)).toMatchObject({ importState: 'TRANSCRIPT_REFERENCED' })
  expect(f.store.events(session.id, {}, 0, 1)[0].id).toBe(event.id)
  expect(f.store.registry.sessionIdentity(session.id)).toEqual(identity)
  const reopened = new SessionStore(f.store.path, 'repo')
  try {
    expect(reopened.event(session.id, event.id).text).toBeNull()
    const provider = new EntireProvider(reopened, f.root, () => {}, f.run)
    expect((await provider.readEvent(reopened.session(session.id), reopened.events(session.id, {}, 0, 1)[0], 0)).content).toBe('available Entire literal')
    expect(await provider.refresh(session.id)).toMatchObject({ replay: true })
  } finally { reopened.close() }
})
it('discards a sole legacy copy without source recovery, preserving relations and rollback', async () => {
  const f = await fixture('sole SQLite copy'), session = f.store.byProvider('legacy')!, event = f.store.events(session.id, {}, 0, 1)[0]
  const target = { worktreeId: 'a'.repeat(64), generation: 'b'.repeat(64) }
  f.store.observeWorktree(session.id, target)
  const relations = f.store.associations(session.id), identity = f.store.registry.sessionIdentity(session.id)
  let checks = 0
  expect(() => f.store.references.discardLegacyText(() => { if (++checks === 2) throw new Error('CANCELLED') })).toThrow('CANCELLED')
  expect(f.store.event(session.id, event.id).text).toBe('sole SQLite copy')
  expect(f.store.session(session.id).revision).toBe(session.revision)
  expect(f.store.references.discardLegacyText(() => {})).toEqual({ complete: true, discardedSessions: 1 })
  expect(f.store.event(session.id, event.id).text).toBeNull()
  expect(f.store.associations(session.id)).toEqual(relations)
  expect(f.store.registry.sessionIdentity(session.id)).toEqual(identity)
  const read = data(await executeSessionTool(f.store, f.provider, 'read_agent_session_event', { sessionId: session.id, eventId: event.id, expectedRevision: f.store.session(session.id).revision }, () => {}))
  expect(read.code).toBe('SOURCE_UNAVAILABLE')
  expect(f.store.references.discardLegacyText(() => {})).toEqual({ complete: true, discardedSessions: 0 })
  const db = new Database(f.store.path, { readonly: true })
  try {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='event_payloads'").get()).toBeUndefined()
    expect((db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).some(column => column.name === 'summary')).toBe(false)
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally { db.close() }
})
it('indexes over 500 identities with overlapping agent IDs and retains namespace isolation', async () => {
  const f = await fixture()
  for (let n = 0; n < 501; n++) f.sessions.push({ session_id: 'session-' + n, agent: 'codex', status: 'ACTIVE', worktree_path: f.root })
  f.sessions.push({ session_id: 'session-0', agent: 'antigravity', status: 'ACTIVE', worktree_path: f.root })
  expect(await f.provider.refresh()).toMatchObject({ imported: 502, coverage: 'COMPLETE' })
  expect(f.store.byProvider('session-0', 'entire', 'codex')?.id).not.toBe(f.store.byProvider('session-0', 'entire', 'antigravity')?.id)
  expect(f.store.count()).toBe(502)
})
it('reads a >8MiB event to its last byte via MCP cursors after indexing >20000 events', async () => {
  const f = await fixture(), literal = 'unchanged-'.repeat(940000) + 'END_LITERAL_MARKER'
  const records = [{ type: 'session_meta', payload: { id: 'extensive', cwd: f.root } }, ...Array.from({ length: 20000 }, () => ({ type: 'event_msg', payload: { type: 'agent_message', message: 'small literal' } })), { type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', call_id: 'large-tool', arguments: '*** Update File: src/fixture.ts\n+fixture' } }, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'large-tool', output: literal } }]
  f.add('extensive', 'codex', records)
  await f.provider.refresh()
  const session = f.store.byProvider('extensive')!
  const indexed = await f.provider.refresh(session.id); f.failure()
  expect(indexed, JSON.stringify(indexed)).toMatchObject({ eventCount: 20002, coverage: 'COMPLETE' })
  console.info('literal gate: 20002 references indexed')
  const revision = f.store.session(session.id).revision, event = f.store.events(session.id, { from: 20002 }, 0, 1)[0]
  const map = data(await executeSessionTool(f.store, f.provider, 'inspect_agent_session', { sessionId: session.id }, () => {}))
  expect(map.segments[0]).toMatchObject({ first: 1, last: 100, count: 100 })
  expect(map.files).toContainEqual({ file: 'src/fixture.ts', count: 1 })
  const selected = data(await executeSessionTool(f.store, f.provider, 'list_agent_session_events', { sessionId: session.id, types: ['TOOL_RESULT'], tool: 'apply_patch' }, () => {}))
  expect(selected.events).toMatchObject([{ eventId: event.id, ordinal: 20002 }])
  expect(JSON.stringify({ map, selected })).not.toContain('END_LITERAL_MARKER')
  console.info('literal gate: map, file references and filtered envelope verified')
  const chunks: string[] = []; let cursor: string | undefined, pages = 0, position = 0
  do {
    const result = data(await executeSessionTool(f.store, f.provider, 'read_agent_session_event', { sessionId: session.id, eventId: event.id, expectedRevision: revision, cursor }, () => {}))
    expect(result.code).toBeUndefined(); expect(result.range.startByte).toBe(position)
    expect(result.range.endByte).toBeGreaterThan(position)
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(8192)
    chunks.push(result.content); position = result.range.endByte; cursor = result.nextCursor; pages++
    if (pages === 1 || pages % 256 === 0) console.info('literal gate: page', pages, 'byte', position)
  } while (cursor)
  expect(chunks.join('')).toBe(literal); expect(pages).toBeGreaterThan(1000)
  expect(f.store.session(session.id).payloadBytes).toBe(0)
}, 180000)
