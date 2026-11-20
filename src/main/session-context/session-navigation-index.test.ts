import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import type { McpProjectContext } from '../mcp/project-mcp-context'
import { SessionContextClient } from './client'
import { entireFileIdentity } from './entire-source'
import { ENTIRE_TRANSCRIPT_NORMALIZERS, EntireTranscriptStream, normalizeEntireRecord } from './entire-transcript'
import { nativeObservationBatch } from './native-hook-ingestion'
import { nativeDigest, type NativeHookEnvelope } from './native-hooks'
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

it('Aceite decisivo: public MCP catalog/schema/routing executes cross-session search -> evidence -> literal deepen, hooks, relation scope, and revocation purge', async () => {
  const [{ Client }, { StreamableHTTPClientTransport }, { AjvJsonSchemaValidator }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/validation/ajv')
  ])

  const base = mkdtempSync(join(tmpdir(), 'sni-public-mcp-'))
  cleanup.push(() => safeRemove(base))
  const root = join(base, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n')

  const repositoryId = 'repo-sni-public'
  const storePath = sessionStorePath(base, repositoryId)
  const target = { worktreeId: nativeDigest(`wt:${repositoryId}`), generation: nativeDigest(`gen:${repositoryId}`) }
  const profile = join(base, 'codex-profile')
  const accHash = nativeDigest(JSON.stringify(['user-pub', 'acc-pub']))

  const s1Uuid = '01a1e000-0000-7000-8000-000000000101'
  const s2Uuid = '01a1e000-0000-7000-8000-000000000102'
  const s3UnauthorizedUuid = '01a1e000-0000-7000-8000-000000000103'
  const dayFor = (u: string) => new Date(Number.parseInt(u.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).split('-')
  const dir1 = join(profile, 'sessions', ...dayFor(s1Uuid))
  const dir2 = join(profile, 'sessions', ...dayFor(s2Uuid))
  const dir3 = join(profile, 'sessions', ...dayFor(s3UnauthorizedUuid))
  mkdirSync(dir1, { recursive: true })
  mkdirSync(dir2, { recursive: true })
  mkdirSync(dir3, { recursive: true })

  const paddedError = `${'x'.repeat(3000)} ORIGIN_UNVERIFIED failure marker ${'y'.repeat(6500)}`
  const s1Path = join(dir1, `rollout-2026-11-20T10-00-00-${s1Uuid}.jsonl`)
  const s2Path = join(dir2, `rollout-2026-11-20T11-00-00-${s2Uuid}.jsonl`)
  const s3Path = join(dir3, `rollout-2026-11-20T12-00-00-${s3UnauthorizedUuid}.jsonl`)

  writeFileSync(s1Path, [
    JSON.stringify({ timestamp: '2026-11-20T10:00:00Z', type: 'session_meta', payload: { id: s1Uuid, session_id: s1Uuid, account_scoped: true, creator_user_id: 'user-pub', creator_account_id: 'acc-pub', cwd: root, runtime_workspace_roots: [root], cli_version: '0.169.0-alpha.11.1' } }),
    JSON.stringify({ timestamp: '2026-11-20T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-p1', cwd: root } }),
    JSON.stringify({ timestamp: '2026-11-20T10:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'lint_tool', call_id: 'c-1', arguments: '{"check":"a"}' } }),
    JSON.stringify({ timestamp: '2026-11-20T10:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c-1', output: `Exit code: 1\n${paddedError}` } }),
    JSON.stringify({ timestamp: '2026-11-20T10:00:04Z', type: 'response_item', payload: { type: 'function_call', name: 'build_tool', call_id: 'c-2', arguments: '{}' } }),
    JSON.stringify({ timestamp: '2026-11-20T10:00:05Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c-2', output: 'Build succeeded' } })
  ].join('\n') + '\n')

  writeFileSync(s2Path, [
    JSON.stringify({ timestamp: '2026-11-20T11:00:00Z', type: 'session_meta', payload: { id: s2Uuid, session_id: s2Uuid, account_scoped: true, creator_user_id: 'user-pub', creator_account_id: 'acc-pub', cwd: root, runtime_workspace_roots: [root], cli_version: '0.169.0-alpha.11.1' } }),
    JSON.stringify({ timestamp: '2026-11-20T11:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-p2', cwd: root } }),
    JSON.stringify({ timestamp: '2026-11-20T11:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Segundo registro exato com ORIGIN_UNVERIFIED na resposta.' }] } })
  ].join('\n') + '\n')

  writeFileSync(s3Path, [
    JSON.stringify({ timestamp: '2026-11-20T12:00:00Z', type: 'session_meta', payload: { id: s3UnauthorizedUuid, session_id: s3UnauthorizedUuid, account_scoped: true, creator_user_id: 'other-user', creator_account_id: 'other-acc', cwd: root, runtime_workspace_roots: [root], cli_version: '0.169.0-alpha.11.1' } }),
    JSON.stringify({ timestamp: '2026-11-20T12:00:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ORIGIN_UNVERIFIED unauthorized foreign session leak check' }] } })
  ].join('\n') + '\n')

  // Seed store with NATIVE_HOOK observations + artifact relation edge for s1
  const s1Hash = nativeDigest(JSON.stringify([repositoryId, 'codex', s1Uuid]))
  const s2Hash = nativeDigest(JSON.stringify([repositoryId, 'codex', s2Uuid]))
  const s3Hash = nativeDigest(JSON.stringify([repositoryId, 'codex', s3UnauthorizedUuid]))

  const seedStore = new SessionStore(storePath, repositoryId)
  const makeHook = (event: NativeHookEnvelope['event'], observedAt: string, extra: Partial<NativeHookEnvelope> = {}): NativeHookEnvelope => {
    const facts = {
      schema: 1 as const,
      source: 'CODEX_NATIVE_HOOK' as const,
      repositoryId,
      worktreeId: target.worktreeId,
      generation: target.generation,
      sessionId: s1Hash,
      event,
      ...extra
    }
    const body = { ...facts, observedAt, eventId: nativeDigest(JSON.stringify(facts)) }
    return { ...body, digest: nativeDigest(JSON.stringify(body)) }
  }
  const hookStart = makeHook('SessionStart', '2026-11-20T10:00:00.500Z')
  const hookShell = makeHook('PreToolUse', '2026-11-20T10:00:02.500Z', { tool: 'SHELL', invocationId: nativeDigest('inv-shell-1') })
  seedStore.registry.apply(nativeObservationBatch(hookStart), undefined)
  seedStore.registry.apply(nativeObservationBatch(hookShell), undefined)
  seedStore.registry.apply({ repositoryId, source: 'NATIVE_HOOK', revision: nativeDigest('hook-obs'), status: 'OBSERVED', edges: [] }, undefined)
  seedStore.registry.apply({
    repositoryId,
    source: 'CONTINUUM_TEST_REL',
    revision: '1',
    status: 'COMPLETE',
    edges: [{
      from: { kind: 'SESSION', id: `codex-native:${s1Hash}` },
      relation: 'associated',
      to: { kind: 'ARTIFACT', id: 'artifact-plan-closure-1' },
      evidenceKind: 'HANDOFF_DECLARED',
      evidenceRef: 'artifact-plan-closure-1',
      digest: nativeDigest('artifact-plan-closure-1'),
      freshness: 'OBSERVED_SNAPSHOT'
    }]
  }, undefined)
  seedStore.close()

  const configPath = join(dirname(storePath), 'session-context.provider.json')
  writeFileSync(configPath, JSON.stringify({
    repositoryId,
    nativeSources: { codex: { profile, creatorAccountHash: accHash, allowLexicalIndex: true } }
  }))

  const fp = sourceFingerprint(root)
  const resolver = Object.assign(
    async () => ({ root, fingerprint: fp, validate: async () => {} }),
    { discover: async () => [{ ...target, root, fingerprint: fp }] }
  )
  const workerPath = makeWorkerBundle(base)
  const clientWorker = new SessionContextClient(base, repositoryId, root, () => true, workerPath, resolver as any, 30_000)
  cleanup.push(() => clientWorker.dispose())

  const principal = authenticatedAgentPrincipal('MCP', () => true)
  const authority = authorizeArtifactAgent(principal, repositoryId, () => true)
  const adapter = new ChannelMcpAdapter({
    projectId: repositoryId,
    repoRoot: root,
    navigation: {} as McpProjectContext['navigation'],
    continuum: { repositoryId } as never,
    sessionContext: { call: (name, args, allowMeta) => clientWorker.call(name, args, allowMeta) }
  })
  const server = createMcpHttpServer(adapter, () => {}, undefined, undefined, () => authority)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())))
  const address = server.address() as { port: number }

  const mcpClient = new Client({ name: 'sni-public-acceptance', version: '1' })
  cleanup.push(() => mcpClient.close())
  await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)))

  const { tools } = await mcpClient.listTools()
  const ajv = new AjvJsonSchemaValidator()
  const validators = new Map<string, ReturnType<typeof ajv.getValidator>>()
  for (const t of tools) validators.set(t.name, ajv.getValidator(t.inputSchema))

  const searchSchema = tools.find(t => t.name === 'search_agent_session_evidence')!.inputSchema
  expect(searchSchema).not.toHaveProperty('oneOf')
  const listEventsSchema = tools.find(t => t.name === 'list_agent_session_events')!.inputSchema as any
  expect(listEventsSchema.properties.eventId).toBeDefined()

  const mcpCall = async (name: string, args: Record<string, unknown>) => {
    const validate = validators.get(name)!
    const check = validate(args)
    expect(check.valid, `AJV rejected ${name}(${JSON.stringify(args)}): ${check.errorMessage}`).toBe(true)
    const res = await mcpClient.callTool({ name, arguments: args })
    return { isError: !!res.isError, data: JSON.parse((res.content as Array<{ text: string }>)[0].text), structuredContent: res.structuredContent }
  }

  // Index authorized s1 & s2 through public MCP; unauthorized s3 is rejected
  const s1Native = { provider: 'codex-native' as const, id: s1Hash, ...target }
  const s2Native = { provider: 'codex-native' as const, id: s2Hash, ...target }
  const s3Native = { provider: 'codex-native' as const, id: s3Hash, ...target }
  expect((await mcpCall('refresh_agent_sessions', { nativeSession: s1Native, sourceSessionId: s1Uuid })).data.state).toBe('READY')
  expect((await mcpCall('refresh_agent_sessions', { nativeSession: s2Native, sourceSessionId: s2Uuid })).data.state).toBe('READY')
  const s3Ref = await mcpCall('refresh_agent_sessions', { nativeSession: s3Native, sourceSessionId: s3UnauthorizedUuid })
  expect(s3Ref.data.state).toBe('UNAVAILABLE')

  // 1. Cross-session lexical search WITHOUT sessionId/nativeSession, limit=1, pagination & literal deepen
  const page1 = await mcpCall('search_agent_session_evidence', {
    query: 'ORIGIN_UNVERIFIED',
    worktreeId: target.worktreeId,
    generation: target.generation,
    limit: 1
  })
  expect(page1.isError).toBe(false)
  expect(page1.data.hits).toHaveLength(1)
  expect(page1.data.hits[0].sessionId).toBe(s1Uuid)
  expect(page1.data.nextCursor).toBeDefined()
  expect(page1.data.coverage.nativeSource.state).toBe('READY')

  const page2 = await mcpCall('search_agent_session_evidence', {
    query: 'ORIGIN_UNVERIFIED',
    worktreeId: target.worktreeId,
    generation: target.generation,
    limit: 1,
    cursor: page1.data.nextCursor
  })
  expect(page2.isError).toBe(false)
  expect(page2.data.hits).toHaveLength(1)
  expect(page2.data.hits[0].sessionId).toBe(s2Uuid)
  expect(page2.data.hits[0].eventId).not.toBe(page1.data.hits[0].eventId)
  expect(page2.data.nextCursor).toBeUndefined()

  // Follow deepen selector literally (no argument modification) -> centered sanitized excerpt + digest + range
  const literal1 = await mcpCall(page1.data.hits[0].deepen.tool, page1.data.hits[0].deepen.arguments)
  expect(literal1.isError).toBe(false)
  expect(literal1.data.content).toContain('ORIGIN_UNVERIFIED')
  expect(literal1.data.range.startByte).toBeGreaterThan(0)
  expect(literal1.data.payloadDigest).toMatch(/^[a-f0-9]{64}$/)

  // 2. PHRASE mode propagates to deepen and does not false-match scattered tokens
  const phraseSearch = await mcpCall('search_agent_session_evidence', {
    query: 'registro exato com ORIGIN_UNVERIFIED',
    mode: 'PHRASE',
    limit: 5
  })
  expect(phraseSearch.isError).toBe(false)
  expect(phraseSearch.data.hits).toHaveLength(1)
  expect(phraseSearch.data.hits[0].sessionId).toBe(s2Uuid)
  expect(phraseSearch.data.hits[0].deepen.arguments.mode).toBe('PHRASE')
  const phraseRead = await mcpCall(phraseSearch.data.hits[0].deepen.tool, phraseSearch.data.hits[0].deepen.arguments)
  expect(phraseRead.isError).toBe(false)
  expect(phraseRead.data.content).toContain('registro exato com ORIGIN_UNVERIFIED')

  const scatteredPhrase = await mcpCall('search_agent_session_evidence', {
    query: 'ORIGIN_UNVERIFIED resposta',
    mode: 'PHRASE',
    limit: 5
  })
  expect(scatteredPhrase.data.hits).toHaveLength(0)

  // 3. Hook filter: types=['ERROR'] on NATIVE_HOOK must NOT return SessionStart; hookEvents=['PreToolUse'] returns exact hit & literal deepen works
  const hookErr = await mcpCall('search_agent_session_evidence', {
    source: 'NATIVE_HOOK',
    types: ['ERROR'],
    limit: 1
  })
  expect(hookErr.isError).toBe(false)
  expect(hookErr.data.hits).toHaveLength(0)
  expect(hookErr.data.coverage.nativeHook.state).toBe('NOT_OBSERVED')

  const hookPre = await mcpCall('search_agent_session_evidence', {
    source: 'NATIVE_HOOK',
    hookEvents: ['PreToolUse'],
    tool: 'SHELL',
    limit: 1
  })
  expect(hookPre.isError).toBe(false)
  expect(hookPre.data.hits).toHaveLength(1)
  expect(hookPre.data.hits[0].type).toBe('PreToolUse')
  expect(hookPre.data.hits[0].status).toBeUndefined()
  expect(hookPre.data.hits[0].errorKind).toBeUndefined()
  expect(hookPre.data.hits[0].deepen.tool).toBe('list_agent_session_events')
  expect(hookPre.data.hits[0].deepen.arguments.eventId).toBe(hookShell.eventId)

  const hookDeepen = await mcpCall(hookPre.data.hits[0].deepen.tool, hookPre.data.hits[0].deepen.arguments)
  expect(hookDeepen.isError).toBe(false)
  expect(hookDeepen.data.events).toHaveLength(1)
  expect(hookDeepen.data.events[0].eventId).toBe(hookShell.eventId)
  expect(hookDeepen.data.events[0].content).toBeUndefined()

  // 4. Relation filter (artifactId) resolves native hash-to-hash & isError=false excludes unknown/dangling/input
  const relHit = await mcpCall('search_agent_session_evidence', {
    artifactId: 'artifact-plan-closure-1',
    isError: false,
    limit: 5
  })
  expect(relHit.isError).toBe(false)
  expect(relHit.data.hits).toHaveLength(2)
  expect(relHit.data.hits.every((h: any) => h.sessionId === s1Uuid && h.status === 'SUCCESS')).toBe(true)

  const relResultOnly = await mcpCall('search_agent_session_evidence', {
    artifactId: 'artifact-plan-closure-1',
    isError: false,
    types: ['TOOL_RESULT'],
    limit: 5
  })
  expect(relResultOnly.isError).toBe(false)
  expect(relResultOnly.data.hits).toHaveLength(1)
  expect(relResultOnly.data.hits[0].type).toBe('TOOL_RESULT')
  expect(relResultOnly.data.hits[0].status).toBe('SUCCESS')

  // IMPORTED structural path + file filter (and nativeHook/nativeSource report NOT_OBSERVED for file)
  expect(relHit.data.coverage.entire.state).toBe('NON_INDEXED')
  const importedFullPath = join(root, '.entire/metadata/entire-imp-1/full.jsonl')
  mkdirSync(dirname(importedFullPath), { recursive: true })
  const importedLine = Buffer.from(JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-11-20T10:30:00Z',
    payload: { type: 'item_completed', item: { type: 'file_change', status: 'completed', changes: { 'src/imported-target.ts': {} } } }
  }) + '\n')
  writeFileSync(importedFullPath, importedLine)
  const impStore = new SessionStore(storePath, repositoryId)
  const impMeta = impStore.ingest({
    providerSessionId: 'entire-imp-1',
    providerVersion: 'fixture',
    agent: 'codex',
    state: 'ENDED',
    endedAt: '2026-11-20T10:31:00Z',
    coverage: 'COMPLETE',
    importState: 'METADATA_ONLY',
    sourceDigest: 'entire-imp-1',
    sourceBytes: importedLine.length
  }, [])
  const impRun = impStore.references.begin(impMeta.sessionId, { kind: 'ENTIRE_FILE', path: importedFullPath, identity: await entireFileIdentity(importedFullPath) }, ENTIRE_TRANSCRIPT_NORMALIZERS.codex)
  const impStream = new EntireTranscriptStream(rec => impStore.references.append(impRun, normalizeEntireRecord('codex', rec, () => undefined)))
  impStream.push(importedLine)
  const impParsed = await impStream.finish()
  impStore.references.commit(impRun, impParsed.sourceDigest, impParsed.sourceBytes, () => {}, 'COMPLETE')
  impStore.close()

  const fileSearch = await mcpCall('search_agent_session_evidence', {
    file: 'src/imported-target.ts',
    limit: 5
  })
  expect(fileSearch.isError).toBe(false)
  expect(fileSearch.data.hits).toHaveLength(1)
  expect(fileSearch.data.hits[0].source).toBe('IMPORTED')
  expect(fileSearch.data.hits[0].sessionId).toBe(impMeta.sessionId)
  expect(fileSearch.data.hits[0].deepen.tool).toBe('read_agent_session_event')
  expect(fileSearch.data.coverage.nativeHook.state).toBe('NOT_OBSERVED')
  expect(fileSearch.data.coverage.nativeSource.state).toBe('NOT_OBSERVED')
  expect(fileSearch.data.coverage.entire.state).toBe('READY')
  expect(fileSearch.data.coverage.fileCoverage.state).toBe('INDEXED_REFERENCES_ONLY')

  // Unsupported filter & scope conflict checks
  const opSearch = await mcpCall('search_agent_session_evidence', { operation: 'READ', limit: 5 })
  expect(opSearch.data.hits).toHaveLength(0)
  expect(opSearch.data.coverage.operationCoverage.state).toBe('NOT_OBSERVED')

  const conflictRes = await mcpCall('search_agent_session_evidence', {
    nativeSession: s1Native,
    agent: 'antigravity'
  })
  expect(conflictRes.isError).toBe(true)
  expect(conflictRes.data.code).toBe('INVALID_ARGUMENT')

  // 5. Revocation after indexing: toggle allowLexicalIndex=false -> purge FTS/READY, old cursor rejected
  writeFileSync(configPath, JSON.stringify({
    repositoryId,
    nativeSources: { codex: { profile, creatorAccountHash: accHash, allowLexicalIndex: false } }
  }))
  const afterOptOut = await mcpCall('search_agent_session_evidence', { query: 'ORIGIN_UNVERIFIED', limit: 5 })
  expect(afterOptOut.data.hits).toHaveLength(0)
  expect(afterOptOut.data.coverage.nativeSource.state).toBe('NOT_INDEXED')

  const staleCursorRes = await mcpCall('search_agent_session_evidence', {
    query: 'ORIGIN_UNVERIFIED',
    worktreeId: target.worktreeId,
    generation: target.generation,
    limit: 1,
    cursor: page1.data.nextCursor
  })
  expect(staleCursorRes.isError).toBe(true)
  expect(staleCursorRes.data.code).toBe('CURSOR_STALE')

  const dbCheckPurge = new Database(storePath, { readonly: true })
  try {
    expect((dbCheckPurge.prepare('SELECT COUNT(*) AS c FROM native_reference_fts_map').get() as { c: number }).c).toBe(0)
  } finally { dbCheckPurge.close() }

  // 6. Re-enable allowLexicalIndex, re-index both, then delete s2 file -> s2 hidden & purged, s1 still served with PARTIAL coverage
  writeFileSync(configPath, JSON.stringify({
    repositoryId,
    nativeSources: { codex: { profile, creatorAccountHash: accHash, allowLexicalIndex: true } }
  }))
  expect((await mcpCall('refresh_agent_sessions', { nativeSession: s1Native, sourceSessionId: s1Uuid })).data.state).toBe('READY')
  expect((await mcpCall('refresh_agent_sessions', { nativeSession: s2Native, sourceSessionId: s2Uuid })).data.state).toBe('READY')
  unlinkSync(s2Path)

  const afterS2Delete = await mcpCall('search_agent_session_evidence', { query: 'ORIGIN_UNVERIFIED', limit: 5 })
  expect(afterS2Delete.isError).toBe(false)
  expect(afterS2Delete.data.hits).toHaveLength(1)
  expect(afterS2Delete.data.hits[0].sessionId).toBe(s1Uuid)
  expect(afterS2Delete.data.coverage.nativeSource.state).toBe('PARTIAL')
  expect(JSON.stringify(afterS2Delete.data)).not.toContain(s2Uuid)

  // Stale expectedRevision rejected on literal read
  const badRev = await mcpCall('read_agent_session_event', {
    ...page1.data.hits[0].deepen.arguments,
    expectedRevision: page1.data.hits[0].deepen.arguments.expectedRevision + 1
  })
  expect(badRev.isError).toBe(true)
  expect(badRev.data.code).toBe('REVISION_CONFLICT')
}, 60_000)
