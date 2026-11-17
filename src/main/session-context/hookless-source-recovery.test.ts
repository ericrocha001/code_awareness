import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { antigravityAppTranscriptPath } from './antigravity-app-locator'
import { executeSessionTool } from './mcp'
import { nativeObservationBatch } from './native-hook-ingestion'
import { nativeDigest, nativeGitIdentity, normalizeNativeHook, prepareNativeSpool, type NativeHookBinding } from './native-hooks'
import { SessionStore, sessionStorePath } from './store'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()) })

function safeRemove(dir: string) {
  execFileSync('node', ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })", dir], { windowsHide: true })
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
    sourceEventCount: 1
  })

  const events = await f.call('list_agent_session_events', {
    ...listed.data.sessions[0].deepen.arguments,
    expectedRevision: inspected.data.revision
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
    sourceEventCount: 1
  })
}, 30000)
