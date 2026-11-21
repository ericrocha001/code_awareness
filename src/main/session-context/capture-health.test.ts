import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { SessionStore, sessionStorePath } from './store'
import { EntireProvider, runReadOnly, type CommandRunner } from './entire-provider'
import { inspectCaptureHealth, captureHealthQuery } from './capture-health'
import { observeCheckpoint } from './checkpoint-observation'
import { digest } from './privacy'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import type { McpProjectContext } from '../mcp/project-mcp-context'
import { executeSessionTool } from './mcp'
import { nativeBindingPath, normalizeNativeHook, readNativeBinding, recordNativeGap, spoolNativeHook, type NativeHookProvider } from './native-hooks'
import { ingestNativeHooks } from './native-hook-ingestion'
import { installNativeHooks } from './native-hook-installation'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
it('defaults to bounded Codex health and selects the Antigravity IDE without probing incompatible Entire hooks', async () => {
  const f = fixture()
  const codex = installFixture(f, 'codex'), antigravity = installFixture(f, 'antigravity')
  const { spool } = codex
  const postCommit = join(f.hooks, 'post-commit')
  writeFileSync(postCommit, 'incompatible fixture\n')
  writeFileSync(join(spool, 'gap.json'), JSON.stringify({ schema: 1, observedAt: '2026-01-01T00:00:00.000Z' }))
  for (let i = 0; i < 33; i++) recordNativeGap(spool, 'INVOCATION_ID_MISSING', 'NORMALIZE', 'PreToolUse')
  spoolNativeHook(normalizeNativeHook({ session_id: 'private-native-session', cwd: f.root, hook_event_name: 'Stop' }, codex), spool)
  await ingestNativeHooks(f.store().registry, codex, async () => ({ root: f.root, fingerprint: '', validate: async () => {} }), () => {})
  const inspectCapture = vi.fn(() => { throw new Error('ENTIRE_SHOULD_NOT_RUN') })
  const run = vi.fn<CommandRunner>(() => { throw new Error('GIT_HOOK_INSPECTION_SHOULD_NOT_RUN') })
  const watched = [postCommit, join(f.root, '.entire/settings.local.json'), join(f.root, '.codex/hooks.json'), join(f.root, '.agents/hooks.json'), join(spool, 'gap.json')]
  const before = watched.map(path => readFileSync(path, 'utf8'))
  const adapter = new ChannelMcpAdapter({ projectId: 'A', repoRoot: f.root, navigation: {} as McpProjectContext['navigation'],
    sessionContext: { call: (name, args) => executeSessionTool(f.store(), { inspectCapture }, name, args, () => {}, f.target, [], run, f.root) } })
  const result = await adapter.callTool('get_system_health', { feature: 'session_context', refresh: true })
  expect(result.isError).toBeFalsy()
  const text = (result.content[0] as { text: string }).text
  expect(JSON.parse(text)).toMatchObject({ feature: 'session_context', source: 'native', version: 1, agent: 'codex', repositoryId: 'A', ...f.target,
    state: 'PARTIAL', nativeCapture: { independentOfEntire: true, causality: 'NOT_EVALUATED',
      lastIngestion: { state: 'OBSERVED' }, historicalCoverage: { state: 'PARTIAL', count: 34, countCoverage: 'LOWER_BOUND', acknowledgedCount: 0, omittedDiagnostics: 31 },
      readiness: { installation: { state: 'CONFIGURED', installed: 7 }, captureReadiness: { state: 'NOT_VERIFIED', reasonCode: 'CURRENT_CAPTURE_UNPROVEN' } } } })
  expect(JSON.parse(text).nativeCapture.historicalCoverage.diagnostics).toHaveLength(3)
  expect(Buffer.byteLength(text)).toBeLessThan(8192)
  expect(text).not.toContain('private-native-session'); expect(text).not.toContain(f.root)
  const readiness = JSON.parse(text).nativeCapture.readiness
  expect(readiness).toMatchObject({ schemaVersion: 1, trust: { state: 'UNKNOWN', reasonCode: 'TRUST_NOT_INSPECTED' }, execution: { state: 'OBSERVED', freshness: 'HISTORICAL' } })
  const explicit = await adapter.callTool('get_system_health', { feature: 'session_context', inspectNativeTrust: true })
  expect(explicit.isError).toBeFalsy()
  expect(JSON.parse((explicit.content[0] as { text: string }).text).nativeCapture.readiness.trust).toMatchObject({ state: 'UNKNOWN', reasonCode: 'SESSION_SCOPE_UNAVAILABLE' })
  const ide = await adapter.callTool('get_system_health', { feature: 'session_context', source: 'native', agent: 'antigravity', inspectNativeTrust: true })
  expect(JSON.parse((ide.content[0] as { text: string }).text)).toMatchObject({ source: 'native', agent: 'antigravity', state: 'CONFIGURED',
    nativeCapture: { source: 'ANTIGRAVITY_NATIVE_HOOK', readiness: { installation: { installed: 6 }, trust: { state: 'UNSUPPORTED' }, execution: { state: 'UNOBSERVED' } } } })
  expect(JSON.parse((ide.content[0] as { text: string }).text).nativeCapture.historicalCoverage).toBeUndefined()
  expect(antigravity.spool).not.toBe(spool)
  expect(inspectCapture).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(f.store().captureHealth(f.target, 'worktree')).toBeUndefined()
  expect(watched.map(path => readFileSync(path, 'utf8'))).toEqual(before)
}, 20000)
function fixture(repositoryId = 'A', version = '0.12.2') {
  const base = mkdtempSync(join(tmpdir(), 'capture-health-')), root = join(base, 'repo'), disabled = join(base, 'disabled'), hooks = join(base, 'hooks')
  mkdirSync(root); mkdirSync(disabled); mkdirSync(hooks)
  cleanup.push(() => {
    const target = realpathSync(base)
    if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith('capture-health-')) throw new Error('UNSAFE_FIXTURE_PATH')
    if (process.platform === 'win32') {
      execFileSync('node', ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })", target], { windowsHide: true })
    } else rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + disabled,
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, '.gitignore'), '.entire/\n.codex/\n.code-awareness/\n')
  writeFileSync(join(root, 'file.txt'), 'fixture')
  git('add', '.'); git('commit', '-q', '-m', 'fixture baseline')
  execFileSync('git', ['config', 'core.hooksPath', hooks], { cwd: root, windowsHide: true })
  for (const hook of ['prepare-commit-msg', 'post-commit']) writeFileSync(join(hooks, hook), '#!/bin/sh\nentire hooks git ' + hook + ' "$@"\n')
  mkdirSync(join(root, '.codex')); mkdirSync(join(root, '.entire'))
  writeFileSync(join(root, '.codex/hooks.json'), JSON.stringify({ hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit'].map(event => [event, [{ hooks: [{ type: 'command', command: 'entire hooks codex ' + (event === 'SessionStart' ? 'session-start' : 'user-prompt-submit') }] }]])) }))
  writeFileSync(join(root, '.entire/settings.local.json'), JSON.stringify({ enabled: true, telemetry: false, strategy_options: { push_sessions: false } }))
  const path = sessionStorePath(base, repositoryId)
  let store = new SessionStore(path, repositoryId); cleanup.push(() => store.close())
  const executable = join(base, process.platform === 'win32' ? 'entire.exe' : 'entire')
  writeFileSync(executable, 'pinned fixture')
  writeFileSync(join(dirname(path), 'session-context.provider.json'), JSON.stringify({ enabled: true, repositoryId, executable, sha256: digest('pinned fixture'), version }))
  let mode = 'observed', active = true, entireCalls = 0
  const assert = () => { if (!active) throw new Error('PROJECT_CONTEXT_CHANGED') }
  const run: CommandRunner = async (exe, args, cwd, limit, consume, timeout, signal) => {
    if (exe === 'git') {
      if (mode === 'remote' && args.includes('reflog')) return { code: 0, text: git('rev-parse', 'HEAD') + '\0pull: fast-forward', limited: false }
      return runReadOnly(exe, args, cwd, limit, consume, timeout, signal)
    }
    entireCalls++
    if (mode === 'timeout') return { code: -1, text: '', timedOut: true, limited: false }
    if (args[0] === 'agent') return { code: 0, text: 'Agents:\n  ✓ codex\n  ✓ antigravity\n    claude-code\n', limited: false }
    if (args[0] === 'version') return { code: 0, text: 'Entire CLI ' + version, limited: false }
    if (args.includes('--help')) return { code: 0, text: '--json --transcript', limited: false }
    if (mode === 'cancel') active = false
    return { code: 0, limited: false, text: JSON.stringify(args[1] === 'current'
      ? { resolution: mode === 'unobserved' ? 'worktree' : 'caller-env', session: { session_id: 'captured-session' } }
      : { session_id: 'captured-session', agent: 'Codex', status: 'active', worktree_path: cwd, turns: ['empty', 'pending'].includes(mode) ? 0 : 1, pending_turns: mode === 'pending' ? 1 : 0,
        last_prompt: 'PRIVATE_PROMPT', transcript: 'PRIVATE_TRANSCRIPT' }) }
  }
  const target = { worktreeId: 'a'.repeat(64), generation: 'b'.repeat(64) }
  const inspect = (query: Record<string, unknown> = {}) => inspectCaptureHealth(store, new EntireProvider(store, root, assert, run), run, root, target, captureHealthQuery.parse(query), assert) as Promise<any>
  return { base, root, hooks, git, target, run, inspect, store: () => store, calls: () => entireCalls, mode: (value: string) => { mode = value },
    restart: () => { store.close(); store = new SessionStore(path, repositoryId) } }
}
function installFixture(f: ReturnType<typeof fixture>, provider: NativeHookProvider) {
  const commandPath = join(f.root, 'native-hook.cjs')
  writeFileSync(commandPath, '')
  installNativeHooks({ repositoryId: f.store().repositoryId, record: { path: f.root, ...f.target,
    branch: 'main', head: f.git('rev-parse', 'HEAD'), detached: false, locked: false, missing: false, prunable: false },
    commandPath, nodePath: process.execPath, provider, authorized: true })
  return readNativeBinding(nativeBindingPath(f.root, provider))
}
function checkpoint(f: ReturnType<typeof fixture>, id: string) {
  const blob = (text: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.root, input: text, encoding: 'utf8', windowsHide: true }).trim()
  const tree = (text: string) => execFileSync('git', ['mktree'], { cwd: f.root, input: text, encoding: 'utf8', windowsHide: true }).trim()
  const session = (session_id: string) => tree('100644 blob ' + blob(JSON.stringify({ session_id, agent: 'codex', checkpoint_id: id, cli_version: '0.12.2' })) + '\tmetadata.json\n')
  const top = blob(JSON.stringify({ checkpoint_id: id, cli_version: '0.12.2', sessions: [{}, {}] }))
  const revision = tree('040000 tree ' + session('captured-session') + '\t0\n040000 tree ' + session('second-session') + '\t1\n100644 blob ' + top + '\tmetadata.json\n')
  f.git('update-ref', 'refs/entire/checkpoints/' + id.slice(-2) + '/' + id, revision)
  return revision
}
it('projects a verified local commit from Capture Health into the same registry without importing sessions', async () => {
  const f = fixture(), checkpointId = '0123456789abcdef'
  await f.inspect({ trigger: 'BEGIN' })
  checkpoint(f, checkpointId)
  writeFileSync(join(f.root, 'file.txt'), 'legitimate fixture change')
  f.git('add', 'file.txt'); f.git('commit', '-q', '-m', 'fixture composed\n\nEntire-Checkpoint: ' + checkpointId)
  const commitSha = f.git('rev-parse', 'HEAD')
  const result = await executeSessionTool(f.store(), new EntireProvider(f.store(), f.root, () => {}, f.run), 'inspect_capture_health', { trigger: 'LOCAL_COMMIT', commitSha }, () => {}, f.target, [], f.run, f.root)
  expect(result.isError).toBeFalsy()
  expect(f.store().registry.map({ kind: 'COMMIT', id: commitSha }).edges.filter(e => e.to.kind === 'SESSION')).toHaveLength(3)
  expect(f.store().count()).toBe(0)
}, 20000)
it('separates configured hooks from capture, reuses observations without CLI work, invalidates configuration and preserves restart/retention', async () => {
  const f = fixture()
  f.mode('unobserved')
  expect(await f.inspect()).toMatchObject({ state: 'READY_CONFIGURED', reason: 'SESSION_UNOBSERVED' })
  f.mode('empty')
  expect(await f.inspect({ trigger: 'RECHECK' })).toMatchObject({ state: 'READY_CONFIGURED', capture: { state: 'UNOBSERVED' } })
  f.mode('observed')
  const observed = await f.inspect({ trigger: 'RECHECK' })
  expect(observed).toMatchObject({ state: 'CAPTURE_OBSERVED', hooks: { git: 'READY', codex: 'READY' } })
  const calls = f.calls()
  expect(await f.inspect()).toMatchObject({ replay: true, observedAt: observed.observedAt })
  expect(f.calls()).toBe(calls)
  f.restart()
  expect(await f.inspect()).toMatchObject({ replay: true })
  expect(f.calls()).toBe(calls)
  expect(f.store().count()).toBe(0)
  expect(JSON.stringify(observed)).not.toContain('PRIVATE_')
  expect(JSON.stringify(observed)).not.toContain(f.root)
  rmSync(join(f.hooks, 'post-commit'))
  expect(await f.inspect()).toMatchObject({ state: 'UNAVAILABLE', reason: 'HOOK_MISSING' })
  writeFileSync(join(f.hooks, 'post-commit'), '# entire hooks git post-commit\n')
  expect(await f.inspect()).toMatchObject({ state: 'UNAVAILABLE', reason: 'HOOK_INCOMPATIBLE', nextEvidence: 'INSPECT_GIT_HOOKS' })
  writeFileSync(join(f.hooks, 'post-commit'), '#!/bin/sh\nentire hooks git post-commit "$@"\n')
  const codex = join(f.root, '.codex/hooks.json')
  const configuration = JSON.parse(readFileSync(codex, 'utf8'))
  configuration.hooks.SessionStart[0].hooks[0].command = 'where.exe entire >nul 2>nul & entire hooks codex session-start'
  writeFileSync(codex, JSON.stringify(configuration))
  expect(await f.inspect()).toMatchObject({ state: 'UNAVAILABLE', reason: 'HOOK_INCOMPATIBLE', nextEvidence: 'INSPECT_ENTIRE_INTEGRATION' })
  expect(f.store().captureHealth({ ...f.target, generation: 'c'.repeat(64) }, 'worktree')).toBeUndefined()
  const b = fixture('B')
  rmSync(join(b.root, '.entire/settings.local.json'))
  expect(await b.inspect()).toMatchObject({ state: 'UNAVAILABLE', capture: { state: 'UNOBSERVED' } })
}, 30000)
it('verifies real fixture checkpoint objects and distinguishes local missing checkpoints, remote commits and interruption', async () => {
  const f = fixture()
  await f.inspect()
  writeFileSync(join(f.root, 'file.txt'), 'legitimate fixture change')
  f.git('add', 'file.txt'); f.git('commit', '-q', '-m', 'fixture local change')
  const sha = f.git('rev-parse', 'HEAD')
  expect(await f.inspect()).toMatchObject({ checkpoint: { state: 'CHECKPOINT_MISSING', commitSha: sha } })
  f.mode('remote')
  expect(await f.inspect({ trigger: 'RECHECK', commitSha: sha })).toMatchObject({ checkpoint: { state: 'NOT_APPLICABLE' } })
  const id = '01M6EGW7096RMXJE1VPD76NDSQ'
  const revision = checkpoint(f, id)
  expect(await observeCheckpoint(f.run, f.root, { checkpointId: id }, () => {})).toMatchObject({ state: 'VERIFIED', refRevision: revision, sessionIds: ['captured-session', 'second-session'] })
  writeFileSync(join(f.root, 'file.txt'), 'checkpoint fixture change')
  f.git('add', 'file.txt'); f.git('commit', '-q', '-m', 'fixture change\n\nEntire-Checkpoint: ' + id)
  f.mode('observed')
  expect(await f.inspect({ trigger: 'RECHECK', commitSha: f.git('rev-parse', 'HEAD') })).toMatchObject({ checkpoint: { state: 'CHECKPOINT_VERIFIED', checkpointId: id, refRevision: revision } })
  f.mode('cancel')
  await expect(f.inspect({ trigger: 'RECHECK' })).rejects.toThrow('PROJECT_CONTEXT_CHANGED')
  expect(f.store().captureHealth(f.target, 'worktree')!.checkpoint.state).toBe('CHECKPOINT_VERIFIED')
}, 30000)
it('never reports capture readiness after provider timeout', async () => {
  const f = fixture()
  f.mode('timeout')
  expect(await f.inspect()).toMatchObject({ state: 'UNAVAILABLE', reason: 'PROVIDER_TIMEOUT', capture: { state: 'UNOBSERVED' } })
}, 15000)
it('distinguishes installed CLI integrations, missing hooks and unsupported editors without attributing another agent capture', async () => {
  const f = fixture()
  const cli = await f.inspect({ agent: 'antigravity' })
  expect(cli).toMatchObject({ state: 'READY_CONFIGURED', capture: { state: 'UNOBSERVED' } })
  expect(cli.integrations).toContainEqual(expect.objectContaining({ agent: 'antigravity', surface: 'CLI', state: 'READY_CONFIGURED' }))
  expect(await f.inspect({ agent: 'claude-code' })).toMatchObject({ state: 'UNAVAILABLE', reason: 'HOOKS_MISSING' })
  for (const agent of ['cline', 'antigravity-ide']) expect(await f.inspect({ agent })).toMatchObject({ state: 'UNAVAILABLE', integrationState: 'UNSUPPORTED', reason: 'INTEGRATION_UNAVAILABLE' })
  expect(f.store().count()).toBe(0)
}, 20000)
it('exposes capture diagnostics through System Health without adding a transcript or capture tool', async () => {
  const f = fixture()
  const adapter = new ChannelMcpAdapter({ projectId: 'A', repoRoot: f.root, navigation: {} as McpProjectContext['navigation'],
    sessionContext: { call: (name, args) => executeSessionTool(f.store(), new EntireProvider(f.store(), f.root, () => {}, f.run), name, args, () => {}, f.target, [], f.run, f.root) } })
  const result = await adapter.callTool('get_system_health', { feature: 'session_context', source: 'entire' })
  expect(result.content[0].type).toBe('text')
  expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ feature: 'session_context', source: 'entire', version: 1, state: 'CAPTURE_OBSERVED' })
  expect(JSON.parse((result.content[0] as { text: string }).text).nativeCapture).toBeUndefined()
  const native = await adapter.callTool('get_system_health', { feature: 'session_context' })
  expect(JSON.parse((native.content[0] as { text: string }).text)).toMatchObject({ source: 'native', state: 'UNAVAILABLE',
    nativeCapture: { readiness: { installation: { state: 'MISSING', installed: 0 }, execution: { state: 'UNOBSERVED' } } } })
  expect(() => readFileSync(nativeBindingPath(f.root))).toThrow()
  expect((await adapter.callTool('get_system_health', { feature: 'session_context', source: 'combined' })).isError).toBe(true)
  expect(adapter.listTools().some(tool => tool.name === 'inspect_capture_health')).toBe(false)
  const raw = readFileSync(join(f.root, '.entire/settings.local.json'), 'utf8')
  expect(raw).toContain('"push_sessions":false')
  const db = new Database(f.store().path)
  expect((db.prepare('SELECT COUNT(*) AS n FROM capture_health').get() as { n: number }).n).toBe(1)
  db.close()
}, 30000)

