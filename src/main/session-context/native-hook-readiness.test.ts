import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { installNativeHooks, inspectNativeInstallation } from './native-hook-installation'
import { nativeCaptureRuntimeId, nativeDigest, normalizeNativeHook, parseNativeEnvelope, readNativeBinding, spoolNativeHook, recordNativeGap } from './native-hooks'
import { nativeObservationBatch } from './native-hook-ingestion'
import { SessionStore, sessionStorePath } from './store'
import { nativeHookReadiness } from './native-hook-readiness'
import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { SessionContextClient } from './client'
import { sourceFingerprint, type SessionTargetResolver } from './target'
import { inspectNativeTrust, unknownNativeTrust, type NativeHookClient, type NativeClientScope } from './native-hook-preflight'
import { summarizeHookList } from '../../shared/native-hook-preflight.cjs'
import { stampNativeCapture } from './native-capture-window'
import { ingestNativeHooks } from './native-hook-ingestion'
import { executeSessionTool } from './mcp'
import { antigravitySourceDiagnostic } from './antigravity-source-diagnostics'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { antigravityAppTranscriptPath } from './antigravity-app-locator'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hook-readiness-'))
  cleanup.push(() => {
    if (process.platform === 'win32') execFileSync('node', ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5 })", root], { windowsHide: true })
    else rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/test\n')
  const commandPath = join(root, 'native-hook.cjs'); writeFileSync(commandPath, '')
  const target = { repositoryId: 'repo', worktreeId: '1'.repeat(64), generation: '2'.repeat(64) }
  const record = { path: root, ...target, branch: 'test', head: 'a'.repeat(40), detached: false, locked: false, missing: false, prunable: false }
  const bindingPath = join(root, '.code-awareness/native-hooks/binding.json'), configPath = join(root, '.codex/hooks.json'), snapshotPath = join(root, '.code-awareness/native-hooks/installation.json')
  const install = () => installNativeHooks({ repositoryId: 'repo', record, commandPath, nodePath: process.execPath, authorized: true })
  const change = (edit: (config: any) => void, resign = false) => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')); edit(config)
    const text = JSON.stringify(config); writeFileSync(configPath, text)
    if (resign) { const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')); snapshot.installedDigest = nativeDigest(text); writeFileSync(snapshotPath, JSON.stringify(snapshot)) }
  }
  const storePath = sessionStorePath(root, 'repo')
  let store = new SessionStore(storePath, 'repo'); cleanup.push(() => store.close())
  return { root, target, install, bindingPath, configPath, snapshotPath, change, store: () => store,
    restart: () => { store.close(); store = new SessionStore(storePath, 'repo') } }
}

