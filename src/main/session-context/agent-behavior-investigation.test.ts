import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { antigravityAppTranscriptPath } from './antigravity-app-locator'
import { executeSessionTool } from './mcp'
import { nativeDigest } from './native-hooks'
import { SessionStore, sessionStorePath } from './store'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()) })

function safeRemove(dir: string) {
  execFileSync('node', ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })", dir], { windowsHide: true })
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'u4-behavior-'))
  cleanup.push(() => safeRemove(dir))
  const root = join(dir, 'repo')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/feat\n')
  const target = { worktreeId: '1'.repeat(64), generation: '2'.repeat(64) }
  const storePath = sessionStorePath(dir, 'repo-u4')
  const store = new SessionStore(storePath, 'repo-u4')
  cleanup.push(() => store.close())
  const configPath = join(dirname(storePath), 'session-context.provider.json')
  const principal = authenticatedAgentPrincipal('MCP', () => true)
  const authority = authorizeArtifactAgent(principal, 'repo-u4', () => true)
  const adapter = new ChannelMcpAdapter({
    projectId: 'repo-u4',
    repoRoot: root,
    navigation: {} as never,
    continuum: { repositoryId: 'repo-u4' } as never,
    sessionContext: {
      call: (name, args) => executeSessionTool(store, {}, name, args, () => {}, target, [{ ...target, root, fingerprint: 'fp' }], undefined, root)
    }
  })
  const call = async (name: Parameters<typeof executeSessionTool>[2], args: unknown) => {
    const res = await adapter.callTool(name, args, undefined, authority)
    return { isError: !!res.isError, data: JSON.parse((res.content[0] as { text: string }).text) }
  }
  return { dir, root, target, store, configPath, call }
}

