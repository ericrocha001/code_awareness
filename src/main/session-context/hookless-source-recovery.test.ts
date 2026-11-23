import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { antigravityAppTranscriptPath } from './antigravity-app-locator'
import { executeSessionTool } from './mcp'
import { discoverAntigravityAppSources } from './native-antigravity-app-source'
import { discoverCodexSources } from './native-codex-source'
import { nativeObservationBatch } from './native-hook-ingestion'
import { nativeDigest, nativeGitIdentity, normalizeNativeHook, prepareNativeSpool, type NativeHookBinding } from './native-hooks'
import { SessionStore, sessionStorePath } from './store'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()) })

function safeRemove(dir: string) {
  execFileSync('node', ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })", dir], { windowsHide: true })
}

function seedAntigravitySummariesDb(profile: string, rows: Array<{ id: string; workspaceUris: unknown; lastModified?: string }>) {
  mkdirSync(profile, { recursive: true })
  const db = new Database(join(profile, 'conversation_summaries.db'))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, last_modified_time TEXT)')
    const stmt = db.prepare('INSERT OR REPLACE INTO conversation_summaries (conversation_id, workspace_uris, last_modified_time) VALUES (?, ?, ?)')
    for (const r of rows) {
      stmt.run(r.id, typeof r.workspaceUris === 'string' ? r.workspaceUris : JSON.stringify(r.workspaceUris), r.lastModified ?? '2026-11-17 10:00:10+00:00')
    }
  } finally {
    db.close()
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'u3-hookless-'))
  cleanup.push(() => safeRemove(dir))
  const root = join(dir, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/feat\n')
  const target = { worktreeId: '1'.repeat(64), generation: '2'.repeat(64) }
  const storePath = sessionStorePath(dir, 'repo-u3')
  let store = new SessionStore(storePath, 'repo-u3')
  const getStore = () => store
  cleanup.push(() => getStore().close())
  const channel = () => new ChannelMcpAdapter({
    projectId: 'repo-u3',
    repoRoot: root,
    navigation: {} as never,
    continuum: { repositoryId: 'repo-u3' } as never,
    sessionContext: {
      call: (name, args) => executeSessionTool(store, {}, name, args, () => {}, target, [{ ...target, root, fingerprint: 'fp' }], undefined, root)
    }
  })
  const principal = authenticatedAgentPrincipal('MCP', () => true)
  const authority = authorizeArtifactAgent(principal, 'repo-u3', () => true)
  const call = async (name: Parameters<typeof executeSessionTool>[2], args: unknown) => {
    const res = await channel().callTool(name, args, undefined, authority)
    return { isError: !!res.isError, data: JSON.parse((res.content[0] as { text: string }).text) }
  }
  return {
    dir, root, target, storePath, getStore, call,
    configPath: join(dirname(storePath), 'session-context.provider.json'),
    restart: () => { store.close(); store = new SessionStore(storePath, 'repo-u3') }
  }
}

it('U3 discovers, inspects, and reads an authorized hookless Codex 0.169 session with visualization root and replays after restart', async () => {
  const f = setup()
  const profile = join(f.dir, 'codex-profile')
  const rolloutDir = join(profile, 'sessions', '2026', '11', '15')
  const visRoot = join(profile, 'visualizations', '2026', '11', '17', '01a1b439-e8a4-7a90-abbf-106897d285f2')
  mkdirSync(rolloutDir, { recursive: true })
  mkdirSync(visRoot, { recursive: true })
  const sessionUuid = '01a1e000-0000-7000-8000-000000000001'
  const expectedHash = nativeDigest(JSON.stringify(['repo-u3', 'codex', sessionUuid]))
  const accountHash = nativeDigest(JSON.stringify(['u3-user', 'u3-account']))
  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u3',
    nativeSources: { codex: { profile, creatorAccountHash: accountHash } }
  }))

  const answerText = 'Hookless Codex result ' + 'chunk-'.repeat(400)
  const rolloutPath = join(rolloutDir, `rollout-2026-11-17T10-00-00-${sessionUuid}.jsonl`)
  const rows = [
    {
      type: 'session_meta',
      payload: {
        id: sessionUuid,
        session_id: '01a1b439-e8a4-7a90-abbf-106897d285f2',
        account_scoped: true,
        creator_user_id: 'u3-user',
        creator_account_id: 'u3-account',
        cwd: f.root,
        runtime_workspace_roots: [f.root, visRoot],
        cli_version: '0.169.0-alpha.11.1',
        timestamp: '2026-11-17T10:00:00.000Z'
      }
    },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answerText }] } }
  ]
  writeFileSync(rolloutPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n')

  // Foreign session on another worktree must never appear or be readable
  const foreignUuid = '01a1e000-0000-7000-8000-000000000002'
  const otherWorktree = join(f.dir, 'other-repo')
  mkdirSync(otherWorktree, { recursive: true })
  writeFileSync(join(rolloutDir, `rollout-2026-11-17T10-05-00-${foreignUuid}.jsonl`), [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: foreignUuid, session_id: foreignUuid, account_scoped: true,
        creator_user_id: 'u3-user', creator_account_id: 'u3-account',
        cwd: otherWorktree, runtime_workspace_roots: [otherWorktree],
        cli_version: '0.169.0-alpha.11.1', timestamp: '2026-11-17T10:05:00.000Z'
      }
    }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FOREIGN' }] } })
  ].join('\n') + '\n')

  const listed = await f.call('list_agent_sessions', { worktreeId: f.target.worktreeId, generation: f.target.generation })
  expect(listed.isError).toBe(false)
  expect(listed.data.sessions).toHaveLength(1)
  expect(listed.data.sessions[0]).toMatchObject({
    provider: 'codex-native',
    providerSessionId: expectedHash,
    sourceSessionId: sessionUuid,
    origin: 'LOCAL_SOURCE_GRANT',
    contentAvailability: 'AVAILABLE',
    captureCoverage: 'SOURCE_AVAILABLE_NO_HOOK_CAPTURE',
    identityEvidence: 'HASH_AND_PROVIDER_HEADER_VERIFIED'
  })

  const inspected = await f.call('inspect_agent_session', listed.data.sessions[0].deepen.arguments)
  expect(inspected.isError, JSON.stringify(inspected.data)).toBe(false)
  expect(inspected.data).toMatchObject({
    source: 'CODEX_LOCAL_TRANSCRIPT_V1',
    contentAvailability: 'AVAILABLE',
    captureCoverage: 'SOURCE_AVAILABLE_NO_HOOK_CAPTURE',
    identityEvidence: 'HASH_AND_PROVIDER_HEADER_VERIFIED',
    sourceEventCount: 1,
    observedEventCount: 0,
    transcriptImported: false
  })

  const events = await f.call('list_agent_session_events', {
    ...listed.data.sessions[0].deepen.arguments,
    expectedRevision: inspected.data.revision
  })
  expect(events.isError).toBe(false)
  expect(events.data.events).toHaveLength(1)

  f.restart()

  const read = await f.call('read_agent_session_event', {
    ...listed.data.sessions[0].deepen.arguments,
    expectedRevision: inspected.data.revision,
    eventId: events.data.events[0].eventId
  })
  expect(read.isError).toBe(false)
  expect(read.data).toMatchObject({
    content: answerText,
    complete: true,
    contentAvailability: 'AVAILABLE',
    captureCoverage: 'SOURCE_AVAILABLE_NO_HOOK_CAPTURE',
    identityEvidence: 'HASH_AND_PROVIDER_HEADER_VERIFIED',
    transcriptImported: false
  })
  expect(f.getStore().count()).toBe(0)

  const foreignRead = await f.call('inspect_agent_session', {
    sourceSessionId: foreignUuid,
    nativeSession: {
      provider: 'codex-native',
      id: nativeDigest(JSON.stringify(['repo-u3', 'codex', foreignUuid])),
      ...f.target
    }
  })
  expect(foreignRead.isError).toBe(true)
  expect(foreignRead.data.code).toBe('ORIGIN_UNVERIFIED')
}, 30000)