it('scopes native diagnostics to the selected repository, Worktree, generation and trust snapshot', async () => {
  const f = fixture(), b = fixture('B')
  const binding = installFixture(f, 'codex')
  recordNativeGap(binding.spool, 'IO_FAILURE', 'READ')
  await ingestNativeHooks(f.store().registry, binding, async () => ({ root: f.root, fingerprint: '', validate: async () => {} }), () => {})
  const sibling = join(f.base, 'sibling')
  f.git('worktree', 'add', '--detach', sibling)
  const siblingTarget = { worktreeId: 'c'.repeat(64), generation: 'd'.repeat(64) }
  const query = { source: 'native', inspectNativeTrust: true }
  const read = async (store: SessionStore, root: string, target: typeof f.target, selection = target) => {
    const result = await executeSessionTool(store, {}, 'inspect_capture_health', { ...query, ...selection }, () => {}, target, [], undefined, root,
      undefined, undefined, undefined, undefined, { repositoryId: 'A', ...f.target, observation: { state: 'TRUSTED', reasonCode: 'HASH_TRUST_OBSERVED', freshness: 'OBSERVED_SNAPSHOT' } })
    return JSON.parse((result.content[0] as { text: string }).text)
  }
  for (const result of [await read(f.store(), sibling, siblingTarget), await read(b.store(), b.root, b.target)]) {
    expect(result).toMatchObject({ state: 'UNAVAILABLE', nativeCapture: { readiness: { trust: { state: 'UNKNOWN', reasonCode: 'SESSION_SCOPE_CHANGED' } } } })
    expect(result.nativeCapture.historicalCoverage).toBeUndefined()
  }
  expect(await read(f.store(), f.root, f.target, { ...f.target, generation: siblingTarget.generation })).toEqual({ code: 'WORKTREE_NOT_DISCOVERED' })
}, 20000)
it.runIf(process.env.SESSION_CONTEXT_REAL_CAPTURE_SMOKE === '1')('accepts the existing authorized checkpoint using only real Git metadata', async () => {
  const result = await observeCheckpoint(runReadOnly, process.cwd(), { commitSha: 'e9343e7998b877682604bb772a7ecb31bb8b81e5' }, () => {})
  expect(result).toMatchObject({ state: 'VERIFIED', checkpointId: '01M6EGW7096RMXJE1VPD76NDSQ' })
  expect(result.sessionIds).toHaveLength(2)
}, 20000)
it('U1 surfaces discriminative Entire diagnostic through get_system_health(source: entire) and propagates to live discovery errors', async () => {
  const f = fixture()
  const adapter = new ChannelMcpAdapter({ projectId: 'A', repoRoot: f.root, navigation: {} as McpProjectContext['navigation'],
    sessionContext: { call: (name, args) => executeSessionTool(f.store(), new EntireProvider(f.store(), f.root, () => {}, f.run), name, args, () => {}, f.target, [], f.run, f.root) } })
  writeFileSync(join(f.root, '.entire/settings.local.json'), JSON.stringify({ enabled: true, telemetry: true, strategy_options: { push_sessions: false } }))
  const health = JSON.parse(((await adapter.callTool('get_system_health', { feature: 'session_context', source: 'entire', worktreeId: f.target.worktreeId, generation: f.target.generation })).content[0] as { text: string }).text)
  expect(health).toMatchObject({
    feature: 'session_context', source: 'entire', state: 'UNAVAILABLE', reason: 'PROVIDER_CONFIG_UNSAFE',
    nextEvidence: 'INSPECT_PROVIDER_CONFIGURATION',
    providerDiagnostic: { code: 'PROVIDER_CONFIG_UNSAFE', stage: 'privacy-policy', reason: 'TELEMETRY_ENABLED', action: 'DISABLE_TELEMETRY' }
  })
  const liveErr = await adapter.callTool('discover_entire_sessions', { worktreeId: f.target.worktreeId, generation: f.target.generation })
  expect(liveErr.isError).toBe(true)
  expect(JSON.parse((liveErr.content[0] as { text: string }).text)).toMatchObject({ code: 'PROVIDER_CONFIG_UNSAFE', stage: 'privacy-policy', reason: 'TELEMETRY_ENABLED', action: 'DISABLE_TELEMETRY' })
  expect(JSON.stringify(health)).not.toContain(f.root)
  expect(JSON.stringify(liveErr)).not.toContain(f.root)
}, 20000)

