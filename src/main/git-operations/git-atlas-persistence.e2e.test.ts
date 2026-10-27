import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { GitService } from '../core/git-service'
import { cleanupTempRepo, createTempGitRepo, gitExec } from '../core/git-test-helpers'
import { GitAtlasReader } from './git-atlas'
import { GitAtlasSqliteCache } from './git-atlas-sqlite-cache'
import type { AtlasCommit, AtlasHistorySlice, AtlasPersistence } from './git-atlas-cache'
import type { AtlasCatalogManifest } from '../../shared/types/git-atlas-catalog-types'

const roots: string[] = [], readers: GitAtlasReader[] = [], stores: AtlasPersistence[] = []
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
afterEach(async () => {
  for (const reader of readers.splice(0)) reader.invalidate(true)
  for (const store of stores.splice(0)) store.close()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await cleanupTempRepo(root)
})

async function fixture() {
  const root = await createTempGitRepo(), directory = mkdtempSync(join(tmpdir(), 'atlas-sql-'))
  roots.push(root, directory)
  const records: string[] = [], now = Math.floor(Date.now() / 1000) - 600
  for (let i = 1; i <= 240; i++) records.push(`commit refs/heads/main\nmark :${i}\ncommitter Proof <proof@example.com> ${now + i} +0000\ndata 4\ntest\n\n`)
  const imported = spawnSync('git', ['fast-import', '--quiet'], { cwd: root, input: records.join(''), encoding: 'utf8', windowsHide: true })
  expect(imported.status).toBe(0)
  await gitExec(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const git = new GitService(), common = realpathSync(await git.getCommonDirectory(root))
  const open = () => { const store = GitAtlasSqliteCache.acquire(directory, 'repository', common); stores.push(store); return store }
  const reader = (factory: () => AtlasPersistence | Promise<AtlasPersistence> = open) => {
    const value = new GitAtlasReader(root, git, code => { throw new Error(code) }, factory)
    readers.push(value); return value
  }
  return { root, directory, common, git, open, reader }
}

it('waits for a single delayed SQLite open and reuses committed pages through two reopens', async () => {
  const f = await fixture()
  const open = vi.fn(async () => { await wait(50); return f.open() })
  const order = vi.spyOn(f.git, 'getAtlasHistoryOrder'), metadata = vi.spyOn(f.git, 'getAtlasCommitMetadata')
  const first = f.reader(open)
  const pages = await Promise.all([first.history({ window: 'ALL', limit: 20 }), first.history({ window: 'ALL', limit: 20 })])
  expect(open).toHaveBeenCalledTimes(1)
  expect(pages[0]).toEqual(pages[1])
  first.invalidate(true)
  for (let i = 0; i < 2; i++) {
    order.mockClear(); metadata.mockClear()
    const next = f.reader(open)
    expect((await next.history({ window: 'ALL', limit: 20 })).nodes).toEqual(pages[0].nodes)
    expect(order).not.toHaveBeenCalled()
    expect(metadata.mock.calls.every(([, shas]) => shas.length === 0)).toBe(true)
    next.invalidate(true)
  }
  expect(readdirSync(f.directory).filter(file => file.endsWith('.sqlite'))).toHaveLength(1)
}, 30000)

it('persists more than eight concurrent accepted batches and retries SQLite BUSY without losing facts', async () => {
  const f = await fixture(), reader = f.reader(), store = f.open()
  await reader.history({ window: 'ALL', limit: 1 })
  const sha = (await gitExec(f.root, ['rev-parse', 'HEAD'])).trim(), commit = store.getDisplayCommit(sha)!
  const manifest: AtlasCatalogManifest = { scopeKey: 'test', revision: 'revision', topology: 'topology', worktreeGeneration: 'generation', tips: [sha], refs: [], tags: [], observedAt: new Date().toISOString(), available: true }
  const slice: AtlasHistorySlice = { revision: 'revision', worktreeGeneration: 'generation', tips: [sha], window: 'ALL', offset: 0, limit: 1, shas: [sha], hasMore: false, since: null, anchorAt: manifest.observedAt, anchorKind: 'PRESENT', upperBound: null, queriedAt: manifest.observedAt }
  const file = join(f.directory, readdirSync(f.directory).find(file => file.endsWith('.sqlite'))!)
  const lock = new Database(file)
  lock.exec('BEGIN IMMEDIATE')
  const work = Promise.all(Array.from({ length: 24 }, (_, i) => (reader as any).persist(`batch-${i}`, slice, [commit], manifest)))
  await wait(70)
  expect(reader.catalogDiagnostic().state).toBe('SUSPENDED')
  lock.exec('ROLLBACK'); lock.close()
  await work
  expect(reader.catalogDiagnostic()).toEqual({ state: 'READY', reason: null })
  reader.invalidate(true); store.close()
  const reopened = f.open()
  for (let i = 0; i < 24; i++) expect(reopened.getSlice(`batch-${i}`)?.shas).toEqual([sha])
  expect(reopened.getDisplayCommit(sha)).toEqual(commit)
}, 30000)

it('keeps failed accepted writes pending until explicit retry and drains them on normal shutdown', async () => {
  const f = await fixture(), store = f.open(), reader = f.reader(() => store)
  const save = vi.spyOn(store, 'save').mockReturnValue(false)
  await reader.history({ window: 'ALL', limit: 4 })
  expect((reader as any).writes.size).toBe(1)
  expect(reader.catalogDiagnostic().state).toBe('SUSPENDED')
  save.mockRestore()
  reader.invalidate(true)
  const db = new Database(join(f.directory, readdirSync(f.directory).find(file => file.endsWith('.sqlite'))!))
  expect(db.prepare('SELECT count(*) AS n FROM git_commit').get()).toEqual({ n: 4 })
  db.close()
}, 30000)

it('falls back honestly on unavailable storage and closes a late open after dispose', async () => {
  const f = await fixture(), unavailable = f.reader(async () => { throw new Error('unavailable') })
  expect((await unavailable.history({ window: 'ALL', limit: 3 })).nodes).toHaveLength(3)
  expect(unavailable.catalogDiagnostic().state).not.toBe('READY')
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const store = f.open(), close = vi.spyOn(store, 'close'), opened = vi.fn(async () => { await barrier; return store })
  const reader = f.reader(opened)
  const pending = reader.history({ window: 'ALL', limit: 3 })
  await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1))
  reader.invalidate(true); release()
  await expect(pending).rejects.toThrow('REPOSITORY_CONTEXT_CHANGED')
  expect(close).toHaveBeenCalledTimes(1)
}, 30000)