it('U3 discovers and reads real-shape Antigravity App transcript_full.jsonl without hooks and with partial hook coverage', async () => {
  const f = setup()
  const profile = join(f.dir, 'ag-profile')
  const convId = '019ba000-0000-7000-8000-000000000010'
  const foreignConvId = '019ba000-0000-7000-8000-000000000099'
  const transcriptPath = antigravityAppTranscriptPath(profile, convId)
  const foreignPath = antigravityAppTranscriptPath(profile, foreignConvId)
  mkdirSync(dirname(transcriptPath), { recursive: true })
  mkdirSync(dirname(foreignPath), { recursive: true })

  writeFileSync(transcriptPath, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-17T10:00:00Z', content: 'PRIVATE_USER_PROMPT' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T10:00:05Z', thinking: 'thinking', tool_calls: [{ name: 'read_file', args: { Path: join(f.root, 'src/a.ts') } }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-17T10:00:06Z', content: `Active Workspaces:\n- ${f.root}\n` },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T10:00:10Z', content: 'Hookless reply token=secret-value-u3' }
  ].map(r => JSON.stringify(r)).join('\n') + '\n')

  writeFileSync(foreignPath, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-17T10:00:00Z', content: 'Other project' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T10:00:10Z', content: 'FOREIGN_REPLY' }
  ].map(r => JSON.stringify(r)).join('\n') + '\n')

  const otherRepo = join(f.dir, 'other-ag-repo')
  mkdirSync(otherRepo, { recursive: true })
  seedAntigravitySummariesDb(profile, [
    { id: convId, workspaceUris: [pathToFileURL(f.root).href], lastModified: '2026-11-17 10:00:10+00:00' },
    { id: foreignConvId, workspaceUris: [pathToFileURL(otherRepo).href], lastModified: '2026-11-17 10:00:10+00:00' }
  ])

  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u3',
    nativeSources: { antigravityApp: { profile } }
  }))

  const expectedHash = nativeDigest(JSON.stringify(['repo-u3', 'antigravity', convId]))
  const listed = await f.call('list_agent_sessions', { worktreeId: f.target.worktreeId, generation: f.target.generation })
  expect(listed.isError).toBe(false)
  expect(listed.data.sessions).toHaveLength(1)
  expect(listed.data.sessions[0]).toMatchObject({
    provider: 'antigravity-native',
    providerSessionId: expectedHash,
    sourceSessionId: convId,
    contentAvailability: 'AVAILABLE',
    captureCoverage: 'SOURCE_AVAILABLE_NO_HOOK_CAPTURE',
    identityEvidence: 'HASH_AND_APP_LOCATOR_VERIFIED'
  })

  const inspected = await f.call('inspect_agent_session', listed.data.sessions[0].deepen.arguments)
  expect(inspected.isError, JSON.stringify(inspected.data)).toBe(false)
  expect(inspected.data).toMatchObject({
    source: 'ANTIGRAVITY_APP_LOCAL_TRANSCRIPT_V1',
    contentAvailability: 'AVAILABLE',
    captureCoverage: 'SOURCE_AVAILABLE_NO_HOOK_CAPTURE',
    identityEvidence: 'HASH_AND_APP_LOCATOR_VERIFIED',
    sourceEventCount: 4
  })

  const events = await f.call('list_agent_session_events', {
    ...listed.data.sessions[0].deepen.arguments,
    expectedRevision: inspected.data.revision,
    types: ['AGENT_UPDATE']
  })
  const read = await f.call('read_agent_session_event', {
    ...listed.data.sessions[0].deepen.arguments,
    expectedRevision: inspected.data.revision,
    eventId: events.data.events[0].eventId
  })
  expect(read.data.content).toBe('Hookless reply token=[REDACTED]')
  expect(read.data.sanitized).toBe(true)

  // Foreign Antigravity conversation without matching sessionHash or workspace root fails ORIGIN_UNVERIFIED
  const foreignInspect = await f.call('inspect_agent_session', {
    sourceSessionId: foreignConvId,
    nativeSession: {
      provider: 'antigravity-native',
      id: nativeDigest(JSON.stringify(['repo-u3', 'antigravity', foreignConvId])),
      ...f.target
    }
  })
  expect(foreignInspect.isError).toBe(true)
  expect(foreignInspect.data.code).toBe('ORIGIN_UNVERIFIED')

  // Partial hook (SessionStart without appTranscriptDigest) upgrades captureCoverage without losing source reading
  const spool = join(f.root, '.code-awareness/native-hooks/antigravity/spool')
  prepareNativeSpool(spool)
  const binding: NativeHookBinding = {
    schema: 1, enabled: true, provider: 'antigravity', repositoryId: 'repo-u3',
    ...f.target, ...nativeGitIdentity(f.root), spool
  }
  const hookStart = normalizeNativeHook({ conversationId: convId, workspacePaths: [f.root], hookEventName: 'SessionStart' }, binding)
  f.getStore().registry.apply(nativeObservationBatch(hookStart), undefined)

  const afterHook = await f.call('list_agent_sessions', { worktreeId: f.target.worktreeId, generation: f.target.generation })
  expect(afterHook.data.sessions).toHaveLength(1)
  expect(afterHook.data.sessions[0].captureCoverage).toBe('HOOK_OBSERVED_AND_SOURCE_AVAILABLE')
  const inspectAfterHook = await f.call('inspect_agent_session', afterHook.data.sessions[0].deepen.arguments)
  expect(inspectAfterHook.data).toMatchObject({
    contentAvailability: 'AVAILABLE',
    captureCoverage: 'HOOK_OBSERVED_AND_SOURCE_AVAILABLE',
    identityEvidence: 'HASH_AND_APP_LOCATOR_VERIFIED',
    observedEventCount: 1,
    sourceEventCount: 4
  })
}, 30000)