it.each(['0.12.2', '0.13.4'])('recognizes numeric pending turns and qualified agent list on %s without inventing capture', async version => {
  const f = fixture('A', version)
  const provider = new EntireProvider(f.store(), f.root, () => {}, f.run)
  f.mode('pending')
  expect(await provider.inspectCapture()).toMatchObject({ configured: true, reason: 'CAPTURE_OBSERVED', providerSessionId: 'captured-session' })
  f.mode('empty')
  expect(await provider.inspectCapture()).toMatchObject({ configured: true, reason: 'SESSION_UNOBSERVED' })
})

it('recognizes official conditional Entire Git hooks with absolute paths while keeping capture independent and rejecting malformed lines', async () => {
  const f = fixture('A', '0.13.4')
  const conditionalHook = (exe: string, handler: 'prepare-commit-msg' | 'post-commit') =>
    handler === 'prepare-commit-msg'
      ? `#!/bin/sh\n# Entire CLI hooks\nif [ -f '${exe}' ]; then '${exe}' hooks git prepare-commit-msg "$1" "$2" 2>/dev/null || true; else :; fi\n`
      : `#!/bin/sh\n# Entire CLI hooks\n# Post-commit hook: condense session data if commit has Entire-Checkpoint trailer\nif [ -f '${exe}' ]; then '${exe}' hooks git post-commit 2>/dev/null || true; else :; fi\n`
  const writeHooks = (prepare: string, post: string) => {
    writeFileSync(join(f.hooks, 'prepare-commit-msg'), prepare)
    writeFileSync(join(f.hooks, 'post-commit'), post)
  }

  f.mode('unobserved')
  for (const exe of [
    'C:\\Users\\fixture\\.local\\bin\\entire.exe',
    'C:\\Program Files\\Entire CLI\\entire.exe',
    '/Users/fixture/Application Support/Entire CLI/entire'
  ]) {
    writeHooks(conditionalHook(exe, 'prepare-commit-msg'), conditionalHook(exe, 'post-commit'))
    const health = await f.inspect({ trigger: 'RECHECK' })
    expect(health).toMatchObject({
      state: 'READY_CONFIGURED',
      reason: 'SESSION_UNOBSERVED',
      hooks: { git: 'READY', codex: 'READY' },
      capture: { state: 'UNOBSERVED' }
    })
    expect(health.state).not.toBe('CAPTURE_OBSERVED')
    expect(health.checkpoint.state).not.toBe('CHECKPOINT_VERIFIED')
  }

  writeHooks(
    '#!/bin/sh\nexec entire.exe hooks git prepare-commit-msg "$1" "$2" 2>/dev/null || true\n',
    '#!/bin/sh\nexec entire.exe hooks git post-commit\n'
  )
  expect(await f.inspect({ trigger: 'RECHECK' })).toMatchObject({
    state: 'READY_CONFIGURED',
    reason: 'SESSION_UNOBSERVED',
    hooks: { git: 'READY', codex: 'READY' },
    capture: { state: 'UNOBSERVED' }
  })

  const validPrepare = conditionalHook('C:\\Users\\fixture\\.local\\bin\\entire.exe', 'prepare-commit-msg')
  const validPost = conditionalHook('C:\\Users\\fixture\\.local\\bin\\entire.exe', 'post-commit')
  const negativePostHooks = [
    `#!/bin/sh\n# if [ -f 'C:\\Users\\fixture\\.local\\bin\\entire.exe' ]; then 'C:\\Users\\fixture\\.local\\bin\\entire.exe' hooks git post-commit 2>/dev/null || true; else :; fi\n`,
    `#!/bin/sh\necho "if [ -f 'C:\\Users\\fixture\\.local\\bin\\entire.exe' ]; then 'C:\\Users\\fixture\\.local\\bin\\entire.exe' hooks git post-commit 2>/dev/null || true; else :; fi"\n`,
    conditionalHook('C:\\Users\\fixture\\.local\\bin\\other.exe', 'post-commit'),
    `#!/bin/sh\nif [ -f 'C:\\Users\\fixture\\.local\\bin\\entire.exe' ]; then 'C:\\Users\\fixture\\.local\\bin\\entire.exe' hooks codex post-commit 2>/dev/null || true; else :; fi\n`,
    `#!/bin/sh\nif [ -f 'C:\\Users\\fixture\\.local\\bin\\entire.exe' ]; then 'C:\\Users\\fixture\\.local\\bin\\entire.exe' hooks git post-commit-extra 2>/dev/null || true; else :; fi\n`,
    conditionalHook('C:\\Users\\fixture\\.local\\bin\\entire.exe', 'prepare-commit-msg'),
    ...['./entire.exe', '../bin/entire.exe', 'C:entire.exe', 'C:\\Users\\fixture\\..\\entire.exe',
      '$HOME/.local/bin/entire', 'C:\\Users\\$USER\\entire.exe', '/usr/local/bin/$(entire)', 'C:\\Users\\fixture;evil\\entire.exe',
      '\\\\server\\share\\entire.exe', '//server/share/entire.exe', '\\\\.\\C:\\entire.exe', 'C:\\Users\\CON\\entire.exe']
      .map(candidate => conditionalHook(candidate, 'post-commit')),
    `#!/bin/sh\nif [ -f 'C:\\Users\\fixture\\.local\\bin\\entire.exe' ]; then 'C:\\Users\\other\\.local\\bin\\entire.exe' hooks git post-commit 2>/dev/null || true; else :; fi\n`,
    `#!/bin/sh\nif [ -f 'C:\\Users\\fixture\\.local\\bin\\entire.exe' ]; then 'C:\\Users\\fixture\\.local\\bin\\entire.exe' hooks git post-commit 2>/dev/null || true\n`
  ]
  for (const post of negativePostHooks) {
    writeHooks(validPrepare, post)
    expect(await f.inspect({ trigger: 'RECHECK' })).toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'HOOK_INCOMPATIBLE',
      hooks: { git: 'HOOK_INCOMPATIBLE' }
    })
  }
  writeHooks(validPost, validPost)
  expect(await f.inspect({ trigger: 'RECHECK' })).toMatchObject({
    state: 'UNAVAILABLE',
    reason: 'HOOK_INCOMPATIBLE',
    hooks: { git: 'HOOK_INCOMPATIBLE' }
  })
}, 30000)

