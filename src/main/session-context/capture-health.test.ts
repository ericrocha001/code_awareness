import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })
function fixture(repositoryId = 'A') {
  const base = mkdtempSync(join(tmpdir(), 'capture-health-')), root = join(base, 'repo'), disabled = join(base, 'disabled'), hooks = join(base, 'hooks')
  mkdirSync(root); mkdirSync(disabled); mkdirSync(hooks)
  cleanup.push(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
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
  writeFileSync(join(dirname(path), 'session-context.provider.json'), JSON.stringify({ enabled: true, repositoryId, executable, sha256: digest('pinned fixture'), version: '0.12.2' }))
  let mode = 'observed', active = true, entireCalls = 0
  const assert = () => { if (!active) throw new Error('PROJECT_CONTEXT_CHANGED') }
  const run: CommandRunner = async (exe, args, cwd, limit, consume, timeout, signal) => {
    if (exe === 'git') {
      if (mode === 'remote' && args.includes('reflog')) return { code: 0, text: git('rev-parse', 'HEAD') + '\0pull: fast-forward', limited: false }
      return runReadOnly(exe, args, cwd, limit, consume, timeout, signal)
    }
    entireCalls++
    if (mode === 'timeout') return { code: -1, text: '', timedOut: true, limited: false }
    if (args[0] === 'version') return { code: 0, text: 'Entire CLI 0.12.2', limited: false }
    if (args.includes('--help')) return { code: 0, text: '--json --transcript', limited: false }
    if (mode === 'cancel') active = false
    return { code: 0, limited: false, text: JSON.stringify(args[1] === 'current'
      ? { resolution: mode === 'unobserved' ? 'worktree' : 'caller-env', session: { session_id: 'captured-session' } }
      : { session_id: 'captured-session', agent: 'Codex', status: 'active', worktree_path: cwd, turns: mode === 'empty' ? 0 : 1,
        last_prompt: 'PRIVATE_PROMPT', transcript: 'PRIVATE_TRANSCRIPT' }) }
  }
  const target = { worktreeId: 'a'.repeat(64), generation: 'b'.repeat(64) }
  const inspect = (query: Record<string, unknown> = {}) => inspectCaptureHealth(store, new EntireProvider(store, root, assert, run), run, root, target, captureHealthQuery.parse(query), assert) as Promise<any>
  return { base, root, hooks, git, target, run, inspect, store: () => store, calls: () => entireCalls, mode: (value: string) => { mode = value },
    restart: () => { store.close(); store = new SessionStore(path, repositoryId) } }
}
function checkpoint(f: ReturnType<typeof fixture>, id: string) {
  const blob = (text: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.root, input: text, encoding: 'utf8', windowsHide: true }).trim()
  const tree = (text: string) => execFileSync('git', ['mktree'], { cwd: f.root, input: text, encoding: 'utf8', windowsHide: true }).trim()
  const session = (session_id: string) => tree('100644 blob ' + blob(JSON.stringify({ session_id, checkpoint_id: id, cli_version: '0.12.2' })) + '\tmetadata.json\n')
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
  expect(await f.inspect()).toMatchObject({ state: 'UNAVAILABLE', reason: 'HOOK_INCOMPATIBLE', nextEvidence: 'INSPECT_CODEX_HOOKS' })
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
it('upgrades v4 additively without changing transcript bytes or legacy cursors and rejects future schemas', () => {
  const f = fixture()
  const old = f.store().ingest({ providerSessionId: 'legacy', providerVersion: 'fixture', agent: 'codex', state: 'ENDED', endedAt: '2026-01-01T00:00:00Z',
    coverage: 'COMPLETE', importState: 'TRANSCRIPT_IMPORTED', sourceDigest: 'legacy', sourceBytes: 15 }, [{ type: 'INPUT', sourcePosition: 1, text: 'legacy payload 🧪' }])
  const row = f.store().events(old.sessionId, {}, 0, 1)[0], payload = f.store().event(old.sessionId, row.id)
  const cursor = f.store().cursor({ legacy: true }, 1), path = f.store().path
  f.store().close()
  const db = new Database(path)
  db.exec('DROP TABLE capture_health_latest; DROP TABLE capture_health')
  db.pragma('user_version=4'); db.close()
  f.restart()
  expect(f.store().event(old.sessionId, row.id)).toEqual(payload)
  expect(f.store().offset(cursor, { legacy: true })).toBe(1)
  expect(() => new SessionStore(path, 'foreign')).toThrow('REPOSITORY_MISMATCH')
  f.store().close()
  const future = new Database(path); future.pragma('user_version=999'); future.close()
  expect(() => f.restart()).toThrow('SCHEMA_UNSUPPORTED')
})
it('exposes capture diagnostics through System Health without adding a transcript or capture tool', async () => {
  const f = fixture()
  const adapter = new ChannelMcpAdapter({ projectId: 'A', repoRoot: f.root, navigation: {} as McpProjectContext['navigation'],
    sessionContext: { call: async (name, args) => ({ content: [{ type: 'text', text: JSON.stringify(await f.inspect(args as Record<string, unknown>)) }] }) } })
  const result = await adapter.callTool('get_system_health', { feature: 'session_context' })
  expect(result.content[0].type).toBe('text')
  expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ feature: 'session_context', state: 'CAPTURE_OBSERVED' })
  expect(adapter.listTools().some(tool => tool.name === 'inspect_capture_health')).toBe(false)
  const raw = readFileSync(join(f.root, '.entire/settings.local.json'), 'utf8')
  expect(raw).toContain('"push_sessions":false')
  const db = new Database(f.store().path)
  expect((db.prepare('SELECT COUNT(*) AS n FROM capture_health').get() as { n: number }).n).toBe(1)
  db.close()
}, 30000)
it.runIf(process.env.SESSION_CONTEXT_REAL_CAPTURE_SMOKE === '1')('accepts the existing authorized checkpoint using only real Git metadata', async () => {
  const result = await observeCheckpoint(runReadOnly, process.cwd(), { commitSha: 'e9343e7998b877682604bb772a7ecb31bb8b81e5' }, () => {})
  expect(result).toMatchObject({ state: 'VERIFIED', checkpointId: '01M6EGW7096RMXJE1VPD76NDSQ' })
  expect(result.sessionIds).toHaveLength(2)
}, 20000)