it('C1 enforces canonical checkout origin, generation isolation, multi-workspace strictness, and complete grant validation', async () => {
  const f = setup()
  const agProfile = join(f.dir, 'ag-c1')
  const codexProfile = join(f.dir, 'codex-c1')
  const siblingOther = join(f.dir, 'repo-other')
  const siblingTwo = join(f.dir, 'repo2')
  mkdirSync(siblingOther, { recursive: true })
  mkdirSync(siblingTwo, { recursive: true })

  const convMention = '019ba000-0000-7000-8000-000000000101'
  const convSibling = '019ba000-0000-7000-8000-000000000102'
  const convMulti = '019ba000-0000-7000-8000-000000000103'
  const convMultiInvalid = '019ba000-0000-7000-8000-000000000104'
  const convValid = '019ba000-0000-7000-8000-000000000105'
  for (const id of [convMention, convSibling, convMulti, convMultiInvalid, convValid]) {
    const p = antigravityAppTranscriptPath(agProfile, id)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-17T10:00:00Z', content: `Active Workspaces:\n- ${f.root}\n` },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T10:00:02Z',
        tool_calls: [{ name: 'run_command', args: { Cwd: siblingOther, CommandLine: `type "${f.root}"`, Path: f.root } }],
        content: `Verified answer for ${id}` }
    ].map(r => JSON.stringify(r)).join('\n') + '\n')
  }

  seedAntigravitySummariesDb(agProfile, [
    { id: convMention, workspaceUris: [pathToFileURL(siblingOther).href] },
    { id: convSibling, workspaceUris: [pathToFileURL(siblingTwo).href] },
    { id: convMulti, workspaceUris: [pathToFileURL(f.root).href, pathToFileURL(siblingOther).href] },
    { id: convMultiInvalid, workspaceUris: JSON.stringify([pathToFileURL(f.root).href, 'not-a-uri']) },
    { id: convValid, workspaceUris: [pathToFileURL(f.root).href] }
  ])

  const hMention = nativeDigest(JSON.stringify(['repo-u3', 'antigravity', convMention]))
  const hSibling = nativeDigest(JSON.stringify(['repo-u3', 'antigravity', convSibling]))
  const hMulti = nativeDigest(JSON.stringify(['repo-u3', 'antigravity', convMulti]))
  const hMultiInvalid = nativeDigest(JSON.stringify(['repo-u3', 'antigravity', convMultiInvalid]))
  const hValid = nativeDigest(JSON.stringify(['repo-u3', 'antigravity', convValid]))

  // Seed Codex prefix sibling session + matching Codex session
  const rolloutDir = join(codexProfile, 'sessions', '2026', '11', '17')
  mkdirSync(rolloutDir, { recursive: true })
  const codexAccHash = nativeDigest(JSON.stringify(['c1-u', 'c1-a']))
  const codexSiblingId = '01a1e000-0000-7000-8000-000000000111'
  const codexValidId = '01a1e000-0000-7000-8000-000000000112'
  writeFileSync(join(rolloutDir, `rollout-2026-11-17T09-00-00-${codexSiblingId}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: codexSiblingId, session_id: codexSiblingId, account_scoped: true, creator_user_id: 'c1-u', creator_account_id: 'c1-a', cwd: siblingTwo, runtime_workspace_roots: [siblingTwo], cli_version: '0.169.0-alpha.11.1' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SIBLING' }] } })
  ].join('\n') + '\n')
  writeFileSync(join(rolloutDir, `rollout-2026-11-17T09-05-00-${codexValidId}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: codexValidId, session_id: codexValidId, account_scoped: true, creator_user_id: 'c1-u', creator_account_id: 'c1-a', cwd: f.root, runtime_workspace_roots: [f.root], cli_version: '0.169.0-alpha.11.1' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CODEX_OK' }] } })
  ].join('\n') + '\n')

  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u3',
    nativeSources: {
      codex: { profile: codexProfile, creatorAccountHash: codexAccHash },
      antigravityApp: { profile: agProfile, sessionHashes: [hMention, hSibling, hMulti, hMultiInvalid, hValid] }
    }
  }))

  const listed = await f.call('list_agent_sessions', { worktreeId: f.target.worktreeId, generation: f.target.generation })
  expect(listed.isError).toBe(false)
  expect(listed.data.sessions.map((s: any) => s.sourceSessionId).sort()).toEqual([codexValidId, convValid].sort())

  for (const [id, hash] of [[convMention, hMention], [convSibling, hSibling], [convMulti, hMulti], [convMultiInvalid, hMultiInvalid]]) {
    const res = await f.call('inspect_agent_session', {
      sourceSessionId: id,
      nativeSession: { provider: 'antigravity-native', id: hash, ...f.target }
    })
    expect(res.isError).toBe(true)
    expect(res.data.code).toBe('ORIGIN_UNVERIFIED')
  }

  // Malformed sessionHashes must reject (never relax to unrestricted)
  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u3',
    nativeSources: { antigravityApp: { profile: agProfile, sessionHashes: 'invalid-string' } }
  }))
  expect(await f.call('inspect_agent_session', {
    sourceSessionId: convValid,
    nativeSession: { provider: 'antigravity-native', id: hValid, ...f.target }
  })).toMatchObject({ isError: false, data: { sourceDiagnostic: 'PROFILE_UNAVAILABLE' } })

  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u3',
    nativeSources: { antigravityApp: { profile: agProfile, sessionHashes: [hValid, 'bad-hex'] } }
  }))
  expect(await f.call('inspect_agent_session', {
    sourceSessionId: convValid,
    nativeSession: { provider: 'antigravity-native', id: hValid, ...f.target }
  })).toMatchObject({ isError: false, data: { sourceDiagnostic: 'PROFILE_UNAVAILABLE' } })

  // Dual sessionHash + sessionHashes must satisfy BOTH
  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u3',
    nativeSources: { antigravityApp: { profile: agProfile, sessionHash: hValid, sessionHashes: [hMention] } }
  }))
  expect(await f.call('inspect_agent_session', {
    sourceSessionId: convValid,
    nativeSession: { provider: 'antigravity-native', id: hValid, ...f.target }
  })).toMatchObject({ isError: false, data: { sourceDiagnostic: 'PROFILE_UNAVAILABLE' } })

  // Bad hook locator digest rejects cleanly without leaking verified content
  const wrongRepoConfig = { repositoryId: 'wrong-repo', nativeSources: { antigravityApp: { profile: agProfile, sessionHashes: [hValid] } } }
  writeFileSync(f.configPath, JSON.stringify(wrongRepoConfig))
  expect(await f.call('inspect_agent_session', {
    sourceSessionId: convValid,
    nativeSession: { provider: 'antigravity-native', id: hValid, ...f.target }
  })).toMatchObject({ isError: false, data: { sourceDiagnostic: 'PROFILE_UNAVAILABLE' } })

  // Restore valid dual grant & test wrong locator digest + recreated generation conflict
  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u3',
    nativeSources: {
      codex: { profile: codexProfile, creatorAccountHash: codexAccHash },
      antigravityApp: { profile: agProfile, sessionHash: hValid, sessionHashes: [hValid] }
    }
  }))

  const spool = join(f.root, '.code-awareness/native-hooks/spool')
  prepareNativeSpool(spool)
  const agSpool = join(f.root, '.code-awareness/native-hooks/antigravity/spool')
  prepareNativeSpool(agSpool)
  const bindingCodex: NativeHookBinding = {
    schema: 1, enabled: true, provider: 'codex', repositoryId: 'repo-u3', ...f.target, ...nativeGitIdentity(f.root), spool
  }
  const bindingAg: NativeHookBinding = {
    schema: 1, enabled: true, provider: 'antigravity', repositoryId: 'repo-u3', ...f.target, ...nativeGitIdentity(f.root), spool: agSpool
  }
  f.getStore().registry.apply(nativeObservationBatch(normalizeNativeHook({
    session_id: codexValidId, cwd: f.root, hook_event_name: 'SessionStart', transcript_path: join(rolloutDir, `rollout-2026-11-17T09-05-00-${codexValidId}.jsonl`)
  }, bindingCodex)), undefined)
  f.getStore().registry.apply(nativeObservationBatch(normalizeNativeHook({
    conversationId: convValid, workspacePaths: [f.root], hookEventName: 'Stop',
    transcriptPath: join(agProfile, 'brain', convValid, '.system_generated', 'logs', 'wrong.jsonl')
  }, bindingAg)), undefined)

  // Recreated worktree at exact same path f.root with different generation MUST NOT inherit prior generation's sessions
  const recreatedTarget = { worktreeId: f.target.worktreeId, generation: '9'.repeat(64) }
  const recreatedRes = await executeSessionTool(
    f.getStore(), {}, 'list_agent_sessions', recreatedTarget, () => {}, recreatedTarget, [{ ...recreatedTarget, root: f.root, fingerprint: 'fp2' }], undefined, f.root
  )
  const recreatedList = JSON.parse((recreatedRes.content[0] as { text: string }).text)
  expect(recreatedList.sessions).toEqual([])

  for (const [provider, id, hash] of [
    ['antigravity-native', convValid, hValid] as const,
    ['codex-native', codexValidId, nativeDigest(JSON.stringify(['repo-u3', 'codex', codexValidId]))] as const
  ]) {
    const errRes = await executeSessionTool(
      f.getStore(), {}, 'inspect_agent_session',
      { sourceSessionId: id, nativeSession: { provider, id: hash, ...recreatedTarget } },
      () => {}, recreatedTarget, [{ ...recreatedTarget, root: f.root, fingerprint: 'fp2' }], undefined, f.root
    )
    expect(errRes.isError).toBe(true)
    expect(JSON.parse((errRes.content[0] as { text: string }).text).code).toBe('ORIGIN_UNVERIFIED')
  }
}, 30000)

