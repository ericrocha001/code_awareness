import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EntireProvider, runReadOnly, type CommandRunner } from './entire-provider'
import { SessionStore, sessionStorePath } from './store'
import { digest } from './privacy'
import { executeSessionTool, SESSION_CONTEXT_TOOLS, SESSION_RESPONSE_BUDGETS } from './mcp'
import { parseLiveSessionQuery, projectLiveUsage, type LiveSessionToolName } from './entire-live'
import { sourceFingerprint, type LiveSessionTarget } from './target'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import type { McpProjectContext } from '../mcp/project-mcp-context'
import { SessionContextClient } from './client'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { GitService } from '../core/git-service'
import { sessionTargetResolver } from './target'
import { buildSync } from 'esbuild'
import { createMcpHttpServer } from '../mcp/mcp-http-server'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup.length = 0 })
const data = (result: Awaited<ReturnType<typeof executeSessionTool>>) => JSON.parse(result.content[0].text)
async function setup() {
  const base = mkdtempSync(join(tmpdir(), 'entire-live-')), root = join(base, 'repo'), sibling = join(base, 'sibling')
  mkdirSync(root); mkdirSync(sibling)
  cleanup.push(() => rmSync(base, { force: true, recursive: true }))
  for (const directory of [root, sibling]) await runReadOnly('git', ['init', '-q'], directory, 4096)
  mkdirSync(join(root, '.entire'))
  writeFileSync(join(root, '.entire/settings.local.json'), JSON.stringify({ enabled: true, telemetry: false, strategy_options: { push_sessions: false } }))
  const store = new SessionStore(sessionStorePath(base, 'A'), 'A'); cleanup.push(() => store.close())
  const executable = join(base, process.platform === 'win32' ? 'entire.exe' : 'entire')
  writeFileSync(executable, 'live pinned fixture')
  const configPath = join(dirname(store.path), 'session-context.provider.json')
  writeFileSync(configPath, JSON.stringify({ enabled: true, repositoryId: 'A', executable, sha256: digest('live pinned fixture'), version: '0.12.2' }))
  const targets: LiveSessionTarget[] = [root, sibling].map((path, index) => ({ root: path, worktreeId: String(index + 1).repeat(64), generation: String(index + 3).repeat(64), fingerprint: sourceFingerprint(path) }))
  const rows = [root, sibling].map((path, index) => ({ session_id: `session-${index}`, agent: 'Codex', status: 'ended', model: 'gpt-6.1-sol', branch: 'feature/live',
    worktree_path: path, started_at: '2026-10-30T00:00:00Z', turns: 63, pending_turns: 4, checkpoints: 4,
    last_prompt: 'PRIVATE_PROMPT_NEVER_RETURN', transcript: 'PRIVATE_TRANSCRIPT', files_touched: ['src/sample.ts', '/private/secrets', '../escape', 'C:\\private\\file'], auth: 'PRIVATE_AUTH' }))
  let metadata: unknown = rows, info: unknown = rows[0], tokens: unknown = { session_id: 'session-0', tokens: { total: 8004182, input: 143958, cache_read: 7824128, cache_write: 0, output: 36096, api_calls: 63 }, recommendations: 'UNTRUSTED_VENDOR_INSTRUCTIONS' }
  let current = true, mode = '', validations = 0
  const calls: string[][] = []
  const assert = () => { if (!current) throw new Error('PROJECT_CONTEXT_CHANGED') }
  const run: CommandRunner = async (exe, args, cwd, limit, consume, timeout, signal) => {
    calls.push(args)
    if (exe === 'git') return runReadOnly(exe, args, cwd, limit, consume, timeout, signal)
    if (args[0] === 'version') return { code: 0, text: 'Entire CLI 0.12.2', limited: false }
    if (args.includes('--help')) return { code: 0, text: '--json', limited: false }
    if (mode === 'switch') current = false
    if (mode === 'limit') return { code: -1, text: 'PRIVATE_STDOUT', limited: true }
    if (mode === 'error') return { code: 2, text: 'PRIVATE_STDOUT', limited: false }
    if (mode === 'timeout') return { code: -1, text: '', limited: true, timedOut: true }
    if (mode === 'replace') writeFileSync(executable, 'changed binary')
    if (mode === 'revoke') writeFileSync(join(root, '.entire/settings.local.json'), JSON.stringify({ telemetry: false, strategy_options: { push_sessions: true } }))
    return { code: 0, text: JSON.stringify(args[1] === 'list' ? metadata : args[1] === 'info' ? info : tokens), limited: false }
  }
  const provider = new EntireProvider(store, root, assert, run, async () => { if (++validations > 1 && mode === 'drift') throw new Error('WORKTREE_STALE') })
  const call = (name: LiveSessionToolName, args: unknown) => executeSessionTool(store, provider, name, args, assert, undefined, targets)
  return { base, root, store, provider, targets, rows, calls, call, configPath, executable, setMetadata: (value: unknown) => { metadata = value }, setInfo: (value: unknown) => { info = value }, setTokens: (value: unknown) => { tokens = value }, mode: (value: string) => { mode = value } }
}

