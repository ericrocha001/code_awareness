import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSync } from 'esbuild'
import { GitService } from '../core/git-service'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { sessionTargetResolver } from './target'
import { SessionStore, sessionStorePath } from './store'
import { SessionContextClient } from './client'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import type { McpProjectContext } from '../mcp/project-mcp-context'
import type { McpMultimodalToolResult } from '../mcp/mcp-types'
import { createHash } from 'node:crypto'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0 })
const data = (result: McpMultimodalToolResult) => {
  const first = result.content[0]
  if (first.type !== 'text') throw new Error('EXPECTED_TEXT')
  return JSON.parse(first.text)
}
async function setup() {
  const base = mkdtempSync(join(tmpdir(), 'session-sibling-'))
  cleanup.push(() => rmSync(base, { recursive: true, force: true }))
  const main = join(base, 'main'), sibling = join(base, 'sibling'), hooks = join(base, 'empty-hooks')
  mkdirSync(main); mkdirSync(hooks)
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooks}`, ...args], { cwd, windowsHide: true, encoding: 'utf8' })
  git(main, 'init', '-q', '-b', 'main')
  git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture')
  git(main, 'worktree', 'add', '-q', '-b', 'sibling', sibling)
  let current = true
  const assertActive = () => { if (!current) throw new Error('PROJECT_CONTEXT_CHANGED') }
  const registry = new GitWorktreeRegistry(main, new GitService(), { repositoryId: 'A', isActive: () => current })
  const discovered = await registry.discover()
  const record = discovered.worktrees.find(record => record.branch === 'sibling')!
  const selection = { worktreeId: record.worktreeId, generation: record.generation }
  const resolve = sessionTargetResolver(registry, assertActive)
  return { base, main, sibling, git, registry, resolve, selection, switchProject: () => { current = false }, assertActive }
}
async function workerFixture() {
  const f = await setup()
  const storage = join(f.base, 'private'), storePath = sessionStorePath(storage, 'A')
  const store = new SessionStore(storePath, 'A'); cleanup.push(() => store.close())
  const executable = join(f.base, process.platform === 'win32' ? 'entire.exe' : 'entire')
  const node = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', windowsHide: true }).trim()
  copyFileSync(node, executable)
  const config = { enabled: true, repositoryId: 'A', executable, sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'), version: '0.12.0' }
  writeFileSync(join(dirname(storePath), 'session-context.provider.json'), JSON.stringify(config))
  for (const root of [f.main, f.sibling]) {
    mkdirSync(join(root, '.entire'))
    writeFileSync(join(root, '.entire/settings.local.json'), '{"strategy_options":{"push_sessions":false}}')
  }
  writeFileSync(join(f.sibling, 'version'), "console.log('Entire CLI 0.12.0')")
  writeFileSync(join(f.sibling, 'session'), `
    const fs=require('fs'), path=require('path');
    const args=process.argv.slice(2);
    if(args.includes('--help')) { console.log('--json --transcript'); process.exit(0); }
    const row={session_id:'sibling-session',agent:'codex',status:'ACTIVE',worktree_path:process.cwd()};
    if(!args.includes('--transcript')) { console.log(JSON.stringify(args[0]==='list'?[row]:row)); process.exit(0); }
    console.log(JSON.stringify({type:'session_meta',payload:{id:row.session_id,cwd:process.cwd()}}));
    for(let n=0;n<740;n++) console.log(JSON.stringify({type:'event_msg',payload:{type:n===487?'error':'agent_message',message:n===487?'sibling failure token=fixture-secret':'progress '+n}}));
    if(fs.existsSync('replace-before-commit')) {
      const root=process.cwd(), pointer=fs.readFileSync('.git');
      process.chdir(path.dirname(root)); fs.renameSync(root,root+'-old'); fs.mkdirSync(root); fs.writeFileSync(path.join(root,'.git'),pointer);
    }
  `)
  const output = process.env.SESSION_CONTEXT_BUILT_SMOKE === '1' ? join(process.cwd(), 'out/main/session-context-worker.js') : join(f.base, 'worker.cjs')
  if (process.env.SESSION_CONTEXT_BUILT_SMOKE !== '1') {
    const code = buildSync({ entryPoints: ['src/main/session-context/worker.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
    writeFileSync(output, `require = require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});\n` + code)
  }
  const client = new SessionContextClient(storage, 'A', f.main, () => { try { f.assertActive(); return true } catch { return false } }, output, f.resolve)
  cleanup.push(async () => { client.dispose(); await new Promise(resolve => setTimeout(resolve, 150)) })
  const adapter = new ChannelMcpAdapter({ projectId: 'A', repoRoot: f.main, navigation: {} as McpProjectContext['navigation'], sessionContext: client })
  return { ...f, store, client, adapter }
}

describe('refresh in an explicitly selected sibling Worktree', () => {
  it('imports and reads a sibling session through the genuine worker and Channel without switching the main project or changing refs', async () => {
    const f = await workerFixture(), refs = f.git(f.main, 'show-ref'), state = f.git(f.main, 'status', '--porcelain')
    const refresh = await f.adapter.callTool('refresh_agent_sessions', f.selection)
    expect(data(refresh)).toMatchObject({ imported: 1, transcriptImported: false })
    const catalog = data(await f.adapter.callTool('list_agent_sessions', {})), id = catalog.sessions[0].sessionId
    expect(data(await f.adapter.callTool('refresh_agent_sessions', { ...f.selection, sessionId: id }))).toMatchObject({ imported: 1, eventCount: 740 })
    const map = data(await f.adapter.callTool('inspect_agent_session', { sessionId: id }))
    expect(map.types).toContainEqual({ type: 'ERROR', count: 1 })
    const selected = data(await f.adapter.callTool('list_agent_session_events', { sessionId: id, types: ['ERROR'] }))
    expect(data(await f.adapter.callTool('read_agent_session_event', { sessionId: id, eventId: selected.events[0].eventId, expectedRevision: selected.revision })))
      .toMatchObject({ content: 'sibling failure token=[REDACTED]', untrusted: true })
    expect(f.git(f.main, 'branch', '--show-current').trim()).toBe('main')
    expect(f.git(f.main, 'show-ref')).toBe(refs); expect(f.git(f.main, 'status', '--porcelain')).toBe(state)
    expect(f.store.count()).toBe(1)
  }, 45_000)
  it('rejects arbitrary paths, foreign, stale, missing and detached selections in the existing repository registry', async () => {
    const f = await setup()
    const foreign = join(f.base, 'foreign')
    mkdirSync(foreign); f.git(foreign, 'init', '-q', '-b', 'foreign')
    f.git(foreign, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'foreign')
    const otherRegistry = new GitWorktreeRegistry(foreign, new GitService(), { repositoryId: 'B', isActive: () => true })
    const other = (await otherRegistry.discover()).worktrees[0]
    await expect(f.resolve({ worktreeId: other.worktreeId, generation: other.generation })).rejects.toThrow('WORKTREE_NOT_DISCOVERED')
    await expect(f.resolve({ ...f.selection, generation: 'f'.repeat(64) })).rejects.toThrow('WORKTREE_STALE')
    const detached = join(f.base, 'detached')
    f.git(f.main, 'worktree', 'add', '-q', '--detach', detached)
    const record = (await f.registry.discover()).worktrees.find(record => record.detached)!
    await expect(f.resolve({ worktreeId: record.worktreeId, generation: record.generation })).rejects.toThrow('WORKTREE_STALE')
    renameSync(f.sibling, f.sibling + '-moved')
    await expect(f.resolve(f.selection)).rejects.toThrow('WORKTREE_STALE')
    const client = new SessionContextClient(f.base, 'A', f.main, () => true, undefined, f.resolve)
    cleanup.push(() => client.dispose())
    expect(data(await client.call('refresh_agent_sessions', { path: f.sibling })).code).toBe('INVALID_ARGUMENT')
    expect(data(await client.call('refresh_agent_sessions', { worktreeId: f.selection.worktreeId })).code).toBe('INVALID_ARGUMENT')
  }, 15_000)
  it('preserves SQLite and the Channel when opt-in is absent at the target, then rejects generation change before the commit', async () => {
    const f = await workerFixture()
    rmSync(join(f.sibling, '.entire/settings.local.json'))
    expect(data(await f.adapter.callTool('refresh_agent_sessions', f.selection))).toMatchObject({ code: 'PROVIDER_CONFIG_UNSAFE', imported: 0 })
    expect(f.store.count()).toBe(0)
    writeFileSync(join(f.sibling, '.entire/settings.local.json'), '{"strategy_options":{"push_sessions":false}}')
    expect(data(await f.adapter.callTool('refresh_agent_sessions', f.selection))).toMatchObject({ imported: 1 })
    const session = f.store.byProvider('sibling-session')!
    writeFileSync(join(f.sibling, 'replace-before-commit'), '')
    expect(data(await f.adapter.callTool('refresh_agent_sessions', { ...f.selection, sessionId: session.id }))).toMatchObject({ code: 'WORKTREE_STALE' })
    expect(f.store.session(session.id)).toEqual(session)
    expect(data(await f.adapter.callTool('list_agent_sessions', {})).sessions).toHaveLength(1)
    f.switchProject()
    expect(data(await f.adapter.callTool('refresh_agent_sessions', f.selection)).code).toBe('PROJECT_CONTEXT_CHANGED')
  }, 45_000)
  it('rejects an active-project race before dispatch and rolls back if the target guard changes during SQLite commit', async () => {
    const f = await setup(), target = await f.resolve(f.selection)
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const client = new SessionContextClient(f.base, 'A', f.main, () => { try { f.assertActive(); return true } catch { return false } }, undefined,
      async () => { await wait; return target })
    cleanup.push(() => client.dispose())
    const request = client.call('refresh_agent_sessions', f.selection)
    f.switchProject(); release()
    expect(data(await request).code).toBe('PROJECT_CONTEXT_CHANGED')
    const store = new SessionStore(sessionStorePath(f.base, 'A'), 'A'); cleanup.push(() => store.close())
    let checks = 0
    expect(() => store.ingest({ providerSessionId: 'rollback', providerVersion: 'fixture', agent: 'codex', state: 'ACTIVE', coverage: 'COMPLETE', sourceDigest: 'fixture', sourceBytes: 0 },
      [{ type: 'INPUT', sourcePosition: 1, text: 'must roll back' }], () => { if (++checks === 2) throw new Error('WORKTREE_STALE') })).toThrow('WORKTREE_STALE')
    expect(store.count()).toBe(0)
  }, 15_000)
})