it('reads only a hook-selected Antigravity App reply and replays sanitized byte pages after restart', async () => {
  const f = fixture()
  f.install()
  const id = '019ba000-0000-7000-8000-000000000001'
  const profile = join(f.root, '.gemini', 'antigravity')
  const path = antigravityAppTranscriptPath(profile, id)
  const binding = { ...readNativeBinding(f.bindingPath), provider: 'antigravity' as const }
  const input = { conversationId: id, workspacePaths: [f.root], hookEventName: 'Stop', transcriptPath: path }
  const captured = normalizeNativeHook(input, binding)
  expect(parseNativeEnvelope(JSON.stringify(captured)).appTranscriptDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(captured)).not.toContain('transcript_full')
  expect(normalizeNativeHook({ ...input, transcriptPath: path.replace('antigravity', 'antigravity-ide') }, binding).appTranscriptDigest).toBeUndefined()
  f.store().registry.apply(nativeObservationBatch(captured), undefined)
  mkdirSync(dirname(path), { recursive: true })
  const text = 'output 🧪 '.repeat(900) + ' token=private-sentinel'
  const sanitized = text.replace('private-sentinel', '[REDACTED]')
  const write = (answer: string) => writeFileSync(path, [
    { step_index: 0, type: 'USER_INPUT', source: 'USER', created_at: '2026-11-15T20:00:00Z', content: 'private-user-message' },
    { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-11-15T20:01:00Z', content: answer }
  ].map(record => JSON.stringify(record)).join('\n') + '\n')
  const args = { sourceSessionId: id, nativeSession: { id: captured.sessionId, provider: 'antigravity-native',
    worktreeId: f.target.worktreeId, generation: f.target.generation } }
  const call = async (name: Parameters<typeof executeSessionTool>[2], input: object) =>
    JSON.parse((await executeSessionTool(f.store(), {}, name, { ...args, ...input }, () => {}, f.target, [], undefined, f.root)).content[0].text)
  expect(await call('inspect_agent_session', {})).toMatchObject({ sourceDiagnostic: 'PROFILE_UNAVAILABLE' })
  const config = join(dirname(f.store().path), 'session-context.provider.json')
  writeFileSync(config, JSON.stringify({ repositoryId: 'repo', nativeSources: { antigravityApp: { profile } } }))
  expect(await call('inspect_agent_session', {})).toMatchObject({ sourceDiagnostic: 'SOURCE_NOT_FOUND' })
  write(text)
  const map = await call('inspect_agent_session', {})
  expect(map).toMatchObject({ source: 'ANTIGRAVITY_APP_LOCAL_TRANSCRIPT_V1', sourceEventCount: 1, omittedSourceEvents: 1 })
  const eventPage = await call('list_agent_session_events', { expectedRevision: map.revision })
  expect(JSON.stringify(eventPage)).not.toContain('output')
  const select = { eventId: eventPage.events[0].eventId, expectedRevision: map.revision }
  const first = await call('read_agent_session_event', select)
  expect(first).toMatchObject({ sanitized: true, partial: true, payloadDigest: nativeDigest(sanitized) })
  expect(first.nextCursor).toBeDefined()
  f.restart()
  const last = await call('read_agent_session_event', { ...select, cursor: first.nextCursor })
  expect(last).toMatchObject({ complete: true, transcriptImported: false, payloadDigest: first.payloadDigest })
  expect(first.content + last.content).toBe(sanitized)
  expect(f.store().count()).toBe(0)
  write(text + ' updated')
  expect(await call('read_agent_session_event', select)).toEqual({ code: 'REVISION_CONFLICT' })
  const conflicting = normalizeNativeHook(input, { ...binding, worktreeId: '3'.repeat(64) })
  f.store().registry.apply(nativeObservationBatch(conflicting), undefined)
  expect(await call('inspect_agent_session', {})).toEqual({ code: 'ORIGIN_UNVERIFIED' })
}, 60000)

it('U1 verifies all seven native handlers and exact installation without granting trust or changing files', () => {
  const f = fixture()
  expect(inspectNativeInstallation(f.root, f.target)).toMatchObject({ state: 'MISSING', installed: 0 })
  f.install()
  const before = [f.configPath, f.bindingPath, f.snapshotPath].map(path => readFileSync(path, 'utf8'))
  expect(inspectNativeInstallation(f.root, f.target)).toMatchObject({ state: 'CONFIGURED', installed: 7, expected: 7 })
  const value = nativeHookReadiness(f.store().registry, f.root, f.target)
  expect(value).toMatchObject({ schemaVersion: 1, installation: { state: 'CONFIGURED' }, trust: { state: 'UNKNOWN' }, execution: { state: 'UNOBSERVED' } })
  expect(JSON.stringify(value)).not.toContain(f.root)
  expect([f.configPath, f.bindingPath, f.snapshotPath].map(path => readFileSync(path, 'utf8'))).toEqual(before)
  f.change(config => { delete config.hooks.Stop; delete config.hooks.SessionEnd }, true)
  expect(inspectNativeInstallation(f.root, f.target)).toMatchObject({ state: 'INCOMPATIBLE', reasonCode: 'NATIVE_HANDLERS_MISSING', installed: 5 })
})
it('U1 diagnoses drift, stale generation and incompatible Windows commands without repair', () => {
  const f = fixture(); f.install()
  expect(inspectNativeInstallation(f.root, { ...f.target, generation: '3'.repeat(64) })).toMatchObject({ state: 'INCOMPATIBLE', reasonCode: 'WORKTREE_STALE' })
  f.change(config => { config.description = 'external edit' })
  expect(inspectNativeInstallation(f.root, f.target)).toMatchObject({ state: 'INCOMPATIBLE', reasonCode: 'HOOK_CONFIG_DRIFT' })
  f.change(config => { delete config.hooks.SessionStart[0].hooks[0].commandWindows }, true)
  expect(inspectNativeInstallation(f.root, f.target, 'win32')).toMatchObject({ state: 'INCOMPATIBLE', reasonCode: 'WINDOWS_COMMAND_INCOMPATIBLE' })
})
it('U1 keeps observed envelopes historical and isolated by generation after restart', () => {
  const f = fixture(); f.install()
  const binding = readNativeBinding(f.bindingPath)
  const event = normalizeNativeHook({ session_id: 'PRIVATE_SESSION', hook_event_name: 'Stop', cwd: f.root }, binding, new Date('2026-11-01T00:00:00Z'))
  f.store().registry.apply(nativeObservationBatch(event), undefined)
  f.restart()
  const value = nativeHookReadiness(f.store().registry, f.root, f.target)
  expect(value).toMatchObject({ trust: { state: 'UNKNOWN' }, execution: { state: 'OBSERVED', freshness: 'HISTORICAL', observedAt: event.observedAt, sessionId: event.sessionId } })
  expect(JSON.stringify(value)).not.toContain('PRIVATE_SESSION')
  expect(nativeHookReadiness(f.store().registry, f.root, { ...f.target, generation: '3'.repeat(64) }).execution.state).toBe('UNOBSERVED')
})
function clientFixture(f: ReturnType<typeof fixture>) {
  let scope: NativeClientScope | undefined = { ...f.target, workspaceRoot: f.root, projectTrusted: true, clientId: 'private-client', threadId: 'private-thread', sessionId: 'PRIVATE_SESSION', protocolVersion: 'codex-app-server/v2', clientVersion: '0.166.0-alpha.6', connectedAt: new Date(Date.now() - 5000).toISOString() }
  const hooks = inspectNativeInstallation(f.root, f.target).handlers.map(handler => ({ key: handler.key, eventName: handler.event[0].toLowerCase() + handler.event.slice(1),
    currentHash: 'sha256:' + nativeDigest(handler.key), enabled: true, trustStatus: 'trusted', command: 'PRIVATE_COMMAND', sourcePath: f.configPath, displayOrder: 0 }))
  const calls: unknown[] = []
  const client: NativeHookClient = { authorized: true, scope: () => scope, request: async (method, params) => { calls.push({ method, params }); return { data: [{ hooks, errors: [], warnings: [] }] } } }
  return { client, hooks, calls, scope: () => scope!, changeScope: (value: NativeClientScope | undefined) => { scope = value } }
}
it('F1 requires an ingested current window, scoped trust and the current runtime instead of historical completion', async () => {
  const f = fixture(); f.install(); const c = clientFixture(f)
  const binding = readNativeBinding(f.bindingPath)
  const event = stampNativeCapture(normalizeNativeHook({ session_id: c.scope().sessionId, hook_event_name: 'SessionStart', cwd: f.root }, binding), binding)
  spoolNativeHook(event, binding.spool)
  const trust = await inspectNativeTrust(f.root, f.target, true, c.client)
  expect(nativeHookReadiness(f.store().registry, f.root, f.target, trust).captureReadiness.state).toBe('NOT_VERIFIED')
  await ingestNativeHooks(f.store().registry, binding, async () => ({ root: f.root, fingerprint: '', validate: async () => {} }), () => {})
  expect(nativeHookReadiness(f.store().registry, f.root, f.target).captureReadiness.state).toBe('NOT_VERIFIED')
  expect(nativeHookReadiness(f.store().registry, f.root, f.target, trust).captureReadiness).toEqual({ state: 'OBSERVED', reasonCode: 'CURRENT_WINDOW_INGESTED' })
  expect(nativeHookReadiness(f.store().registry, f.root, f.target, { ...trust, sessionId: '4'.repeat(64) }).captureReadiness.state).toBe('NOT_VERIFIED')
  const source = `NATIVE_CURRENT:${binding.worktreeId}:${binding.generation}`, previous = f.store().registry.source(source)!
  const current = JSON.parse(previous.cursor!)
  expect(current.runtimeId).toBe(nativeCaptureRuntimeId)
  f.store().registry.apply({ repositoryId: 'repo', source, revision: 'restarted', status: 'OBSERVED', cursor: JSON.stringify({ ...current, runtimeId: 'previous-runtime' }), edges: [] }, previous.revision)
  expect(nativeHookReadiness(f.store().registry, f.root, f.target, trust)).toMatchObject({ execution: { freshness: 'HISTORICAL' }, captureReadiness: { state: 'NOT_VERIFIED' } })
  f.store().registry.apply({ repositoryId: 'repo', source, revision: 'current', status: 'OBSERVED', cursor: JSON.stringify(current), edges: [] }, 'restarted')
  recordNativeGap(binding.spool, 'SPOOL_FULL')
  expect(nativeHookReadiness(f.store().registry, f.root, f.target, trust).captureReadiness).toMatchObject({ state: 'PARTIAL' })
})
it('U2 inspects only an authorized same-context client on demand and emits a compact hash-scoped snapshot', async () => {
  const f = fixture(); f.install(); const c = clientFixture(f)
  const before = readFileSync(f.configPath, 'utf8')
  expect(await inspectNativeTrust(f.root, f.target, false, c.client)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'TRUST_NOT_INSPECTED' })
  expect(c.calls).toEqual([])
  const trust = await inspectNativeTrust(f.root, f.target, true, c.client)
  expect(trust).toMatchObject({ state: 'TRUSTED', trusted: 7, matched: 7, freshness: 'OBSERVED_SNAPSHOT', protocolVersion: 'codex-app-server/v2' })
  expect(c.calls).toEqual([{ method: 'hooks/list', params: { threadId: 'private-thread' } }])
  const text = JSON.stringify(trust)
  for (const privateText of [f.root, 'PRIVATE_COMMAND', 'PRIVATE_SESSION', 'private-client', 'private-thread', c.hooks[0].currentHash]) expect(text).not.toContain(privateText)
  expect(readFileSync(f.configPath, 'utf8')).toBe(before)
  expect(nativeHookReadiness(f.store().registry, f.root, f.target, trust).execution.state).toBe('UNOBSERVED')
  f.restart()
  expect(nativeHookReadiness(f.store().registry, f.root, f.target).trust.state).toBe('UNKNOWN')
})
it('U2 distinguishes untrusted, changed hash, missing/ambiguous hooks, unsupported protocol and absent authorization', async () => {
  const f = fixture(); f.install(); const c = clientFixture(f)
  c.hooks[0].trustStatus = 'untrusted'
  expect(await inspectNativeTrust(f.root, f.target, true, c.client)).toMatchObject({ state: 'PARTIAL', trusted: 6, issues: [{ eventType: 'SessionStart', reasonCode: 'HOOK_UNTRUSTED' }] })
  c.hooks[0].trustStatus = 'modified'; c.hooks[0].currentHash = 'sha256:' + 'a'.repeat(64)
  expect(await inspectNativeTrust(f.root, f.target, true, c.client)).toMatchObject({ state: 'PARTIAL', reasonCode: 'HOOK_HASH_CHANGED', freshness: 'STALE' })
  c.hooks.forEach(hook => { hook.trustStatus = 'untrusted' })
  expect(await inspectNativeTrust(f.root, f.target, true, c.client)).toMatchObject({ state: 'UNTRUSTED' })
  const expected = inspectNativeInstallation(f.root, f.target).handlers
  expect(summarizeHookList({ data: [{ hooks: [...c.hooks, c.hooks[0]] }] }, expected)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'HOOK_SCOPE_AMBIGUOUS' })
  expect(summarizeHookList({ data: [{ hooks: c.hooks.slice(1) }] }, expected)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'HOOK_SCOPE_UNAVAILABLE' })
  c.client.authorized = false; c.calls.length = 0
  expect(await inspectNativeTrust(f.root, f.target, true, c.client)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'CLIENT_AUTHORIZATION_REQUIRED' })
  expect(c.calls).toEqual([])
  c.client.authorized = true
  const qualified = c.scope()
  c.changeScope({ ...qualified, clientVersion: '0.169.0-alpha.11.1' })
  expect(await inspectNativeTrust(f.root, f.target, true, c.client)).toMatchObject({ state: 'UNTRUSTED', clientVersion: '0.169.0-alpha.11.1' })
  c.calls.length = 0
  c.changeScope({ ...qualified, projectTrusted: false })
  expect(await inspectNativeTrust(f.root, f.target, true, c.client)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'PROJECT_TRUST_UNAVAILABLE' })
  c.changeScope({ ...qualified, clientVersion: '0.169.0-alpha.99' })
  expect(await inspectNativeTrust(f.root, f.target, true, c.client)).toMatchObject({ state: 'UNSUPPORTED', reasonCode: 'VERSION_UNSUPPORTED' })
  expect(c.calls).toEqual([])
  c.changeScope(qualified)
  c.client.request = async () => { throw Object.assign(new Error('PRIVATE_FAILURE'), { code: -32601 }) }
  expect(await inspectNativeTrust(f.root, f.target, true, c.client)).toMatchObject({ state: 'UNSUPPORTED', reasonCode: 'PROTOCOL_UNSUPPORTED' })
  expect(await inspectNativeTrust(f.root, f.target, true)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'SESSION_SCOPE_UNAVAILABLE' })
})
it('U2 discards in-flight evidence when session, installation or cancellation changes', async () => {
  const f = fixture(); f.install(); const c = clientFixture(f)
  const request = c.client.request
  c.client.request = async (...args) => { const response = await request(...args); c.changeScope({ ...c.scope(), sessionId: 'other-session' }); return response }
  expect(await inspectNativeTrust(f.root, f.target, true, c.client)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'SESSION_SCOPE_CHANGED' })
  c.client.request = async (...args) => { const response = await request(...args); f.change(config => { config.description = 'hash changed' }); return response }
  expect(await inspectNativeTrust(f.root, f.target, true, c.client)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'HOOK_CONFIG_DRIFT' })
  f.change(() => {}, true)
  let active = true
  c.client.request = async (...args) => { const response = await request(...args); active = false; return response }
  await expect(inspectNativeTrust(f.root, f.target, true, c.client, () => { if (!active) throw new Error('PROJECT_CONTEXT_CHANGED') })).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
})
it('U3 distinguishes completed and failed native runs, retains no raw payload and never treats inspection as execution', async () => {
  const f = fixture(); f.install(); const c = clientFixture(f)
  const now = Math.floor(Date.now() / 1000)
  const notification = { threadId: c.scope().threadId, run: { id: 'PRIVATE_RUN', handlerType: 'command', eventName: 'sessionStart', sourcePath: f.configPath, displayOrder: 0,
    status: 'completed', startedAt: now, completedAt: now, entries: [{ text: 'PRIVATE_OUTPUT' }], command: 'PRIVATE_COMMAND' } }
  c.client.readCompletions = () => []
  expect(nativeHookReadiness(f.store().registry, f.root, f.target, await inspectNativeTrust(f.root, f.target, true, c.client))).toMatchObject({ execution: { state: 'UNOBSERVED' }, nextEvidence: 'OBSERVE_REAL_WORKFLOW_WITH_CONSENT' })
  c.client.readCompletions = () => [notification]
  const observed = nativeHookReadiness(f.store().registry, f.root, f.target, await inspectNativeTrust(f.root, f.target, true, c.client))
  expect(observed).toMatchObject({ trust: { state: 'TRUSTED' }, execution: { state: 'OBSERVED', reasonCode: 'HOOK_COMPLETED', eventType: 'SessionStart', freshness: 'OBSERVED_SNAPSHOT' } })
  const replay = nativeHookReadiness(f.store().registry, f.root, f.target, await inspectNativeTrust(f.root, f.target, true, c.client))
  expect(replay.execution).toEqual(observed.execution)
  notification.run.status = 'failed'
  const failed = nativeHookReadiness(f.store().registry, f.root, f.target, await inspectNativeTrust(f.root, f.target, true, c.client))
  expect(failed).toMatchObject({ execution: { state: 'FAILED', reasonCode: 'HOOK_EXECUTION_FAILED' }, nextEvidence: 'INSPECT_FAILED_EVENT_READ_ONLY' })
  for (const secret of ['PRIVATE_OUTPUT','PRIVATE_COMMAND','PRIVATE_RUN', f.root]) expect(JSON.stringify(failed)).not.toContain(secret)
  expect(f.store().registry.sources()).toEqual([])
})
it('U3 isolates two sessions and Worktrees, rejects other handlers, and does not promote evidence after restart or expiry', async () => {
  const f = fixture(); f.install(); const c = clientFixture(f)
  const now = Math.floor(Date.now() / 1000), run = { id: 'run', handlerType: 'command', eventName: 'stop', sourcePath: f.configPath, displayOrder: 0, status: 'completed', startedAt: now, completedAt: now }
  const originalThread = c.scope().threadId
  c.client.readCompletions = () => [{ threadId: 'other-thread', run }, { threadId: originalThread, run: { ...run, sourcePath: 'another-handler' } }]
  let trust = await inspectNativeTrust(f.root, f.target, true, c.client)
  expect(nativeHookReadiness(f.store().registry, f.root, f.target, trust).execution.state).toBe('UNOBSERVED')
  expect(await inspectNativeTrust(f.root, { ...f.target, worktreeId: '4'.repeat(64) }, true, c.client)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'SESSION_SCOPE_UNAVAILABLE' })
  c.client.readCompletions = () => [{ threadId: originalThread, run }]
  c.changeScope({ ...c.scope(), threadId: 'new-thread', sessionId: 'new-session' })
  expect(nativeHookReadiness(f.store().registry, f.root, f.target, await inspectNativeTrust(f.root, f.target, true, c.client)).execution.state).toBe('UNOBSERVED')
  c.changeScope({ ...c.scope(), threadId: originalThread, clientId: 'restarted-client', connectedAt: new Date().toISOString() })
  expect(nativeHookReadiness(f.store().registry, f.root, f.target, await inspectNativeTrust(f.root, f.target, true, c.client)).execution.state).toBe('UNOBSERVED')
  expect(nativeHookReadiness(f.store().registry, f.root, f.target, { ...trust, expiresAt: new Date(Date.now() - 1).toISOString() }).trust).toMatchObject({ state: 'UNKNOWN', reasonCode: 'TRUST_EXPIRED' })
  f.restart()
  expect(nativeHookReadiness(f.store().registry, f.root, f.target)).toMatchObject({ trust: { state: 'UNKNOWN' }, execution: { state: 'UNOBSERVED' } })
})
it('U3 retains legacy coverage as historical UNKNOWN rather than inventing a current event', () => {
  const f = fixture(); f.install()
  f.store().registry.apply({ repositoryId: 'repo', source: `NATIVE_CAPTURE:${f.target.worktreeId}:${f.target.generation}`, revision: 'legacy', status: 'OBSERVED', edges: [] }, undefined)
  expect(nativeHookReadiness(f.store().registry, f.root, f.target)).toMatchObject({ execution: { state: 'UNKNOWN', reasonCode: 'EVENT_DETAIL_UNAVAILABLE', freshness: 'HISTORICAL' } })
})

