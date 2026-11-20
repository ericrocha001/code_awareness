import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionContextClient } from './client'
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
  const base = mkdtempSync(join(tmpdir(), 'sni-test-'))
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

it('U1 investigates session facets, discriminative filters, and cross-session evidence discovery', async () => {
  const f = setupWorkerEnv('repo-sni-u1')
  const profile = join(f.base, 'codex-profile')
  const session1Uuid = '01a1e000-0000-7000-8000-000000000001'
  const session2Uuid = '01a1e000-0000-7000-8000-000000000002'
  const day1 = new Date(Number.parseInt(session1Uuid.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).split('-')
  const day2 = new Date(Number.parseInt(session2Uuid.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).split('-')
  const dir1 = join(profile, 'sessions', ...day1)
  const dir2 = join(profile, 'sessions', ...day2)
  mkdirSync(dir1, { recursive: true })
  mkdirSync(dir2, { recursive: true })

  const accHash = nativeDigest(JSON.stringify(['user-u1', 'acc-u1']))
  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-sni-u1',
    nativeSources: { codex: { profile, creatorAccountHash: accHash } }
  }))

  // Session 1: contains tool calls, an error, and normal messages
  const s1Lines = [
    JSON.stringify({
      timestamp: '2026-11-20T10:00:00Z',
      type: 'session_meta',
      payload: {
        id: session1Uuid, session_id: session1Uuid, account_scoped: true,
        creator_user_id: 'user-u1', creator_account_id: 'acc-u1',
        cwd: f.root, runtime_workspace_roots: [f.root], cli_version: '0.169.0-alpha.11.1'
      }
    }),
    JSON.stringify({ timestamp: '2026-11-20T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-alpha', cwd: f.root } }),
    JSON.stringify({ timestamp: '2026-11-20T10:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'linter_tool', call_id: 'call-1', arguments: '{"file":"src/main.ts"}' } }),
    JSON.stringify({ timestamp: '2026-11-20T10:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'Exit code: 1\nSyntaxError: Unexpected token at line 42' } }),
    JSON.stringify({ timestamp: '2026-11-20T10:00:04Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I found an error in src/main.ts' }] } })
  ]
  writeFileSync(join(dir1, `rollout-2026-11-20T10-00-00-${session1Uuid}.jsonl`), s1Lines.join('\n') + '\n')

  // Session 2: contains different tool calls and normal messages
  const s2Lines = [
    JSON.stringify({
      timestamp: '2026-11-20T11:00:00Z',
      type: 'session_meta',
      payload: {
        id: session2Uuid, session_id: session2Uuid, account_scoped: true,
        creator_user_id: 'user-u1', creator_account_id: 'acc-u1',
        cwd: f.root, runtime_workspace_roots: [f.root], cli_version: '0.169.0-alpha.11.1'
      }
    }),
    JSON.stringify({ timestamp: '2026-11-20T11:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-beta', cwd: f.root } }),
    JSON.stringify({ timestamp: '2026-11-20T11:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'compiler_tool', call_id: 'call-2', arguments: '{"target":"build"}' } }),
    JSON.stringify({ timestamp: '2026-11-20T11:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-2', output: 'Success: build finished in 450ms' } }),
    JSON.stringify({ timestamp: '2026-11-20T11:00:04Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Compilation completed successfully.' }] } })
  ]
  writeFileSync(join(dir2, `rollout-2026-11-20T11-00-00-${session2Uuid}.jsonl`), s2Lines.join('\n') + '\n')

  const s1Native = { provider: 'codex-native' as const, id: nativeDigest(JSON.stringify(['repo-sni-u1', 'codex', session1Uuid])), ...f.target }
  const s2Native = { provider: 'codex-native' as const, id: nativeDigest(JSON.stringify(['repo-sni-u1', 'codex', session2Uuid])), ...f.target }

  // Index session 1
  const ref1 = await f.call('refresh_agent_sessions', {
    nativeSession: s1Native,
    sourceSessionId: session1Uuid
  })
  expect(ref1.isError).toBe(false)
  expect(ref1.data.state).toBe('READY')

  // Index session 2
  const ref2 = await f.call('refresh_agent_sessions', {
    nativeSession: s2Native,
    sourceSessionId: session2Uuid
  })
  expect(ref2.isError).toBe(false)
  expect(ref2.data.state).toBe('READY')

  // 1. inspect_agent_session facets
  // Default map includes facet views
  const inspDefault = await f.call('inspect_agent_session', {
    nativeSession: s1Native,
    sourceSessionId: session1Uuid
  })
  expect(inspDefault.isError).toBe(false)
  expect(inspDefault.data.turnView).toBeDefined()
  expect(inspDefault.data.errorView).toBeDefined()
  expect(inspDefault.data.toolView).toBeDefined()
  expect(inspDefault.data.events).toBeDefined()

  // Facet: ERRORS
  const inspErrors = await f.call('inspect_agent_session', {
    nativeSession: s1Native,
    sourceSessionId: session1Uuid,
    facet: 'ERRORS'
  })
  expect(inspErrors.isError).toBe(false)
  expect(inspErrors.data.errors).toBeDefined()
  expect(inspErrors.data.errors.length).toBeGreaterThanOrEqual(1)
  expect(inspErrors.data.errors.some((e: any) => e.type === 'ERROR')).toBe(true)
  expect(inspErrors.data.errors[0].deepen.tool).toBe('read_agent_session_event')

  // Facet: TOOLS
  const inspTools = await f.call('inspect_agent_session', {
    nativeSession: s1Native,
    sourceSessionId: session1Uuid,
    facet: 'TOOLS'
  })
  expect(inspTools.isError).toBe(false)
  expect(inspTools.data.tools).toBeDefined()
  expect(inspTools.data.tools.some((t: any) => t.tool === 'linter_tool')).toBe(true)

  // Facet: TURNS
  const inspTurns = await f.call('inspect_agent_session', {
    nativeSession: s1Native,
    sourceSessionId: session1Uuid,
    facet: 'TURNS'
  })
  expect(inspTurns.isError).toBe(false)
  expect(inspTurns.data.turns).toBeDefined()
  expect(inspTurns.data.turns[0].id).toBe('turn-alpha')

  // 2. list_agent_session_events discriminative filters
  // Filter by status=FAILURE / isError=true
  const errorEvents = await f.call('list_agent_session_events', {
    nativeSession: s1Native,
    sourceSessionId: session1Uuid,
    isError: true
  })
  expect(errorEvents.isError).toBe(false)
  expect(errorEvents.data.events.length).toBeGreaterThanOrEqual(1)
  expect(errorEvents.data.events.some((e: any) => e.type === 'ERROR')).toBe(true)

  // Filter by tool=linter_tool
  const toolEvents = await f.call('list_agent_session_events', {
    nativeSession: s1Native,
    sourceSessionId: session1Uuid,
    tool: 'linter_tool'
  })
  expect(toolEvents.isError).toBe(false)
  expect(toolEvents.data.events.length).toBe(2) // call and result

  // Filter by unobserved file returns NOT_OBSERVED without inventing success
  const fileEvents = await f.call('list_agent_session_events', {
    nativeSession: s1Native,
    sourceSessionId: session1Uuid,
    file: 'src/nonexistent.ts'
  })
  expect(fileEvents.isError).toBe(false)
  expect(fileEvents.data.events.length).toBe(0)
  expect(fileEvents.data.fileCoverage.state).toBe('NOT_OBSERVED')

  // 3. search_agent_session_evidence cross-session discovery
  // Search for compiler_tool across sessions
  const searchTool = await f.call('search_agent_session_evidence', {
    tool: 'compiler_tool'
  })
  expect(searchTool.isError).toBe(false)
  expect(searchTool.data.hits.length).toBeGreaterThanOrEqual(1)
  expect(searchTool.data.hits[0].sessionId).toBe(session2Uuid)
  expect(searchTool.data.hits[0].deepen.tool).toBe('read_agent_session_event')

  // Search for errors across sessions
  const searchErrors = await f.call('search_agent_session_evidence', {
    isError: true
  })
  expect(searchErrors.isError).toBe(false)
  expect(searchErrors.data.hits.length).toBeGreaterThanOrEqual(1)
  expect(searchErrors.data.hits.every((h: any) => h.sessionId === session1Uuid)).toBe(true)
  expect(searchErrors.data.hits.some((h: any) => h.type === 'ERROR')).toBe(true)

  // Search with worktree filter
  const searchWt = await f.call('search_agent_session_evidence', {
    worktreeId: f.target.worktreeId,
    generation: f.target.generation
  })
  expect(searchWt.isError).toBe(false)
  expect(searchWt.data.hits.length).toBeGreaterThan(0)
  expect(searchWt.data.scope.worktreeId).toBe(f.target.worktreeId)
}, 30_000)

