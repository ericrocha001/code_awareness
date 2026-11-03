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
import { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import { ContinuumLocalAdapter } from '../continuum/local-adapter'
import { ValidationLedger } from '../validation-ledger/validation-ledger'
import { authorizeHandoffAssociation, handoffSessionCoverage } from './handoff'
import type { AuthorizedCodexArchiveConnection } from './codex-archive'
import { LocalChannelHost } from '../local-agent-channel/local-channel-host'
import { TestOutputLocalAdapter } from '../validation-ledger/test-output-adapter'
import { createRequire } from 'node:module'

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
async function workerFixture(timeoutMs?: number) {
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
    if(fs.existsSync('suspend-transcript')) {
      fs.writeFileSync('suspended-pid',String(process.pid));
      const timer=setInterval(() => {
        if(!fs.existsSync('release-transcript')) return;
        clearInterval(timer);
        console.log(JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'LATE_EVENT_MUST_NOT_COMMIT'}}));
      },20);
    } else {
    console.log(JSON.stringify({type:'session_meta',payload:{id:row.session_id,cwd:process.cwd()}}));
    for(let n=0;n<740;n++) console.log(JSON.stringify({type:'event_msg',payload:{type:n===487?'error':'agent_message',message:n===487?'sibling failure token=fixture-secret':'progress '+n}}));
    }
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
  const client = new SessionContextClient(storage, 'A', f.main, () => { try { f.assertActive(); return true } catch { return false } }, output, f.resolve, timeoutMs)
  cleanup.push(async () => { client.dispose(); await new Promise(resolve => setTimeout(resolve, 150)) })
  const adapter = new ChannelMcpAdapter({ projectId: 'A', repoRoot: f.main, navigation: {} as McpProjectContext['navigation'], sessionContext: client })
  return { ...f, store, client, adapter }
}