it.each([1, 2])('upgrades schema v%i in place while preserving facts and ordered parent edges', async version => {
  const f = await fixture(), identity = JSON.stringify(['repository', process.platform === 'win32' ? f.common.toLowerCase() : f.common])
  const legacyIdentity = version === 1 ? JSON.stringify(['repository', process.platform === 'win32' ? f.common.toLowerCase() : f.common, 1]) : identity
  const digest = (s: string) => createHash('sha256').update(s).digest('hex')
  const file = join(f.directory, digest(legacyIdentity) + '.sqlite'), legacy = new Database(file)
  const sha = (await gitExec(f.root, ['rev-parse', 'HEAD'])).trim(), parent = (await gitExec(f.root, ['rev-parse', 'HEAD~1'])).trim()
  const commit: AtlasCommit = { sha, parents: [parent], author: 'Proof', subject: 'test', timestamp: new Date().toISOString() }, body = JSON.stringify(commit)
  legacy.exec(`CREATE TABLE cache_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE git_commit(sha TEXT PRIMARY KEY,body TEXT NOT NULL,checksum TEXT NOT NULL,bytes INTEGER NOT NULL,last_access INTEGER NOT NULL); PRAGMA user_version=${version}`)
  legacy.prepare('INSERT INTO cache_meta VALUES (?,?)').run('identity', legacyIdentity)
  legacy.prepare('INSERT INTO git_commit VALUES (?,?,?,?,?)').run(sha, body, digest(sha + body), Buffer.byteLength(body), Date.now())
  legacy.close()
  const store = f.open()
  expect(store.diagnostic().state).toBe('READY')
  expect(store.getDisplayCommit(sha)).toEqual(commit)
  store.close()
  expect(readdirSync(f.directory).filter(name => name.endsWith('.sqlite'))).toEqual([digest(legacyIdentity) + '.sqlite'])
}, 30000)