it('C2 discovers via metadata/indexes with zero Antigravity transcript opens, strict agent short-circuiting, header/byte caps, and honest partial coverage', async () => {
  const f = setup()
  const agProfile = join(f.dir, 'ag-c2')
  const codexProfile = join(f.dir, 'codex-c2')
  const otherRepo = join(f.dir, 'other-c2-repo')
  mkdirSync(otherRepo, { recursive: true })

  // Seed Antigravity with 25 noisy other-repo sessions containing corrupt/huge unparseable transcripts + 1 matching session
  const agMatch = '019ba000-0000-7000-8000-000000000201'
  const dbRows: Array<{ id: string; workspaceUris: unknown; lastModified?: string }> = [
    { id: agMatch, workspaceUris: [pathToFileURL(f.root).href], lastModified: '2026-11-17 12:00:00+00:00' }
  ]
  const matchPath = antigravityAppTranscriptPath(agProfile, agMatch)
  mkdirSync(dirname(matchPath), { recursive: true })
  writeFileSync(matchPath, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-17T12:00:00Z', content: 'Check build' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T12:00:01Z', content: 'C2_AG_OK' }
  ].map(r => JSON.stringify(r)).join('\n') + '\n')

  for (let i = 0; i < 25; i++) {
    const id = `019ba000-0000-7000-8000-${String(210 + i).padStart(12, '0')}`
    dbRows.push({ id, workspaceUris: [pathToFileURL(otherRepo).href], lastModified: '2026-11-17 12:05:00+00:00' })
    const p = antigravityAppTranscriptPath(agProfile, id)
    mkdirSync(dirname(p), { recursive: true })
    // Corrupt non-JSON payload that would fail or explode memory if discovery touched transcript bodies
    writeFileSync(p, '{CORRUPT_NOT_JSONL\0'.repeat(1024))
  }
  seedAntigravitySummariesDb(agProfile, dbRows)

  // Seed Codex with 28 small rollout files (unindexed exceeds 24 file limit)
  const codexDir = join(codexProfile, 'sessions', '2026', '11', '15')
  mkdirSync(codexDir, { recursive: true })
  const codexAccHash = nativeDigest(JSON.stringify(['c2-u', 'c2-a']))
  const codexMatchId = '01a1e000-0000-7000-8000-000000000201'
  const codexMatchPath = join(codexDir, `rollout-2026-11-17T12-00-00-${codexMatchId}.jsonl`)
  writeFileSync(codexMatchPath, [
    JSON.stringify({ type: 'session_meta', payload: { id: codexMatchId, session_id: codexMatchId, account_scoped: true, creator_user_id: 'c2-u', creator_account_id: 'c2-a', cwd: f.root, runtime_workspace_roots: [f.root], cli_version: '0.169.0-alpha.11.1', timestamp: '2026-11-17T12:00:00Z' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'C2_CODEX_OK' }] } })
  ].join('\n') + '\n')

  for (let i = 0; i < 27; i++) {
    const id = `01a1e000-0000-7000-8000-${String(220 + i).padStart(12, '0')}`
    writeFileSync(join(codexDir, `rollout-2026-11-17T12-05-${String(i).padStart(2, '0')}-${id}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id, session_id: id, account_scoped: true, creator_user_id: 'c2-u', creator_account_id: 'c2-a', cwd: otherRepo, runtime_workspace_roots: [otherRepo], cli_version: '0.169.0-alpha.11.1', pad: 'z'.repeat(28000) } }) + '\n')
  }

  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u3',
    nativeSources: {
      codex: { profile: codexProfile, creatorAccountHash: codexAccHash },
      antigravityApp: { profile: agProfile }
    }
  }))

  // 1. Direct Antigravity metadata-only check: 0 transcript files opened, 0 transcript bytes read
  const agDirect = discoverAntigravityAppSources({ storePath: f.storePath, repositoryId: 'repo-u3', worktreeRoot: f.root, assertCurrent: () => {} })
  expect(agDirect.sessions).toHaveLength(1)
  expect(agDirect.sessions[0].sourceSessionId).toBe(agMatch)
  expect(agDirect.stats).toMatchObject({ usedIndex: true, transcriptFilesOpened: 0, transcriptBytesRead: 0 })

  // 2. Agent filter in mcp.ts skips excluded provider completely
  const observedProviders: Array<{ provider: string; bytesRead: number; filesOpened: number; truncated: boolean }> = []
  const runList = async (extra: object) => {
    observedProviders.length = 0
    const res = await executeSessionTool(
      f.getStore(), {}, 'list_agent_sessions', { ...f.target, ...extra }, () => {}, f.target,
      [{ ...f.target, root: f.root, fingerprint: 'fp' }], undefined, f.root, undefined, undefined, undefined, undefined, undefined, false,
      report => observedProviders.push(report)
    )
    return JSON.parse((res.content[0] as { text: string }).text)
  }

  const onlyAg = await runList({ agent: 'antigravity' })
  expect(observedProviders.map(p => p.provider)).toEqual(['antigravity'])
  expect(onlyAg.sessions.map((s: any) => s.sourceSessionId)).toEqual([agMatch])

  const onlyClaude = await runList({ agent: 'claude' })
  expect(observedProviders).toEqual([])
  expect(onlyClaude.sessions).toEqual([])

  // 3. Unindexed Codex surfaces explicit truncation when >24 candidates or >512 KiB total header bytes exist
  const codexUnindexed = discoverCodexSources({ storePath: f.storePath, repositoryId: 'repo-u3', worktreeRoot: f.root, assertCurrent: () => {} })
  expect(codexUnindexed.truncated).toBe(true)
  expect(codexUnindexed.coverageReason).toBe('SOURCE_DISCOVERY_LIMIT_REACHED')
  expect(codexUnindexed.stats.filesOpened).toBeLessThanOrEqual(24)
  expect(codexUnindexed.stats.headerBytesRead).toBeLessThanOrEqual(512 * 1024 + 64 * 1024)

  const mcpTruncated = await runList({ agent: 'codex' })
  expect(observedProviders.map(p => p.provider)).toEqual(['codex'])
  expect(mcpTruncated.sourceDiscoveryCoverage).toBe('PARTIAL')
  expect(mcpTruncated.coverageReasons).toEqual({ SOURCE_DISCOVERY_LIMIT_REACHED: 1 })

  // 4. Adding Codex state_5.sqlite narrows candidates so ONLY the 1 matching checkout header is opened (massive I/O savings)
  const codexDb = new Database(join(codexProfile, 'state_5.sqlite'))
  try {
    codexDb.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, updated_at INTEGER)')
    const ins = codexDb.prepare('INSERT INTO threads (id, rollout_path, cwd, updated_at) VALUES (?, ?, ?, ?)')
    ins.run(codexMatchId, codexMatchPath, `\\\\?\\${f.root}`, 2000)
    for (let i = 0; i < 27; i++) {
      const id = `01a1e000-0000-7000-8000-${String(220 + i).padStart(12, '0')}`
      ins.run(id, join(codexDir, `rollout-2026-11-17T12-05-${String(i).padStart(2, '0')}-${id}.jsonl`), otherRepo, 1900 - i)
    }
  } finally {
    codexDb.close()
  }

  const codexIndexed = discoverCodexSources({ storePath: f.storePath, repositoryId: 'repo-u3', worktreeRoot: f.root, assertCurrent: () => {} })
  expect(codexIndexed.truncated).toBe(false)
  expect(codexIndexed.sessions).toHaveLength(1)
  expect(codexIndexed.stats.usedIndex).toBe(true)
  expect(codexIndexed.stats.filesOpened).toBe(1)
  expect(codexIndexed.stats.headerBytesRead).toBeLessThan(codexUnindexed.stats.headerBytesRead / 10)

  const indexedList = await runList({ agent: 'codex' })
  expect(indexedList.sessions).toHaveLength(1)
  expect(indexedList.sourceDiscoveryCoverage).toBeUndefined()

  // Inspect + read remain functional without storing transcripts
  const insp = await f.call('inspect_agent_session', indexedList.sessions[0].deepen.arguments)
  expect(insp.isError).toBe(false)
  const evs = await f.call('list_agent_session_events', { ...indexedList.sessions[0].deepen.arguments, expectedRevision: insp.data.revision })
  const read = await f.call('read_agent_session_event', { ...indexedList.sessions[0].deepen.arguments, expectedRevision: insp.data.revision, eventId: evs.data.events[0].eventId })
  expect(read.data.content).toBe('C2_CODEX_OK')
  expect(f.getStore().count()).toBe(0)

  // 5. Removing Antigravity conversation_summaries.db returns honest NO_METADATA_INDEX without crawling brain/
  execFileSync('node', ['-e', "require('node:fs').rmSync(process.argv[1], { force: true })", join(agProfile, 'conversation_summaries.db')], { windowsHide: true })
  const noIdx = await runList({ agent: 'antigravity' })
  expect(noIdx.sessions).toEqual([])
  expect(noIdx.sourceDiscoveryCoverage).toBe('PARTIAL')
  expect(noIdx.coverageReasons).toEqual({ NO_METADATA_INDEX: 1 })
  expect(noIdx.reason).toBe('NO_METADATA_INDEX')
  expect(observedProviders[0].filesOpened).toBe(0)
  expect(observedProviders[0].bytesRead).toBe(0)
}, 30000)


it('C4 normalizes repositoryId safely on continuity read boundary for Codex and Antigravity without weakening strict checks or authorization', async () => {
  const f = setup()
  const agProfile = join(f.dir, 'ag-c4')
  const codexProfile = join(f.dir, 'codex-c4')
  const codexDir = join(codexProfile, 'sessions', '2026', '11', '15')
  mkdirSync(codexDir, { recursive: true })

  const agConv = '019ba000-0000-7000-8000-000000000401'
  const codexConv = '01a1e000-0000-7000-8000-000000000401'
  const accHash = nativeDigest(JSON.stringify(['c4-u', 'c4-a']))

  const agPath = antigravityAppTranscriptPath(agProfile, agConv)
  mkdirSync(dirname(agPath), { recursive: true })
  writeFileSync(agPath, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-15T10:00:00Z', content: 'C4 user prompt' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-15T10:00:05Z', content: 'C4_AG_LITERAL_REPLY' }
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  seedAntigravitySummariesDb(agProfile, [{ id: agConv, workspaceUris: [pathToFileURL(f.root).href] }])

  writeFileSync(join(codexDir, `rollout-2026-11-15T10-00-00-${codexConv}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: codexConv, session_id: codexConv, account_scoped: true, creator_user_id: 'c4-u', creator_account_id: 'c4-a', cwd: f.root, runtime_workspace_roots: [f.root], cli_version: '0.169.0-alpha.11.1', timestamp: '2026-11-15T10:00:00Z' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'C4_CODEX_LITERAL_REPLY' }] } })
  ].join('\n') + '\n')

  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u3',
    nativeSources: {
      codex: { profile: codexProfile, creatorAccountHash: accHash },
      antigravityApp: { profile: agProfile }
    }
  }))

  const direct = async (name: Parameters<typeof executeSessionTool>[2], args: unknown, accountHash?: string) => {
    const res = await executeSessionTool(
      f.getStore(), {}, name, args, () => {}, f.target, [{ ...f.target, root: f.root, fingerprint: 'fp' }], undefined, f.root, undefined, undefined, accountHash
    )
    return { isError: !!res.isError, data: JSON.parse((res.content[0] as { text: string }).text) }
  }

  // 1. Same repo with vs without repositoryId yields equivalent results; literal round-trip works without stripping repositoryId manually
  const listWithRepo = await direct('list_agent_sessions', { repositoryId: 'repo-u3', ...f.target })
  const listWithoutRepo = await direct('list_agent_sessions', f.target)
  expect(listWithRepo.isError).toBe(false)
  expect(listWithRepo.data.sessions).toEqual(listWithoutRepo.data.sessions)
  expect(listWithRepo.data.sessions).toHaveLength(2)

  for (const [id, expectedText] of [[agConv, 'C4_AG_LITERAL_REPLY'], [codexConv, 'C4_CODEX_LITERAL_REPLY']] as const) {
    const session = listWithRepo.data.sessions.find((s: any) => s.sourceSessionId === id)
    expect(session.deepen.arguments.repositoryId).toBe('repo-u3')

    const insp = await direct('inspect_agent_session', session.deepen.arguments)
    expect(insp.isError).toBe(false)

    const evs = await direct('list_agent_session_events', {
      ...session.deepen.arguments,
      expectedRevision: insp.data.revision,
      types: ['AGENT_UPDATE']
    })
    expect(evs.isError).toBe(false)
    expect(evs.data.events).toHaveLength(1)

    const read = await direct('read_agent_session_event', {
      ...session.deepen.arguments,
      expectedRevision: insp.data.revision,
      eventId: evs.data.events[0].eventId
    })
    expect(read.isError).toBe(false)
    expect(read.data.content).toBe(expectedText)

    // 2. Divergent repositoryId refuses access on internal read boundary without changing store/checkout
    const wrongRepoInsp = await direct('inspect_agent_session', { ...session.deepen.arguments, repositoryId: 'other-repo' })
    expect(wrongRepoInsp).toEqual({ isError: true, data: { code: 'INVALID_ARGUMENT' } })

    const wrongRepoRead = await direct('read_agent_session_event', {
      ...session.deepen.arguments,
      repositoryId: 'other-repo',
      expectedRevision: insp.data.revision,
      eventId: evs.data.events[0].eventId
    })
    expect(wrongRepoRead).toEqual({ isError: true, data: { code: 'INVALID_ARGUMENT' } })

    // 3. Invalid repositoryId format and extra unknown fields are rejected strictly
    for (const badRepo of ['', 'bad/repo', 123, undefined]) {
      const bad = await direct('inspect_agent_session', { ...session.deepen.arguments, repositoryId: badRepo })
      expect(bad).toEqual({ isError: true, data: { code: 'INVALID_ARGUMENT' } })
    }
    const extraKey = await direct('inspect_agent_session', { ...session.deepen.arguments, extraField: 'rejected' })
    expect(extraKey).toEqual({ isError: true, data: { code: 'INVALID_ARGUMENT' } })

    // 4. Incompatible generation fails ORIGIN_UNVERIFIED even with valid repositoryId
    const badGen = await direct('inspect_agent_session', {
      ...session.deepen.arguments,
      nativeSession: { ...session.deepen.arguments.nativeSession, generation: '9'.repeat(64) }
    })
    expect(badGen).toEqual({ isError: true, data: { code: 'ORIGIN_UNVERIFIED' } })
  }

  // 5. Mutative and non-continuity tools remain strict against repositoryId
  const mutative = await direct('refresh_agent_sessions', { repositoryId: 'repo-u3', discardLegacyText: true })
  expect(mutative).toEqual({ isError: true, data: { code: 'INVALID_ARGUMENT' } })
  const nonContinuity = await direct('inspect_capture_health', { repositoryId: 'repo-u3', ...f.target })
  expect(nonContinuity).toEqual({ isError: true, data: { code: 'INVALID_ARGUMENT' } })

  // 6. Revoked grant fails even when repositoryId matches store
  writeFileSync(f.configPath, JSON.stringify({ repositoryId: 'repo-u3', nativeSources: {} }))
  const agSession = listWithRepo.data.sessions.find((s: any) => s.sourceSessionId === agConv)
  const codexSession = listWithRepo.data.sessions.find((s: any) => s.sourceSessionId === codexConv)
  expect(await direct('inspect_agent_session', agSession.deepen.arguments)).toMatchObject({ isError: false, data: { sourceDiagnostic: 'PROFILE_UNAVAILABLE' } })
  expect(await direct('inspect_agent_session', codexSession.deepen.arguments)).toEqual({ isError: true, data: { code: 'SOURCE_NOT_AUTHORIZED' } })
  expect(f.getStore().count()).toBe(0)
}, 30000)