describe('refresh in an explicitly selected sibling Worktree', () => {
  it('uses only authorized official archived metadata, separates Codex from Entire and never imports transcripts or commits late observations', async () => {
    const f = await workerFixture()
    expect(data(await f.client.call('refresh_agent_sessions', f.selection))).toMatchObject({ imported: 1 })
    const calls: unknown[] = []
    let mode: 'supported' | 'foreign' | 'suspended' = 'supported'
    let entered = false
    let release!: () => void
    const connection: AuthorizedCodexArchiveConnection = { repositoryId: 'A', accountIdentity: 'fixture-account', version: 'fixture-official-schema', supports: { archived: true, cwd: true },
      request: async (method, params) => {
        calls.push({ method, params })
        if (mode === 'suspended') { entered = true; await new Promise<void>(resolve => { release = resolve }) }
        return { data: [{ id: 'sibling-session', cwd: mode === 'foreign' ? f.sibling : f.main, createdAt: 1767225600,
          preview: 'PRIVATE_PREVIEW_MUST_NOT_PERSIST', turns: [{ text: 'PRIVATE_TRANSCRIPT_MUST_NOT_PERSIST' }] }], nextCursor: null }
      } }
    const client = new SessionContextClient((f.client as any).storageBase, 'A', f.main, () => true, (f.client as any).workerPath, f.resolve, 10000, undefined, connection)
    cleanup.push(() => client.dispose())
    const catalog = data(await client.call('list_agent_sessions', { includeArchived: true, limit: 1 }))
    expect(calls).toEqual([{ method: 'thread/list', params: { archived: true, cwd: f.main, limit: 20 } }])
    expect(catalog.archiveCoverage.code).toBe('ARCHIVE_OBSERVED')
    expect(catalog.nextCursor).toBeTruthy()
    const continued = data(await client.call('list_agent_sessions', { includeArchived: true, limit: 1, cursor: catalog.nextCursor }))
    expect(continued.sessions).toHaveLength(1)
    expect(calls).toHaveLength(1)
    const codex = f.store.byProvider('sibling-session', 'codex')!
    expect(codex.id).not.toBe(f.store.byProvider('sibling-session', 'entire')!.id)
    expect(codex).toMatchObject({ state: 'UNKNOWN', importState: 'METADATA_ONLY', eventCount: 0, payloadBytes: 0 })
    expect(catalog.sessions.find((row: { sessionId: string }) => row.sessionId === codex.id).archiveState).toBe('ARCHIVED_OBSERVED')
    expect(JSON.stringify(catalog)).not.toContain('PRIVATE_')
    expect(data(await client.call('refresh_agent_sessions', { sessionId: codex.id })).code).toBe('TRANSCRIPT_PROVIDER_UNAVAILABLE')
    expect(f.store.session(codex.id).eventCount).toBe(0)
    const revision = f.store.catalogRevision()
    mode = 'foreign'
    expect(data(await client.call('list_agent_sessions', { includeArchived: true })).archiveCoverage.code).toBe('ARCHIVE_PROVIDER_ERROR')
    expect(f.store.catalogRevision()).toBe(revision)
    connection.supports.archived = false
    const count = calls.length
    expect(data(await client.call('list_agent_sessions', { includeArchived: true })).archiveCoverage.code).toBe('ARCHIVE_PROVIDER_UNAVAILABLE')
    expect(calls).toHaveLength(count)
    connection.supports.archived = true
    mode = 'suspended'
    const ready = await f.resolve.current!()
    const fastResolver = Object.assign(async () => ready, { current: async () => ready })
    const bounded = new SessionContextClient((f.client as any).storageBase, 'A', f.main, () => true, (f.client as any).workerPath, fastResolver, 1500, undefined, connection)
    cleanup.push(() => bounded.dispose())
    const pending = bounded.call('list_agent_sessions', { includeArchived: true })
    expect(data(await pending).code).toBe('SESSION_CONTEXT_TIMEOUT')
    expect(entered).toBe(true)
    release?.()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(f.store.catalogRevision()).toBe(revision)
    expect(f.store.associations(codex.id).some(link => link.archived)).toBe(true)
  }, 45000)
  it('links metadata-only observation through a real Handoff, keeps proof IDs separate, and audits after removing its Worktree', async () => {
    const f = await workerFixture()
    expect(data(await f.client.call('refresh_agent_sessions', f.selection))).toMatchObject({ imported: 1 })
    const session = f.store.byProvider('sibling-session')!
    expect(f.store.associations(session.id)[0]).toMatchObject({ ...f.selection, evidence: 'WORKTREE_VERIFIED' })
    expect(data(await f.client.call('refresh_agent_sessions', f.selection))).toMatchObject({ imported: 0 })
    expect(f.store.associations(session.id)).toHaveLength(1)
    const continuum = new RepositoryContinuumSession(join(f.base, 'continuum-fixture'), { findByPath: () => ({ id: 'A', localCheckout: { path: f.main } }) })
    continuum.activate(f.main); cleanup.push(() => continuum.dispose())
    const service = continuum.getActiveService()!
    const plan = service.publish('---\nname: Historical fixture\ndescription: Target plan\nkind: EXECUTABLE_PLAN\ndate: 2026-11-03T00:00:00Z\n---\nFixture')
    const ledger = new ValidationLedger(join(f.base, 'ledger.db')); cleanup.push(() => ledger.close())
    const profile = join(f.base, 'validation-profile')
    const channel = new LocalChannelHost([new ContinuumLocalAdapter(continuum), new TestOutputLocalAdapter(continuum, ledger)], profile)
    await channel.start(); cleanup.push(() => channel.dispose())
    writeFileSync(join(f.sibling, '.gitignore'), '.code-awareness/\n')
    writeFileSync(join(f.sibling, 'validation.cjs'), "require('node:test')('composition', () => require('node:assert/strict').equal(1 + 1, 2))")
    const runner = createRequire(join(process.cwd(), 'package.json'))('./scripts/test-output.cjs')
    const validation = await runner.run('node', ['--test', '--test-reporter=tap', 'validation.cjs'], { cwd: f.sibling, profile,
      association: { kind: 'TARGETED_TEST', scope: ['validation.cjs'], evidenceFor: [plan.artifactId] } })
    expect(validation.registration).toMatchObject({ state: 'PERSISTED', status: 'PASSED' })
    const proof = ledger.getProof(validation.registration.proofId)!
    expect(proof.commandProfile?.receipt?.id).toBe(validation.id)
    const client = new SessionContextClient((f.client as any).storageBase, 'A', f.main, () => true, (f.client as any).workerPath, f.resolve, 15000,
      async request => authorizeHandoffAssociation(service, ledger, request))
    cleanup.push(() => client.dispose())
    const adapter = new ContinuumLocalAdapter(continuum, (artifact, target) => handoffSessionCoverage(client, artifact, target))
    const commitSha = f.git(f.sibling, 'rev-parse', 'HEAD').trim()
    const markdown = `---\n${JSON.stringify({ name: 'History handoff', description: 'Fixture coverage', kind: 'IMPLEMENTATION_HANDOFF', date: '2026-11-03T00:00:00Z',
      sessionLinks: [{ sessionId: session.id }], executionId: 'execution-fixture', commitSha, pullRequest: 89, proofIds: [proof.proofId], relations: [{ artifactId: plan.artifactId, kind: 'implements' }] })}\n---\nFixture Handoff`
    const receipt = await adapter.operations.publish.execute({ repositoryId: 'A', worktreeId: f.selection.worktreeId, rawMarkdown: markdown }, { connected: () => true }) as any
    expect(receipt).toMatchObject({ state: 'PERSISTED', sessionCoverage: { coverage: 'LINKED', evidence: 'HANDOFF_DECLARED', transcriptImported: false } })
    const link = f.store.associations(session.id).find(link => link.sourceArtifactId === receipt.artifactId)!
    expect(link).toMatchObject({ proofIds: [proof.proofId], evidence: 'HANDOFF_DECLARED', commitSha, pullRequest: 89, sourceRevision: receipt.revision, sourceHash: service.get(receipt.artifactId)!.contentHash })
    const main = await f.registry.current()
    const rejected = data(await client.call('refresh_agent_sessions', { sessionId: session.id, worktreeId: main.worktreeId, generation: main.generation,
      association: { sourceArtifactId: receipt.artifactId, artifactId: plan.artifactId, expectedCatalogRevision: f.store.catalogRevision(), proofIds: [proof.proofId] } }))
    expect(rejected.code).toBe('ASSOCIATION_WORKTREE_MISMATCH')
    f.git(f.main, 'worktree', 'remove', '--force', f.sibling)
    for (const filter of [{ executionId: 'execution-fixture' }, { artifactId: plan.artifactId }, { artifactId: receipt.artifactId }, { commitSha }, { pullRequest: 89 }]) {
      const result = data(await client.call('list_agent_sessions', filter))
      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0]).toMatchObject({ sessionId: session.id, importState: 'METADATA_ONLY', eventCount: 0, claimsVerified: false, worktreeAvailability: 'NOT_RECHECKED' })
      expect(JSON.stringify(result)).not.toContain(f.sibling)
    }
    expect(data(await client.call('list_agent_sessions', { executionId: 'missing' }))).toMatchObject({ sessions: [], reason: 'NO_ASSOCIATION_OBSERVED' })
    expect(data(await client.call('list_agent_sessions', { includeArchived: true })).archiveCoverage.code).toBe('ARCHIVE_PROVIDER_UNAVAILABLE')
    const foreign = new SessionStore(sessionStorePath(f.base, 'B'), 'B'); cleanup.push(() => foreign.close())
    expect(foreign.sessions({ artifactId: plan.artifactId }, 0, 20)).toEqual([])
  }, 60000)
  it('recovers after a suspended transcript times out, kills its process and discards the old worker before a new read', async () => {
    const f = await workerFixture(9000)
    expect(data(await f.client.call('refresh_agent_sessions', f.selection))).toMatchObject({ imported: 1 })
    const id = f.store.byProvider('sibling-session')!.id
    writeFileSync(join(f.sibling, 'suspend-transcript'), '')
    const oldWorker = (f.client as any).generation.worker
    const task = f.client.call('refresh_agent_sessions', { ...f.selection, sessionId: id })
    expect(f.client.call('refresh_agent_sessions', { ...f.selection, sessionId: id })).toBe(task)
    expect(data(await task)).toMatchObject({ code: 'SESSION_CONTEXT_TIMEOUT', phase: 'transcript' })
    const pid = Number(readFileSync(join(f.sibling, 'suspended-pid'), 'utf8'))
    const catalog = data(await f.client.call('list_agent_sessions', {}))
    expect(catalog.sessions).toHaveLength(1)
    expect(catalog.sessions[0].eventCount).toBe(0)
    expect(oldWorker.threadId).toBe(-1)
    expect((f.client as any).generation.worker).not.toBe(oldWorker)
    expect(() => process.kill(pid, 0)).toThrow()
    writeFileSync(join(f.sibling, 'release-transcript'), '')
    rmSync(join(f.sibling, 'suspend-transcript'))
    expect(f.store.session(id).eventCount).toBe(0)
    expect((f.client as any).refresh).toBeUndefined()
    const failedWorker = (f.client as any).generation.worker
    await failedWorker.terminate()
    expect(data(await f.client.call('list_agent_sessions', {})).sessions[0].eventCount).toBe(0)
    expect((f.client as any).generation.worker).not.toBe(failedWorker)
    const worker = (f.client as any).generation.worker
    await f.client.dispose()
    expect(worker.threadId).toBe(-1)
    expect(data(await f.client.call('list_agent_sessions', {})).code).toBe('PROJECT_CONTEXT_CHANGED')
  }, 45_000)
  it('ignores a validation released after timeout and keeps an actual project change terminal', async () => {
    const f = await workerFixture(1500)
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const target = await f.resolve(f.selection)
    const client = new SessionContextClient(f.base, 'A', f.main, () => { try { f.assertActive(); return true } catch { return false } },
      (f.client as any).workerPath, async () => ({ ...target, validate: () => barrier }), 1500)
    cleanup.push(() => client.dispose())
    const task = client.call('refresh_agent_sessions', f.selection)
    expect(data(await task)).toMatchObject({ code: 'SESSION_CONTEXT_TIMEOUT', phase: 'target-validation' })
    const read = client.call('list_agent_sessions', {})
    release()
    expect(data(await read).sessions).toEqual([])
    expect(f.store.count()).toBe(0)
    f.switchProject()
    expect(data(await client.call('list_agent_sessions', {})).code).toBe('PROJECT_CONTEXT_CHANGED')
    await client.dispose()
    expect(data(await client.call('list_agent_sessions', {})).code).toBe('PROJECT_CONTEXT_CHANGED')
  }, 15_000)

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