it('investigates native hook observations by provider and generation without inferring a transcript', async () => {
  const f = fixture()
  f.install()
  const binding = readNativeBinding(f.bindingPath)
  const first = normalizeNativeHook({ session_id: 'selected-private-id', cwd: f.root, hook_event_name: 'SessionStart' }, binding)
  const last = normalizeNativeHook({ session_id: 'selected-private-id', cwd: f.root, hook_event_name: 'Stop' }, binding)
  for (const event of [first, last]) f.store().registry.apply(nativeObservationBatch(event), undefined)
  const channel = new ChannelMcpAdapter({ projectId: 'fixture', repoRoot: f.root, navigation: {} as never,
    continuum: { repositoryId: f.target.repositoryId } as never,
    sessionContext: { call: (name, args) => executeSessionTool(f.store(), {}, name, args, () => {}) } })
  const call = async (name: Parameters<typeof executeSessionTool>[2], args: unknown) => {
    const [result] = (await channel.callTool(name, args)).content
    if (result?.type !== 'text') throw new Error('MCP_TEXT_RESULT_REQUIRED')
    return JSON.parse(result.text)
  }
  const listed = await call('list_agent_sessions', { source: 'NATIVE_HOOK' })
  const selected = listed.sessions[0].deepen.arguments
  expect(selected.repositoryId).toBe(f.target.repositoryId)
  expect(selected.nativeSession).toEqual({ provider: 'codex-native', id: first.sessionId })
  const map = await call('inspect_agent_session', selected)
  expect(map).toMatchObject({ observedEventCount: 2, transcriptImported: false, identityEvidence: 'NATIVE_HASH_OBSERVED', contentAvailability: 'SOURCE_UNAVAILABLE' })
  expect(JSON.stringify(map)).not.toContain('selected-private-id')
  const args = { ...selected, expectedRevision: map.revision, limit: 1 }
  const page = await call('list_agent_session_events', args)
  const following = await call('list_agent_session_events', { ...args, cursor: page.nextCursor })
  expect([page.events[0].eventId, following.events[0].eventId].sort()).toEqual([first.eventId, last.eventId].sort())
  expect(await call('list_agent_session_events', { ...args, hookEvents: ['Stop'], cursor: page.nextCursor })).toMatchObject({ code: expect.stringMatching(/^CURSOR_/) })
  expect(await call('inspect_agent_session', { nativeSession: { ...selected.nativeSession, provider: 'antigravity-native' } })).toEqual({ code: 'SESSION_UNAVAILABLE' })
  expect(await call('inspect_agent_session', { nativeSession: { ...selected.nativeSession, worktreeId: f.target.worktreeId, generation: '3'.repeat(64) } })).toEqual({ code: 'ORIGIN_UNVERIFIED' })
  expect(await call('read_agent_session_event', { ...selected, expectedRevision: map.revision, eventId: first.eventId })).toEqual({ code: 'SOURCE_UNAVAILABLE' })
  f.restart()
  expect(await call('inspect_agent_session', { ...selected, expectedRevision: map.revision })).toMatchObject({ revision: map.revision, observedEventCount: 2 })
})