it('resumes a committed collector checkpoint and never promotes a partial frontier to COMPLETE', async () => {
  const f = await fixture(), store = f.open()
  const sha = (await gitExec(f.root, ['rev-parse', 'HEAD'])).trim()
  const manifest: AtlasCatalogManifest = { scopeKey: 'ledger', revision: 'revision', topology: 'topology', worktreeGeneration: 'generation', tips: [sha], refs: [], tags: [], observedAt: new Date().toISOString(), available: true }
  const round = store.beginRound(manifest)!
  const commits = await f.git.getAtlasFullCommitMetadata(f.root, [sha])
  expect(store.checkpoint(round.id, commits, [sha])).toBe(true)
  expect(store.finishRound(round.id, manifest.revision, true)).toBe(false)
  const frontier = store.frontier(round.id, 32)
  expect(frontier).toEqual(commits[0].parents)
  store.close()
  const reopened = f.open()
  expect(reopened.beginRound(manifest)).toMatchObject({ id: round.id, acquired: 1, status: 'PARTIAL' })
  expect(reopened.frontier(round.id, 32)).toEqual(frontier)
  expect(reopened.getCommit(sha)).toEqual(commits[0])
  expect(reopened.covered(sha, manifest.topology)).toBe(false)
  expect(reopened.checkpoint(round.id, [], ['f'.repeat(40)])).toBe(false)
  reopened.close()
  const afterRollback = f.open()
  expect(afterRollback.getRound(round.id)?.acquired).toBe(1)
  expect(afterRollback.frontier(round.id, 32)).toEqual(frontier)
}, 30000)

it('shares the catalog across linked worktrees while isolating repository identities', async () => {
  const f = await fixture(), store = f.open()
  const linked = join(f.root, 'linked')
  await gitExec(f.root, ['worktree', 'add', '--detach', linked, 'HEAD'])
  const common = await f.git.getCommonDirectory(linked)
  const shared = GitAtlasSqliteCache.acquire(f.directory, 'repository', common)
  const isolated = GitAtlasSqliteCache.acquire(f.directory, 'another-repository', common)
  stores.push(shared, isolated)
  expect(shared.catalogIdentity).toBe(store.catalogIdentity)
  expect(isolated.catalogIdentity).not.toBe(store.catalogIdentity)
  await f.reader().history({ window: 'ALL', limit: 3 })
  const sha = (await gitExec(f.root, ['rev-parse', 'HEAD'])).trim()
  expect(shared.getDisplayCommit(sha)?.sha).toBe(sha)
  expect(isolated.getDisplayCommit(sha)).toBeUndefined()
}, 30000)

it('recovers a failed opener on explicit refresh without abandoning pending writes', async () => {
  const f = await fixture()
  const open = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockImplementation(() => f.open())
  const reader = f.reader(open)
  await reader.history({ window: 'ALL', limit: 3 })
  expect(reader.catalogDiagnostic().state).not.toBe('READY')
  await reader.history({ window: 'ALL', limit: 3, refresh: true })
  expect(open).toHaveBeenCalledTimes(2)
  expect((reader as any).writes.size).toBe(0)
  expect(reader.catalogDiagnostic()).toEqual({ state: 'READY', reason: null })
}, 30000)
