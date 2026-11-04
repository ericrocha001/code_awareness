import { afterEach, expect, it } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { SessionContextClient } from './client'
import { SessionStore, sessionStorePath } from './store'
import { CodexArchiveBridge } from './codex-archive-bridge'
import { CodexStdio } from './codex-stdio'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { GitService } from '../core/git-service'
import { sessionTargetResolver } from './target'
import { RepositoryContinuumSession } from '../continuum/project-continuum-session'
import { ValidationLedger } from '../validation-ledger/validation-ledger'
import { authorizeHandoffAssociation } from './handoff'
import { registrySources } from './registry-sources'

const cleanup: (() => unknown)[] = []
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0 })
const data = (result: { content: readonly unknown[] }) => JSON.parse((result.content[0] as { text: string }).text)
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'archive-integration-')), main = join(base, 'repo'), sibling = join(base, 'sibling'), profile = join(base, 'profile'), storage = join(base, 'storage')
  mkdirSync(main); mkdirSync(profile)
  cleanup.push(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + join(base, 'no-hooks'), '-c', 'user.name=Archive Fixture', '-c', 'user.email=archive@example.invalid', ...args], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  git(main, 'init', '-q', '-b', 'main'); writeFileSync(join(main, 'fixture.txt'), 'legitimate fixture baseline'); git(main, 'add', '.'); git(main, 'commit', '-qm', 'fixture baseline'); git(main, 'worktree', 'add', '-qb', 'archive-fixture', sibling)
  const control = join(base, 'control.json'), log = join(base, 'methods.txt'), script = join(base, 'app-server-fixture.cjs')
  writeFileSync(control, '{}'); writeFileSync(log, '')
  writeFileSync(script, `const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const f=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},f.method+'\\n');if(!f.id)return;const c=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));let result;if(f.method==='initialize')result={userAgent:'codex/0.155.0'};else if(f.method==='account/read')result={account:{type:'chatgpt',email:c.account||'fixture@example.invalid'}};else if(f.method==='thread/list')result={data:[{id:'archived-fixture',cwd:c.wrongCwd?'/foreign':${JSON.stringify(sibling)},createdAt:1730831111,preview:'PRIVATE_PROMPT',name:'PRIVATE_TITLE'}],nextCursor:null};else {process.stdout.write(JSON.stringify({id:f.id,error:{code:-32601,message:'UNSUPPORTED'}})+'\\n');return}process.stdout.write(JSON.stringify({id:f.id,result})+'\\n')});`)
  const workerPath = join(base, 'worker.cjs'), packagePath = join(process.cwd(), 'package.json')
  const built = buildSync({ entryPoints: ['src/main/session-context/worker.ts'], bundle: true, platform: 'node', packages: 'external', format: 'cjs', write: false }).outputFiles[0].text
  writeFileSync(workerPath, `require=require('node:module').createRequire(${JSON.stringify(packagePath)});\n` + built)
  const store = new SessionStore(sessionStorePath(storage, 'repo'), 'repo'); cleanup.push(() => store.close())
  const continuum = new RepositoryContinuumSession(join(base, 'continuum'), { findByPath: () => ({ id: 'repo', localCheckout: { path: main } }) }); continuum.activate(main); cleanup.push(() => continuum.dispose())
  const service = continuum.getActiveService()!, ledger = new ValidationLedger(join(base, 'ledger.sqlite')); cleanup.push(() => ledger.close())
  const clients: SessionContextClient[] = []
  const makeClient = (root: string) => {
    const resolve = sessionTargetResolver(new GitWorktreeRegistry(root, new GitService(), { repositoryId: 'repo', isActive: () => true }), () => {})
    const client = new SessionContextClient(storage, 'repo', root, () => true, workerPath, resolve, 20000,
      async request => authorizeHandoffAssociation(service, ledger, request), undefined,
      registrySources({ repositoryId: 'repo', root, continuum: () => service, ledger, github: {} as any, networkAllowed: () => false, assertCurrent: () => {} }))
    clients.push(client); cleanup.push(() => client.dispose()); return { client, resolve }
  }
  const createBridge = (root: string, client: SessionContextClient) => {
    const bridge = new CodexArchiveBridge({ repositoryId: 'repo', root, isCurrent: () => true, changed: (connection, readiness) => client.setArchiveConnection(connection, readiness),
      approveProfile: async () => true, approveAccount: async () => true,
      probe: async () => ({ version: '0.155.0', supports: { archived: true, cwd: true, stateDbOnly: true } }),
      connect: (_profile, invalidated) => new CodexStdio(spawn(process.execPath, [script], { cwd: base, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }), invalidated) })
    cleanup.push(() => bridge.disable()); return bridge
  }
  const selected = makeClient(sibling), bridge = createBridge(sibling, selected.client)
  return { base, main, sibling, profile: { executable: process.execPath, directory: profile }, store, service, ledger, client: selected.client, resolve: selected.resolve, bridge, createBridge, makeClient, git,
    control: (value: object) => writeFileSync(control, JSON.stringify(value)), methods: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) }
}
it('connects the actual opt-in stdio bridge to the existing client/worker/store and metadata registry; foreign cwd/account fail closed', async () => {
  const f = await fixture()
  expect(data(await f.client.call('list_agent_sessions', { includeArchived: true }))).toMatchObject({ sessions: [], archiveCoverage: { code: 'ARCHIVE_PROVIDER_UNAVAILABLE', providerState: 'NOT_CONFIGURED' } })
  expect(f.methods()).toEqual([])
  expect((await f.bridge.enable(f.profile)).state).toBe('READY')
  expect(f.methods()).not.toContain('thread/list')
  const first = data(await f.client.call('list_agent_sessions', { includeArchived: true }))
  expect(first).toMatchObject({ archiveCoverage: { code: 'ARCHIVE_OBSERVED', providerState: 'READY' }, sessions: [{ provider: 'codex', providerSessionId: 'archived-fixture', importState: 'METADATA_ONLY', eventCount: 0 }] })
  const session = first.sessions[0]
  expect(JSON.stringify(first)).not.toMatch(/PRIVATE|example.invalid/)
  const map = data(await f.client.call('discover_execution_context', { selector: { type: 'SESSION', provider: 'codex', id: 'archived-fixture' } }))
  expect(map.nodes.some((n: any) => n.type === 'WORKTREE')).toBe(true)
  expect(map.captureCoverage).toBe('CHECKPOINT_NOT_OBSERVED')
  expect(f.store.session(session.sessionId).eventCount).toBe(0)
  f.control({ wrongCwd: true })
  expect(data(await f.client.call('list_agent_sessions', { includeArchived: true })).archiveCoverage.code).toBe('ARCHIVE_PROVIDER_ERROR')
  expect(f.store.count()).toBe(1)
  f.control({ account: 'another@example.invalid' })
  const changed = data(await f.client.call('list_agent_sessions', { includeArchived: true }))
  expect(['ARCHIVE_CONNECTION_CHANGED', 'ARCHIVE_PROVIDER_ERROR']).toContain(changed.code ?? changed.archiveCoverage?.code)
  expect(f.bridge.inspect().state).toBe('ACCOUNT_IDENTITY_UNAVAILABLE')
  expect(data(await f.client.call('list_agent_sessions', {})).sessions).toEqual([])
  expect(data(await f.client.call('inspect_agent_session', { sessionId: session.sessionId })).code).toBe('SESSION_UNAVAILABLE')
  expect(f.store.count()).toBe(1)
  f.control({}); await f.bridge.enable(f.profile)
  const reopened = data(await f.client.call('list_agent_sessions', { includeArchived: true }))
  expect(reopened.sessions[0].sessionId).toBe(session.sessionId)
  expect(f.store.associations(session.sessionId).filter(a => a.archived)).toHaveLength(1)
}, 45000)
it('preserves exceptional declared history after removing a fixture Worktree and reconnecting the same authorized profile', async () => {
  const f = await fixture(); await f.bridge.enable(f.profile)
  const observed = data(await f.client.call('list_agent_sessions', { includeArchived: true })), sessionId = observed.sessions[0].sessionId
  const plan = f.service.publish('---\nname: Archive fixture plan\ndescription: Fixture plan for authorized archive metadata\nkind: EXECUTABLE_PLAN\ndate: 2026-11-03T00:00:00Z\n---\nFixture plan')
  const proof = f.ledger.recordProof({ kind: 'MANUAL_ACCEPTANCE', producer: 'SYSTEM', status: 'PASSED', startedAt: '2026-11-03T00:00:00Z', finishedAt: '2026-11-03T00:00:00Z', durationMs: 0, scope: ['fixture metadata observation'], summary: 'Fixture archive metadata observed', evidenceFor: [plan.artifactId] })
  const commitSha = f.git(f.sibling, 'rev-parse', 'HEAD')
  const handoff = f.service.publish('---\n' + JSON.stringify({ name: 'Archive fixture handoff', description: 'Fixture legacy association', kind: 'IMPLEMENTATION_HANDOFF', date: '2026-11-03T00:00:00Z', sessionLinks: [{ sessionId }], commitSha, pullRequest: 7, proofIds: [proof.proofId], relations: [{ artifactId: plan.artifactId, kind: 'implements' }] }) + '\n---\nFixture declaration')
  const target = (await f.resolve.current!()).selection
  const declared = data(await f.client.call('refresh_agent_sessions', { ...target, sessionId, association: { sourceArtifactId: handoff.artifactId, artifactId: plan.artifactId, commitSha, pullRequest: 7, proofIds: [proof.proofId], expectedCatalogRevision: f.store.catalogRevision() } }))
  expect(declared).toMatchObject({ state: 'PERSISTED', evidence: 'HANDOFF_DECLARED', transcriptImported: false })
  f.bridge.disable(); await f.client.dispose()
  f.git(f.main, 'worktree', 'remove', '--force', f.sibling)
  const next = f.makeClient(f.main), bridge = f.createBridge(f.main, next.client); await bridge.enable(f.profile)
  for (const selector of [{ artifactId: plan.artifactId }, { commitSha }, { pullRequest: 7 }]) {
    const result = data(await next.client.call('list_agent_sessions', selector))
    expect(result.sessions[0]).toMatchObject({ sessionId, importState: 'METADATA_ONLY', eventCount: 0, worktreeAvailability: 'NOT_RECHECKED' })
  }
  expect(f.store.associations(sessionId).some(a => a.evidence === 'CHECKPOINT_VERIFIED')).toBe(false)
  const map = data(await next.client.call('discover_execution_context', { selector: { type: 'ARTIFACT', id: plan.artifactId } }))
  expect(map.nodes.some((n: any) => n.type === 'SESSION')).toBe(true)
  expect(map.edges.some((e: any) => e.state === 'DECLARED')).toBe(true)
  const noLinks = f.service.publish('---\n' + JSON.stringify({ name: 'Automatic fixture handoff', description: 'Fixture without manual session links', kind: 'IMPLEMENTATION_HANDOFF', date: '2026-11-03T00:00:00Z', pullRequest: 8 }) + '\n---\nNo manual links')
  expect(data(await next.client.call('refresh_agent_sessions', { contextSelector: { type: 'ARTIFACT', id: noLinks.artifactId } })).state).toBe('RECONCILED')
  const noCheckpoint = data(await next.client.call('discover_execution_context', { selector: { type: 'PR', id: '8' } }))
  expect(noCheckpoint.counts.ARTIFACT).toBe(1); expect(noCheckpoint.captureCoverage).toBe('CHECKPOINT_NOT_OBSERVED')
  expect(f.store.count()).toBe(1)
}, 60000)