it('revalidates an authorized Codex transcript and exposes only its selected literal field', async () => {
  const f = fixture()
  f.install()
  const providerId = '01a1dff8-0000-7000-8000-000000000001'
  const event = normalizeNativeHook({ session_id: providerId, cwd: f.root, hook_event_name: 'SessionEnd' }, readNativeBinding(f.bindingPath))
  const store = f.store()
  store.registry.apply(nativeObservationBatch(event), undefined)
  const profile = join(f.root, 'provider-profile')
  const directory = join(profile, 'sessions', '2026', '11', '15')
  mkdirSync(directory, { recursive: true })
  const rollout = join(directory, 'rollout-pilot-' + providerId + '.jsonl')
  const config = join(dirname(store.path), 'session-context.provider.json')
  const grant = (creatorAccountHash = nativeDigest(JSON.stringify(['pilot-user', 'pilot-account']))) =>
    writeFileSync(config, JSON.stringify({ repositoryId: store.repositoryId, nativeSources: { codex: { profile, creatorAccountHash } } }))
  const content = 'Exact literal 🧪 "sample"\n'.repeat(600)
  const rows = [{ type: 'session_meta', payload: { id: providerId, session_id: providerId, account_scoped: true, creator_user_id: 'pilot-user',
    creator_account_id: 'pilot-account', cwd: f.root, runtime_workspace_roots: [f.root], cli_version: '0.169.0-alpha.11.1' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'output_text', text: 'PRIVATE_INSTRUCTIONS' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] } }]
  const write = () => writeFileSync(rollout, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  write()
  const nativeSession = { provider: 'codex-native', id: event.sessionId, worktreeId: f.target.worktreeId, generation: f.target.generation }
  const args = { nativeSession, sourceSessionId: providerId }
  const call = async (name: Parameters<typeof executeSessionTool>[2], input: unknown, target = f.target) =>
    JSON.parse((await executeSessionTool(store, {}, name, input, () => {}, target, [], undefined, f.root)).content[0].text)
  expect(await call('inspect_agent_session', args)).toEqual({ code: 'SOURCE_NOT_AUTHORIZED' })
  grant('9'.repeat(64))
  expect(await call('inspect_agent_session', args)).toEqual({ code: 'SOURCE_IDENTITY_CONFLICT' })
  grant()
  const map = await call('inspect_agent_session', args)
  expect(map).toMatchObject({ source: 'CODEX_LOCAL_TRANSCRIPT_V1', sourceEventCount: 1, identityEvidence: 'HASH_AND_PROVIDER_HEADER_VERIFIED' })
  const events = await call('list_agent_session_events', { ...args, expectedRevision: map.revision })
  expect(JSON.stringify(events)).not.toContain('Exact literal')
  expect(JSON.stringify(events)).not.toContain('PRIVATE_INSTRUCTIONS')
  let cursor: string | undefined, reconstructed = ''
  do {
    const page = await call('read_agent_session_event', { ...args, expectedRevision: map.revision, eventId: events.events[0].eventId, cursor })
    expect(page).toMatchObject({ payloadDigest: nativeDigest(content), transcriptImported: false, untrusted: true })
    reconstructed += page.content
    cursor = page.nextCursor
  } while (cursor)
  expect(reconstructed).toBe(content)
  expect(store.count()).toBe(0)
  rows[0].payload.runtime_workspace_roots!.push(profile)
  write()
  expect(await call('inspect_agent_session', args)).toEqual({ code: 'ORIGIN_UNVERIFIED' })
  rows[0].payload.runtime_workspace_roots!.pop()
  write()
  expect(await call('inspect_agent_session', { ...args, expectedRevision: map.revision })).toEqual({ code: 'REVISION_CONFLICT' })
}, 60000)