describe('Entire live consultative contracts', () => {
  it('publishes exactly three additional tools and projects mixed live sources without importing or leaking bodies', async () => {
    const f = await setup(), revision = f.store.catalogRevision(), before = readFileSync(f.store.path)
    const catalog = data(await f.call('discover_entire_sessions', {}))
    expect(catalog).toMatchObject({ source: 'ENTIRE_LIVE', transcriptImported: false, coverage: 'COMPLETE', matched: 2 })
    expect(catalog.sessions.map((s: any) => s.worktreeId)).toEqual(f.targets.map(t => t.worktreeId))
    const selected = { providerSessionId: 'session-0', ...f.targets[0] }
    const { root: _root, fingerprint: _fingerprint, ...query } = selected
    expect(data(await f.call('inspect_entire_session', query))).toMatchObject({ pendingTurns: 4, turns: 63, checkpointCoverage: 'UNAVAILABLE' })
    const detail = data(await f.call('inspect_entire_session', { ...query, includeFiles: true, fileLimit: 1 }))
    expect(detail).toMatchObject({ files: ['src/sample.ts'], filesCoverage: 'PARTIAL', fileCount: 4 })
    const usage = data(await f.call('get_entire_session_usage', query))
    expect(usage).toMatchObject({ dataSource: 'ENTIRE_REPORTED', metrics: { total: 8004182, cacheRead: 7824128, apiCalls: 63 }, signals: [{ code: 'HIGH_CONTEXT_INPUT_SHARE', classification: 'HEURISTIC' }] })
    for (const result of [catalog, detail, usage]) {
      const text = JSON.stringify(result)
      for (const forbidden of ['PRIVATE_', 'last_prompt', 'worktree_path', f.root, 'UNTRUSTED_', 'checkpoints']) expect(text).not.toContain(forbidden)
    }
    expect(f.calls.filter(args => args[1] === 'list' && args.includes('--json'))).toHaveLength(1)
    expect(f.calls.some(args => args.includes('--transcript') || args.some(arg => ['attach', 'resume', 'doctor', '--force', '--generate', 'auth'].includes(arg)))).toBe(false)
    expect(f.calls.filter(args => args[0] === 'version')).toHaveLength(1)
    expect(f.store.catalogRevision()).toBe(revision)
    expect(f.store.sessions({}, 0, 10)).toEqual([])
    expect(readFileSync(f.store.path)).toEqual(before)
    expect(SESSION_CONTEXT_TOOLS).toHaveLength(8)
    const adapter = new ChannelMcpAdapter({ projectId: 'A', repoRoot: f.root, navigation: {} as McpProjectContext['navigation'], sessionContext: { call: (name, args) => executeSessionTool(f.store, f.provider, name, args, () => {}, undefined, f.targets) } })
    for (const name of ['discover_entire_sessions', 'inspect_entire_session', 'get_entire_session_usage'] as LiveSessionToolName[]) {
      expect(adapter.listTools().find(t => t.name === name)?.annotations?.readOnlyHint).toBe(true)
      const result = await adapter.callTool(name, name === 'discover_entire_sessions' ? {} : query)
      expect(result.isError).not.toBe(true)
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(SESSION_RESPONSE_BUDGETS[name])
    }
  })

  it('reports bounded or unavailable inventory and rejects foreign sessions, stale targets and invalid inputs', async () => {
    const f = await setup()
    f.setMetadata([...f.rows, { ...f.rows[0], session_id: 'foreign', worktree_path: f.base }, { ...f.rows[0], worktree_path: join(f.base, 'gone') }, null])
    expect(data(await f.call('discover_entire_sessions', { limit: 1 }))).toMatchObject({ coverage: 'PARTIAL', matched: 2, omitted: 3, limitReason: 'SESSION_LIMIT' })
    expect(data(await f.call('discover_entire_sessions', { ...{ worktreeId: f.targets[1].worktreeId, generation: f.targets[1].generation } })).sessions).toHaveLength(1)
    const query = { providerSessionId: 'session-0', worktreeId: f.targets[1].worktreeId, generation: f.targets[1].generation }
    expect(data(await f.call('inspect_entire_session', query)).code).toBe('SOURCE_IDENTITY_CONFLICT')
    expect(data(await f.call('inspect_entire_session', { ...query, providerSessionId: '--transcript' })).code).toBe('INVALID_ARGUMENT')
    expect(() => parseLiveSessionQuery('discover_entire_sessions', { cwd: f.root })).toThrow()
    expect(() => parseLiveSessionQuery('discover_entire_sessions', { worktreeId: f.targets[0].worktreeId })).toThrow()
    expect(() => parseLiveSessionQuery('get_entire_session_usage', { ...query, generation: 'a'.repeat(64) })).not.toThrow()
    expect(data(await f.call('get_entire_session_usage', { ...query, generation: 'a'.repeat(64) })).code).toBe('SOURCE_IDENTITY_CONFLICT')
    f.setMetadata({ sessions: f.rows })
    expect(data(await f.call('discover_entire_sessions', {})).code).toBe('PROVIDER_SCHEMA_UNSUPPORTED')
    f.setMetadata(Array.from({ length: 21 }, (_, index) => ({ ...f.rows[0], session_id: 'large-' + index, model: 'm'.repeat(160), branch: 'b'.repeat(160) })))
    expect(data(await f.call('discover_entire_sessions', { limit: 20 })).code).toBe('RESPONSE_LIMIT_REACHED')
  })

  it('never fabricates token zeros, billing or recommendations from missing or changed vendor metrics', () => {
    expect(projectLiveUsage({ session_id: 'known', limitations: ['private vendor text'] }, 'known')).toMatchObject({ coverage: 'UNAVAILABLE', code: 'TOKEN_USAGE_UNAVAILABLE', billingCoverage: 'UNAVAILABLE', signals: [] })
    expect(projectLiveUsage({ session_id: 'known', tokens: { total: -1, input: '10', api_calls: 2 } }, 'known')).toMatchObject({ coverage: 'PARTIAL', metrics: { apiCalls: 2 } })
    expect(() => projectLiveUsage({ session_id: 'foreign' }, 'known')).toThrow('SOURCE_IDENTITY_CONFLICT')
  })

  it.each([['switch', 'PROJECT_CONTEXT_CHANGED'], ['drift', 'WORKTREE_STALE'], ['limit', 'PROVIDER_OUTPUT_LIMIT'], ['error', 'PROVIDER_UNAVAILABLE'], ['timeout', 'PROVIDER_TIMEOUT'], ['replace', 'PROVIDER_VERSION_MISMATCH'], ['revoke', 'PROVIDER_CONFIG_UNSAFE']])('discards %s without importing or disclosing provider output', async (mode, code) => {
    const f = await setup(); f.mode(mode)
    expect(data(await f.call('discover_entire_sessions', {})).code).toBe(code)
    expect(f.store.sessions({}, 0, 10)).toEqual([])
  })

  it.skipIf(!process.env.ENTIRE_LIVE_PROVIDER_CONFIG)('accepts all three tools through updated Channel HTTP, real worker and existing Entire sessions', async () => {
    const config = JSON.parse(readFileSync(process.env.ENTIRE_LIVE_PROVIDER_CONFIG!, 'utf8'))
    const base = mkdtempSync(join(tmpdir(), 'entire-live-acceptance-'))
    const root = process.cwd(), storePath = sessionStorePath(base, config.repositoryId)
    mkdirSync(dirname(storePath), { recursive: true })
    copyFileSync(process.env.ENTIRE_LIVE_PROVIDER_CONFIG!, join(dirname(storePath), 'session-context.provider.json'))
    const registry = new GitWorktreeRegistry(root, new GitService(), { repositoryId: config.repositoryId, isActive: () => true })
    const resolver = sessionTargetResolver(registry, () => {})
    const workerPath = process.env.SESSION_CONTEXT_BUILT_SMOKE === '1' ? join(root, 'out/main/session-context-worker.js') : join(base, 'worker.cjs')
    if (process.env.SESSION_CONTEXT_BUILT_SMOKE !== '1') {
      const code = buildSync({ entryPoints: ['src/main/session-context/worker.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
      writeFileSync(workerPath, `require = require('node:module').createRequire(${JSON.stringify(join(root, 'package.json'))});\n` + code)
    }
    const client = new SessionContextClient(base, config.repositoryId, root, () => true, workerPath, resolver)
    const adapter = new ChannelMcpAdapter({ projectId: config.repositoryId, repoRoot: root, navigation: {} as McpProjectContext['navigation'], sessionContext: client })
    const server = createMcpHttpServer(adapter, () => {})
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const call = async (name: LiveSessionToolName, args: unknown) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
      const text = await response.text(), result = JSON.parse(text).result
      expect(result.isError, result.content?.[0]?.text).not.toBe(true)
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SESSION_RESPONSE_BUDGETS[name])
      expect(text).not.toContain('last_prompt')
      return { value: data(result), bytes: Buffer.byteLength(text) }
    }
    try {
      const inventory = await call('discover_entire_sessions', {})
      expect(inventory.value.sessions.length).toBeGreaterThan(0)
      const selected = inventory.value.sessions[0]
      const selection = { worktreeId: selected.worktreeId, generation: selected.generation }
      const target = await resolver(selection)
      const infoOutput = await runReadOnly(config.executable, ['session', 'info', selected.providerSessionId, '--json'], target.root, 1024 * 1024)
      expect(infoOutput.code).toBe(0)
      const cliInfo = JSON.parse(infoOutput.text)
      const query = { ...selection, providerSessionId: selected.providerSessionId }
      const filtered = await call('discover_entire_sessions', selection)
      expect(filtered.value.sessions.every((s: any) => s.worktreeId === selection.worktreeId)).toBe(true)
      const detail = await call('inspect_entire_session', query)
      expect(detail.value).toMatchObject({ providerSessionId: cliInfo.session_id, turns: cliInfo.turns, pendingTurns: cliInfo.pending_turns })
      expect(detail.bytes).toBeLessThan(Buffer.byteLength(infoOutput.text))
      const usageOutput = await runReadOnly(config.executable, ['session', 'tokens', selected.providerSessionId, '--json'], target.root, 1024 * 1024)
      expect(usageOutput.code).toBe(0)
      const cliUsage = JSON.parse(usageOutput.text)
      const usage = await call('get_entire_session_usage', query)
      if (cliUsage.tokens) expect(usage.value.metrics).toMatchObject({ total: cliUsage.tokens.total, apiCalls: cliUsage.tokens.api_calls })
      else expect(usage.value).toMatchObject({ coverage: 'UNAVAILABLE', code: 'TOKEN_USAGE_UNAVAILABLE' })
      expect(existsSync(storePath)).toBe(false)
      console.log(JSON.stringify({ acceptance: 'ENTIRE_LIVE_CHANNEL', sessions: inventory.value.sessions.length, selectedProviderSessionId: selected.providerSessionId,
        discoveryBytes: inventory.bytes, inspectBytes: detail.bytes, cliInfoBytes: Buffer.byteLength(infoOutput.text), usageCoverage: usage.value.coverage, transcriptImported: false }))
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await client.dispose()
      rmSync(base, { recursive: true, force: true })
    }
  }, 90_000)
})