it('separates Antigravity installation, observed execution, pendingSpoolCount, historical gapCounts and causalityBoundary without erasing history', async () => {
  const f = fixture()
  const ag = installFixture(f, 'antigravity')
  for (let i = 0; i < 13; i++) recordNativeGap(ag.spool, 'SPOOL_FULL', 'WRITE', 'PreToolUse')
  const start = normalizeNativeHook({ conversationId: 'conv-health', workspacePaths: [f.root], hookEventName: 'SessionStart' }, ag)
  const pre = normalizeNativeHook({ conversationId: 'conv-health', workspacePaths: [f.root], hookEventName: 'PreToolUse', toolCall: { id: 'tc-health', name: 'run_command', args: { CommandLine: 'echo ok' } } }, ag)
  spoolNativeHook(start, ag.spool)
  await ingestNativeHooks(f.store().registry, ag, async () => ({ root: f.root, fingerprint: '', validate: async () => {} }), () => {})
  spoolNativeHook(pre, ag.spool)

  const adapter = new ChannelMcpAdapter({
    projectId: 'A', repoRoot: f.root, navigation: {} as McpProjectContext['navigation'],
    sessionContext: { call: (name, args) => executeSessionTool(f.store(), { inspectCapture: () => { throw new Error('NO_ENTIRE') } }, name, args, () => {}, f.target, [], () => { throw new Error('NO_GIT') }, f.root) }
  })
  const result = await adapter.callTool('get_system_health', { feature: 'session_context', source: 'native', agent: 'antigravity', inspectNativeTrust: true })
  expect(result.isError).toBeFalsy()
  const body = JSON.parse((result.content[0] as { text: string }).text)
  expect(body).toMatchObject({
    source: 'native', agent: 'antigravity', state: 'PARTIAL',
    nativeCapture: {
      source: 'ANTIGRAVITY_NATIVE_HOOK',
      pendingSpoolCount: 1,
      causality: 'NOT_EVALUATED',
      causalityBoundary: 'CONTEXTUAL_ONLY_NO_HOST_WITNESS',
      lastIngestion: { state: 'OBSERVED' },
      historicalCoverage: { state: 'PARTIAL', count: 13, resolution: 'UNACKNOWLEDGED', gapCounts: { spoolFull: 13, probeBudget: 0, claimConflict: 0 } },
      pipeline: { accepted: 1, batchesAccepted: 1, recoveredCollisions: 0 },
      readiness: { installation: { state: 'CONFIGURED', installed: 6 }, execution: { state: 'OBSERVED' } }
    }
  })
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(8192)
}, 20000)