it('sends only host-observed trust through the real worker and rejects a changed session at readback', async () => {
  const f = fixture()
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: f.root, windowsHide: true, stdio: 'pipe' })
  git('init', '-b', 'test')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture')
  f.install()
  const live = clientFixture(f)
  const worker = join(f.root, 'worker.cjs')
  const code = buildSync({ entryPoints: ['src/main/session-context/worker.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  writeFileSync(worker, 'require = require("node:module").createRequire(' + JSON.stringify(resolve('package.json')) + ');\n' + code)
  let changeAtReadback = false
  const validate = vi.fn(async () => {
    if (changeAtReadback && validate.mock.calls.length > 1) live.changeScope({ ...live.scope(), threadId: 'other-thread' })
  })
  const target: SessionTargetResolver = async () => ({ root: f.root, fingerprint: sourceFingerprint(f.root), validate })
  const client = new SessionContextClient(f.root, 'repo', f.root, () => true, worker, target, 20000, undefined, undefined, undefined, live.client)
  try {
    const query = { source: 'native', worktreeId: f.target.worktreeId, generation: f.target.generation, inspectNativeTrust: true }
    const result = await client.call('inspect_capture_health', query)
    expect(result.isError, result.content[0].text).toBeFalsy()
    expect(JSON.parse(result.content[0].text)).toMatchObject({ source: 'native', state: 'CONFIGURED', nativeCapture: {
      discovery: { state: 'OBSERVED', loadedSource: 'WORKTREE' },
      readiness: { installation: { installed: 7 }, trust: { state: 'TRUSTED', trusted: 7 }, captureReadiness: { state: 'NOT_VERIFIED' } }
    } })
    expect(result.content[0].text).not.toContain('private-thread')
    expect(result.content[0].text).not.toContain('PRIVATE_COMMAND')
    validate.mockClear()
    changeAtReadback = true
    const changed = await client.call('inspect_capture_health', query)
    expect(changed.isError).toBe(true)
    expect(JSON.parse(changed.content[0].text)).toMatchObject({ code: 'SESSION_SCOPE_CHANGED' })
  } finally { await client.dispose() }
}, 60000)

it('Antigravity ingests ANTIGRAVITY_NATIVE_HOOK envelopes, exposes readiness and serves MCP context without fake causal edges', async () => {
  const f = fixture()
  const commandPath = join(f.root, 'native-hook.cjs')
  const record = { path: f.root, ...f.target, branch: 'test', head: 'a'.repeat(40), detached: false, locked: false, missing: false, prunable: false }
  installNativeHooks({ repositoryId: 'repo', record, commandPath, nodePath: process.execPath, provider: 'antigravity', authorized: true })
  const binding = readNativeBinding(join(f.root, '.code-awareness/native-hooks/antigravity/binding.json'))

  for (const payload of [
    { conversationId: 'PRIVATE_AG_CONV', workspacePaths: [f.root], hookEventName: 'SessionStart', lastUserInput: 'PRIVATE_PROMPT' },
    { conversationId: 'PRIVATE_AG_CONV', workspacePaths: [f.root], hookEventName: 'PreToolUse', toolCall: { id: 'call-ag-1', name: 'run_command', args: { CommandLine: 'PRIVATE_CMD' } } },
    { conversationId: 'PRIVATE_AG_CONV', workspacePaths: [f.root], hookEventName: 'PostToolUse', toolCall: { id: 'call-ag-1', name: 'run_command', args: { CommandLine: 'PRIVATE_CMD' } } }
  ]) {
    spoolNativeHook(stampNativeCapture(normalizeNativeHook(payload, binding), binding), binding.spool)
  }

  await ingestNativeHooks(f.store().registry, binding, async () => ({ root: f.root, fingerprint: '', validate: async () => {} }), () => {})
  f.restart()

  const readiness = nativeHookReadiness(f.store().registry, f.root, f.target, unknownNativeTrust('CLIENT_TRUST_UNSUPPORTED'), 'antigravity')
  expect(readiness).toMatchObject({
    installation: { state: 'CONFIGURED', installed: 6, expected: 6 },
    execution: { state: 'OBSERVED', eventType: 'PostToolUse' },
    captureReadiness: { state: 'OBSERVED', reasonCode: 'CURRENT_WINDOW_INGESTED' }
  })
  expect(JSON.stringify(readiness)).not.toContain('PRIVATE_AG_CONV')

  const provider = { refresh: async () => ({}) }
  const listed = JSON.parse((await executeSessionTool(f.store(), provider, 'list_agent_sessions', { source: 'NATIVE_HOOK', limit: 10 }, () => {}, f.target, [], undefined, f.root)).content[0].text)
  expect(listed.sessions).toHaveLength(1)
  expect(listed.sessions[0]).toMatchObject({ provider: 'antigravity-native', agent: 'antigravity', origin: 'NATIVE_HOOK' })

  const context = JSON.parse((await executeSessionTool(f.store(), provider, 'discover_execution_context', { selector: { type: 'SESSION', provider: 'antigravity-native', id: listed.sessions[0].providerSessionId } }, () => {}, f.target, [], undefined, f.root)).content[0].text)
  expect(context.counts).toMatchObject({ SESSION: 1, WORKTREE: 1 })
  expect(context.counts.EXECUTION).toBeGreaterThanOrEqual(3)
  expect(context.edges.every((edge: { evidenceKind: string }) => !edge.evidenceKind.startsWith('NATIVE_GIT_') && !edge.evidenceKind.startsWith('NATIVE_ARTIFACT_'))).toBe(true)
}, 30000)

it('diagnoses only the selected Antigravity IDE source and never reads an unqualified transcript', () => {
  const f = fixture()
  const store = f.store()
  const id = '019ba000-0000-7000-8000-000000000001'
  const hash = nativeDigest(JSON.stringify([store.repositoryId, 'antigravity', id]))
  const profile = join(f.root, 'ide-profile')
  const config = join(dirname(store.path), 'session-context.provider.json')
  const diagnose = (assertCurrent = () => {}) => antigravitySourceDiagnostic(store.path, store.repositoryId, hash, id, assertCurrent)
  expect(diagnose()).toBe('PROFILE_UNAVAILABLE')
  mkdirSync(profile)
  writeFileSync(config, JSON.stringify({ repositoryId: store.repositoryId, nativeSources: { antigravityIde: { profile } } }))
  expect(antigravitySourceDiagnostic(store.path, store.repositoryId, '0'.repeat(64), id, () => {})).toBe('IDENTITY_MISMATCH')
  expect(diagnose()).toBe('SOURCE_NOT_FOUND')
  const path = join(profile, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'synthetic format sentinel')
  expect(diagnose()).toBe('FORMAT_UNSUPPORTED')
  expect(diagnose(() => writeFileSync(path, 'source changed'))).toBe('SOURCE_STALE')
}, 20000)
