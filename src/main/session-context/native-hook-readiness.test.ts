import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { installNativeHooks, inspectNativeInstallation } from './native-hook-installation'
import { nativeCaptureRuntimeId, nativeDigest, normalizeNativeHook, readNativeBinding, spoolNativeHook, recordNativeGap } from './native-hooks'
import { nativeObservationBatch } from './native-hook-ingestion'
import { SessionStore, sessionStorePath } from './store'
import { nativeHookReadiness } from './native-hook-readiness'
import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { SessionContextClient } from './client'
import { sourceFingerprint, type SessionTargetResolver } from './target'
import { inspectNativeTrust, type NativeHookClient, type NativeClientScope } from './native-hook-preflight'
import { summarizeHookList } from '../../shared/native-hook-preflight.cjs'
import { stampNativeCapture } from './native-capture-window'
import { ingestNativeHooks } from './native-hook-ingestion'

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
    const query = { worktreeId: f.target.worktreeId, generation: f.target.generation, inspectNativeTrust: true }
    const result = await client.call('inspect_capture_health', query)
    expect(result.isError, result.content[0].text).toBeFalsy()
    expect(JSON.parse(result.content[0].text).nativeCapture.readiness).toMatchObject({
      installation: { installed: 7 }, trust: { state: 'TRUSTED', trusted: 7 }, captureReadiness: { state: 'NOT_VERIFIED' }
    })
    expect(result.content[0].text).not.toContain('private-thread')
    expect(result.content[0].text).not.toContain('PRIVATE_COMMAND')
    validate.mockClear()
    changeAtReadback = true
    const changed = await client.call('inspect_capture_health', query)
    expect(changed.isError).toBe(true)
    expect(JSON.parse(changed.content[0].text)).toMatchObject({ code: 'SESSION_SCOPE_CHANGED' })
  } finally { await client.dispose() }
}, 60000)