it('U2 qualifies Codex 0.171.0-alpha.13 and future structural equivalents while rejecting incompatible format, account mismatch, and root spoofing', async () => {
  const f = setup()
  const profile = join(f.dir, 'codex-profile')
  const accHash = nativeDigest(JSON.stringify(['u-compat', 'a-compat']))
  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u3',
    nativeSources: { codex: { profile, creatorAccountHash: accHash } }
  }))

  const s171 = '01a1f100-0000-7000-8000-000000000011'
  const sFuture = '01a1f100-0000-7000-8000-000000000012'
  const sBadFormat = '01a1f100-0000-7000-8000-000000000013'
  const sSpoofedRoot = '01a1f100-0000-7000-8000-000000000014'
  const sWrongAccount = '01a1f100-0000-7000-8000-000000000015'

  const writeRollout = (id: string, metaPayload: Record<string, unknown>, text: string) => {
    const day = new Date(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).split('-')
    const dir = join(profile, 'sessions', ...day)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `rollout-2026-11-23T10-00-00-${id}.jsonl`), [
      JSON.stringify({ timestamp: '2026-11-23T10:00:00Z', type: 'session_meta', payload: metaPayload }),
      JSON.stringify({ timestamp: '2026-11-23T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
    ].join('\n') + '\n')
  }

  writeRollout(s171, {
    id: s171, session_id: s171, account_scoped: true, creator_user_id: 'u-compat', creator_account_id: 'a-compat',
    cwd: f.root, runtime_workspace_roots: [f.root], cli_version: '0.171.0-alpha.13'
  }, 'codex-171-literal')

  writeRollout(sFuture, {
    id: sFuture, session_id: sFuture, account_scoped: true, creator_user_id: 'u-compat', creator_account_id: 'a-compat',
    cwd: f.root, runtime_workspace_roots: [f.root], cli_version: '0.175.0-beta.1'
  }, 'codex-future-literal')

  writeRollout(sBadFormat, {
    id: sBadFormat, session_id: sBadFormat, account_scoped: true, creator_user_id: 'u-compat', creator_account_id: 'a-compat',
    cwd: f.root, runtime_workspace_roots: [f.root], cli_version: ''
  }, 'should-not-read-bad-format')

  const foreignRoot = join(f.dir, 'foreign-root')
  mkdirSync(foreignRoot, { recursive: true })
  writeRollout(sSpoofedRoot, {
    id: sSpoofedRoot, session_id: sSpoofedRoot, account_scoped: true, creator_user_id: 'u-compat', creator_account_id: 'a-compat',
    cwd: foreignRoot, runtime_workspace_roots: [foreignRoot], cli_version: '0.171.0-alpha.13'
  }, 'should-not-read-spoofed')

  writeRollout(sWrongAccount, {
    id: sWrongAccount, session_id: sWrongAccount, account_scoped: true, creator_user_id: 'other-u', creator_account_id: 'other-a',
    cwd: f.root, runtime_workspace_roots: [f.root], cli_version: '0.171.0-alpha.13'
  }, 'should-not-read-wrong-account')

  const listed = await f.call('list_agent_sessions', { ...f.target })
  expect(listed.isError).toBe(false)
  const discoveredIds = listed.data.sessions.map((s: any) => s.sourceSessionId)
  expect(discoveredIds).toContain(s171)
  expect(discoveredIds).toContain(sFuture)
  expect(discoveredIds).not.toContain(sBadFormat)
  expect(discoveredIds).not.toContain(sSpoofedRoot)
  expect(discoveredIds).not.toContain(sWrongAccount)

  for (const [id, expectedText] of [[s171, 'codex-171-literal'], [sFuture, 'codex-future-literal']] as const) {
    const sess = listed.data.sessions.find((s: any) => s.sourceSessionId === id)
    const insp = await f.call('inspect_agent_session', sess.deepen.arguments)
    expect(insp.isError).toBe(false)
    const evs = await f.call('list_agent_session_events', { ...sess.deepen.arguments, expectedRevision: insp.data.revision, limit: 5 })
    const read = await f.call('read_agent_session_event', { ...sess.deepen.arguments, expectedRevision: insp.data.revision, eventId: evs.data.events[0].eventId })
    expect(read.data.content).toBe(expectedText)
  }

  expect(await f.call('inspect_agent_session', {
    sourceSessionId: sBadFormat,
    nativeSession: { provider: 'codex-native', id: nativeDigest(JSON.stringify(['repo-u3', 'codex', sBadFormat])), ...f.target }
  })).toEqual({ isError: true, data: { code: 'SOURCE_FORMAT_UNSUPPORTED' } })

  expect(await f.call('inspect_agent_session', {
    sourceSessionId: sSpoofedRoot,
    nativeSession: { provider: 'codex-native', id: nativeDigest(JSON.stringify(['repo-u3', 'codex', sSpoofedRoot])), ...f.target }
  })).toEqual({ isError: true, data: { code: 'ORIGIN_UNVERIFIED' } })

  expect(await f.call('inspect_agent_session', {
    sourceSessionId: sWrongAccount,
    nativeSession: { provider: 'codex-native', id: nativeDigest(JSON.stringify(['repo-u3', 'codex', sWrongAccount])), ...f.target }
  })).toEqual({ isError: true, data: { code: 'SOURCE_IDENTITY_CONFLICT' } })
}, 60_000)