it('U2 indexes contentless FTS5 on opt-in, executes phrase and diacritic queries, centers single-evidence window, and cascades deletions', async () => {
  const f = setupWorkerEnv('repo-sni-u2')
  const profile = join(f.base, 'codex-profile')
  const sessionUuid = '01a1e000-0000-7000-8000-000000000010'
  const day = new Date(Number.parseInt(sessionUuid.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).split('-')
  const dir = join(profile, 'sessions', ...day)
  mkdirSync(dir, { recursive: true })

  const accHash = nativeDigest(JSON.stringify(['user-u2', 'acc-u2']))
  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-sni-u2',
    nativeSources: {
      codex: {
        profile,
        creatorAccountHash: accHash,
        allowLexicalIndex: true
      }
    }
  }))

  const lines = [
    JSON.stringify({
      timestamp: '2026-11-20T12:00:00Z',
      type: 'session_meta',
      payload: {
        id: sessionUuid, session_id: sessionUuid, account_scoped: true,
        creator_user_id: 'user-u2', creator_account_id: 'acc-u2',
        cwd: f.root, runtime_workspace_roots: [f.root], cli_version: '0.169.0-alpha.11.1'
      }
    }),
    JSON.stringify({ timestamp: '2026-11-20T12:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-u2', cwd: f.root } }),
    JSON.stringify({ timestamp: '2026-11-20T12:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'diagnostic_tool', call_id: 'call-u2', arguments: '{"check":"lexical"}' } }),
    JSON.stringify({ timestamp: '2026-11-20T12:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-u2', output: 'Exit code: 1\nFalha crítica na compilação: SyntaxError inesperado no arquivo principal' } }),
    JSON.stringify({ timestamp: '2026-11-20T12:00:04Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Configuração concluída com sucesso para o módulo de integração de evidências.' }] } })
  ]
  writeFileSync(join(dir, `rollout-2026-11-20T12-00-00-${sessionUuid}.jsonl`), lines.join('\n') + '\n')

  const sNative = { provider: 'codex-native' as const, id: nativeDigest(JSON.stringify(['repo-sni-u2', 'codex', sessionUuid])), ...f.target }

  // Index session
  const ref = await f.call('refresh_agent_sessions', {
    nativeSession: sNative,
    sourceSessionId: sessionUuid
  })
  expect(ref.isError).toBe(false)
  expect(ref.data.state).toBe('READY')

  // Verify SQLite FTS tables directly
  const db = new Database(f.storePath, { readonly: true })
  try {
    const ftsMapRows = db.prepare('SELECT COUNT(*) AS count FROM native_reference_fts_map').get() as { count: number }
    expect(ftsMapRows.count).toBeGreaterThan(0)
    // No raw message content in SQLite tables
    const tableDump = JSON.stringify(db.prepare('SELECT * FROM native_reference_events').all())
    expect(tableDump).not.toContain('Falha crítica')
    expect(tableDump).not.toContain('Configuração concluída')
  } finally {
    db.close()
  }

  // Cross-session evidence search with diacritics
  const searchAccented = await f.call('search_agent_session_evidence', {
    query: 'Configuração concluída'
  })
  expect(searchAccented.isError).toBe(false)
  expect(searchAccented.data.hits.length).toBe(1)
  expect(searchAccented.data.hits[0].sessionId).toBe(sessionUuid)

  // Cross-session evidence search without diacritics (unicode61 remove_diacritics 2)
  const searchUnaccented = await f.call('search_agent_session_evidence', {
    query: 'configuracao concluida'
  })
  expect(searchUnaccented.isError).toBe(false)
  expect(searchUnaccented.data.hits.length).toBe(1)
  expect(searchUnaccented.data.hits[0].sessionId).toBe(sessionUuid)

  // Cross-session evidence search for phrase
  const searchPhrase = await f.call('search_agent_session_evidence', {
    query: 'Falha crítica na compilação'
  })
  expect(searchPhrase.isError).toBe(false)
  expect(searchPhrase.data.hits.length).toBe(1)
  expect(searchPhrase.data.hits[0].type).toBe('ERROR')

  // Read event literal with in-memory match centering using deepen selector
  const readCentered = await f.call('read_agent_session_event', {
    ...searchPhrase.data.hits[0].deepen.arguments,
    query: 'SyntaxError'
  })
  expect(readCentered.isError).toBe(false)
  expect(readCentered.data.content).toContain('SyntaxError')
  expect(readCentered.data.range).toBeDefined()

  // Verify opt-in requirement: when allowLexicalIndex is not set, no FTS rows are indexed
  const fNoOptIn = setupWorkerEnv('repo-sni-no-optin')
  const profile2 = join(fNoOptIn.base, 'codex-profile')
  const sessionUuid2 = '01a1e000-0000-7000-8000-000000000020'
  const day2 = new Date(Number.parseInt(sessionUuid2.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).split('-')
  const dir2 = join(profile2, 'sessions', ...day2)
  mkdirSync(dir2, { recursive: true })
  writeFileSync(fNoOptIn.configPath, JSON.stringify({
    repositoryId: 'repo-sni-no-optin',
    nativeSources: {
      codex: { profile: profile2, creatorAccountHash: accHash } // no allowLexicalIndex
    }
  }))
  writeFileSync(join(dir2, `rollout-2026-11-20T12-00-00-${sessionUuid2}.jsonl`), lines.map(l => l.replaceAll(sessionUuid, sessionUuid2)).join('\n') + '\n')
  const sNative2 = { provider: 'codex-native' as const, id: nativeDigest(JSON.stringify(['repo-sni-no-optin', 'codex', sessionUuid2])), ...fNoOptIn.target }
  await fNoOptIn.call('refresh_agent_sessions', { nativeSession: sNative2, sourceSessionId: sessionUuid2 })
  const dbNoOptIn = new Database(fNoOptIn.storePath, { readonly: true })
  try {
    const count = (dbNoOptIn.prepare('SELECT COUNT(*) AS count FROM native_reference_fts_map').get() as { count: number }).count
    expect(count).toBe(0)
  } finally {
    dbNoOptIn.close()
  }
}, 30_000)