it('U4 investigates Codex attempts, retries, first error, dangling calls, unpaired results, final replies, sanitization, UTF-8 cursors, and filter errors', async () => {
  const f = setup()
  const profile = join(f.dir, 'codex')
  const rolloutDir = join(profile, 'sessions', '2026', '11', '15')
  mkdirSync(rolloutDir, { recursive: true })
  const sessionUuid = '01a1e000-0000-7000-8000-000000000041'
  const accountHash = nativeDigest(JSON.stringify(['u4-user', 'u4-acc']))
  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u4',
    nativeSources: { codex: { profile, creatorAccountHash: accountHash } }
  }))

  const largeErr = 'E_🧪_FAILURE '.repeat(850) + 'Authorization: Bearer u4-secret-token'
  const rolloutPath = join(rolloutDir, `rollout-2026-11-15T10-00-00-${sessionUuid}.jsonl`)
  const writeRows = (extra: object[] = []) => {
    const rows = [
      {
        timestamp: '2026-11-15T10:00:00Z',
        type: 'session_meta',
        payload: {
          id: sessionUuid, session_id: sessionUuid, account_scoped: true,
          creator_user_id: 'u4-user', creator_account_id: 'u4-acc',
          cwd: f.root, runtime_workspace_roots: [f.root], cli_version: '0.169.0-alpha.11.1'
        }
      },
      { timestamp: '2026-11-15T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', cwd: f.root } },
      { timestamp: '2026-11-15T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run build & fix secret=prompt-secret' }] } },
      { timestamp: '2026-11-15T10:00:03Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-fail', arguments: '{"cmd":"npm test"}' } },
      { timestamp: '2026-11-15T10:00:04Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-fail', output: JSON.stringify({ isError: true, code: 'BUILD_FAILED', error: largeErr }) } },
      { timestamp: '2026-11-15T10:01:00Z', type: 'turn_context', payload: { turn_id: 'turn-2', cwd: f.root } },
      { timestamp: '2026-11-15T10:01:01Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec_command', call_id: 'call-ok', input: 'npm test' } },
      { timestamp: '2026-11-15T10:01:02Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-ok', output: [{ type: 'input_text', text: 'Exit code: 0\nPASS' }] } },
      { timestamp: '2026-11-15T10:01:03Z', type: 'response_item', payload: { type: 'function_call', name: 'orphan_tool', call_id: 'call-dangling', arguments: '{}' } },
      { timestamp: '2026-11-15T10:01:04Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'unknown-call', output: 'Unpaired output' } },
      { timestamp: '2026-11-15T10:01:05Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-2', reason: 'policy_denied_token' } },
      { timestamp: '2026-11-15T10:02:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final answer after retry' }] } },
      ...extra
    ]
    writeFileSync(rolloutPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  }
  writeRows()

  const nativeHash = nativeDigest(JSON.stringify(['repo-u4', 'codex', sessionUuid]))
  const baseArgs = { sourceSessionId: sessionUuid, nativeSession: { provider: 'codex-native', id: nativeHash, ...f.target } }

  const insp = await f.call('inspect_agent_session', baseArgs)
  expect(insp.isError).toBe(false)
  expect(insp.data).toMatchObject({
    sourceCoverage: 'TYPED_SOURCE_EVENTS_WITH_ATTEMPTS',
    attemptSummary: { total: 3, success: 1, failure: 1, refusal: 0, dangling: 1, attemptCoverage: 'EXACT_CALL_ID_PAIRING' },
    errors: [
      { tool: 'exec_command', status: 'FAILURE', errorKind: 'BUILD_FAILED', turnId: 'turn-1' },
      { status: 'REFUSAL', errorKind: 'TURN_ABORTED', turnId: 'turn-2' }
    ],
    danglingCalls: [{ tool: 'orphan_tool', pairing: 'DANGLING', turnId: 'turn-2' }],
    turnCoverage: 'PARTIAL'
  })
  expect(JSON.stringify(insp.data)).not.toContain('u4-secret-token')
  expect(JSON.stringify(insp.data)).not.toContain('prompt-secret')

  const errorEvents = await f.call('list_agent_session_events', { ...baseArgs, expectedRevision: insp.data.revision, types: ['ERROR'] })
  expect(errorEvents.data.events).toHaveLength(2)
  expect(JSON.stringify(errorEvents.data)).not.toContain('u4-secret-token')

  // Selective literal read of FIRST error event with UTF-8 paging & secret redaction
  let errCursor: string | undefined, errText = ''
  do {
    const page = await f.call('read_agent_session_event', {
      ...baseArgs, expectedRevision: insp.data.revision, eventId: insp.data.errors[0].eventId, cursor: errCursor
    })
    expect(page.isError).toBe(false)
    expect(page.data.sanitized).toBe(true)
    errText += page.data.content
    errCursor = page.data.nextCursor
  } while (errCursor)
  expect(errText).toContain('[REDACTED]')
  expect(errText).not.toContain('u4-secret-token')
  expect(errText).toContain('E_🧪_FAILURE')

  // Filters: tool + turnId + after/before + query + incompatible filters
  const byTool = await f.call('list_agent_session_events', { ...baseArgs, expectedRevision: insp.data.revision, tool: 'exec_command', after: '2026-11-15T10:01:00Z' })
  expect(byTool.data.events.map((e: any) => [e.type, e.status])).toEqual([['TOOL_CALL', 'SUCCESS'], ['TOOL_RESULT', 'SUCCESS']])

  const byTurn = await f.call('list_agent_session_events', { ...baseArgs, expectedRevision: insp.data.revision, turnId: 'turn-1', limit: 1 })
  expect(byTurn.data.events).toHaveLength(1)
  expect(byTurn.data.nextCursor).toBeDefined()
  // Cursor bound to filter scope must reject changed filter
  const wrongCursor = await f.call('list_agent_session_events', { ...baseArgs, expectedRevision: insp.data.revision, turnId: 'turn-2', limit: 1, cursor: byTurn.data.nextCursor })
  expect(wrongCursor.data).toEqual({ code: 'CURSOR_STALE' })

  const byFile = await f.call('list_agent_session_events', { ...baseArgs, expectedRevision: insp.data.revision, file: 'src/a.ts' })
  expect(byFile.data.events).toEqual([])
  expect(byFile.data.fileCoverage).toMatchObject({ state: 'NOT_OBSERVED', reason: 'FILE_FILTER_NOT_INDEXED_FOR_SOURCE' })

  const legacyType = await f.call('list_agent_session_events', { ...baseArgs, expectedRevision: insp.data.revision, types: ['COMMIT'] })
  expect(legacyType.data.events).toEqual([])
  expect(legacyType.data.coverageReason).toBe('UNSUPPORTED_EVENT_TYPE_FILTER')

  // Drift invalidates revision
  writeRows([{ timestamp: '2026-11-15T10:02:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'New event' }] } }])
  const stale = await f.call('inspect_agent_session', { ...baseArgs, expectedRevision: insp.data.revision })
  expect(stale.data).toEqual({ code: 'REVISION_CONFLICT' })
  expect(f.store.count()).toBe(0)
}, 30000)

it('U4 decodes Antigravity App behavior without fabricating call pairs, plus reply-only sessions', async () => {
  const f = setup()
  const profile = join(f.dir, 'ag')
  const convErr = '019ba000-0000-7000-8000-000000000042'
  const convReplyOnly = '019ba000-0000-7000-8000-000000000043'
  const pErr = antigravityAppTranscriptPath(profile, convErr)
  const pReply = antigravityAppTranscriptPath(profile, convReplyOnly)
  mkdirSync(dirname(pErr), { recursive: true })
  mkdirSync(dirname(pReply), { recursive: true })

  writeFileSync(pErr, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-17T10:00:00Z', content: `Check ${f.root}` },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T10:00:02Z', tool_calls: [{ name: 'run_command', args: { Cwd: f.root, CommandLine: 'npm test token=ag-secret' } }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'ERROR', created_at: '2026-11-17T10:00:05Z', content: 'Test failed exit 1', error: 'COMMAND_FAILED token=ag-secret' },
    { step_index: 3, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', created_at: '2026-11-17T10:00:06Z', error: 'PERMISSION_DENIED', error_code: 'PERMISSION_DENIED' },
    { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T10:00:08Z', content: 'Tests failed due to missing binary.' }
  ].map(r => JSON.stringify(r)).join('\n') + '\n')

  writeFileSync(pReply, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-17T10:00:00Z', content: 'Quick question' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-17T10:00:02Z', content: 'Direct answer without tools.' }
  ].map(r => JSON.stringify(r)).join('\n') + '\n')

  const hErr = nativeDigest(JSON.stringify(['repo-u4', 'antigravity', convErr]))
  const hReply = nativeDigest(JSON.stringify(['repo-u4', 'antigravity', convReplyOnly]))
  writeFileSync(f.configPath, JSON.stringify({
    repositoryId: 'repo-u4',
    nativeSources: { antigravityApp: { profile, sessionHashes: [hErr, hReply] } }
  }))

  const argsErr = { sourceSessionId: convErr, nativeSession: { provider: 'antigravity-native', id: hErr, ...f.target } }
  const inspErr = await f.call('inspect_agent_session', argsErr)
  expect(inspErr.isError).toBe(false)
  expect(inspErr.data).toMatchObject({
    sourceCoverage: 'TYPED_SOURCE_EVENTS_UNPAIRED_TOOLS',
    attemptSummary: { total: 1, unknown: 1, dangling: 0, attemptCoverage: 'NO_NATIVE_CALL_PAIR_ID' },
    errors: [
      { status: 'FAILURE', errorKind: 'GENERIC_ERROR' },
      { status: 'REFUSAL', errorKind: 'PERMISSION_DENIED' }
    ]
  })
  expect(JSON.stringify(inspErr.data)).not.toContain('ag-secret')

  const unsupportedTurn = await f.call('list_agent_session_events', { ...argsErr, expectedRevision: inspErr.data.revision, turnId: 'turn-1' })
  expect(unsupportedTurn.data).toMatchObject({ events: [], turnCoverage: 'UNKNOWN', reason: 'TURN_ID_NOT_OBSERVED_IN_SOURCE' })

  const readFirstErr = await f.call('read_agent_session_event', {
    ...argsErr, expectedRevision: inspErr.data.revision, eventId: inspErr.data.errors[0].eventId
  })
  expect(readFirstErr.data.content).toBe('COMMAND_FAILED token=[REDACTED]')
  expect(readFirstErr.data.sanitized).toBe(true)

  const replyOnly = await f.call('inspect_agent_session', {
    sourceSessionId: convReplyOnly,
    nativeSession: { provider: 'antigravity-native', id: hReply, ...f.target }
  })
  expect(replyOnly.isError).toBe(false)
  expect(replyOnly.data.attemptSummary.total).toBe(0)
  expect(replyOnly.data.errors).toEqual([])
  expect(replyOnly.data.sourceTypeCounts).toEqual([{ type: 'INPUT', count: 1 }, { type: 'AGENT_UPDATE', count: 1 }])
  expect(f.store.count()).toBe(0)
}, 30000)
