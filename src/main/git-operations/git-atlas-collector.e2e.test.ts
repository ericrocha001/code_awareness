import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { GitService } from '../core/git-service'
import { cleanupTempRepo, createTempGitRepo, gitExec } from '../core/git-test-helpers'
import { GitAtlasReader } from './git-atlas'
import { GitAtlasSqliteCache } from './git-atlas-sqlite-cache'
import { AtlasCollector } from './git-atlas-collector'
import type { AtlasPersistence } from './git-atlas-cache'
import type { AtlasCatalogState } from '../../shared/types/git-atlas-catalog-types'

const roots: string[] = [], stores: AtlasPersistence[] = [], readers: GitAtlasReader[] = [], releases: Array<() => void> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const reader of readers.splice(0)) reader.invalidate(true)
  for (const store of stores.splice(0)) store.close()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await cleanupTempRepo(root)
})
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function fixture(count = 12) {
  const root = await createTempGitRepo(), directory = mkdtempSync(join(tmpdir(), 'atlas-epoch-'))
  roots.push(root, directory)
  const records: string[] = [], now = Math.floor(Date.now() / 1000) - 1000
  for (let i = 1; i <= count; i++) records.push(`commit refs/heads/main\nmark :${i}\ncommitter Proof <proof@example.com> ${now + i} +0000\ndata 4\nfact\n\n`)
  expect(spawnSync('git', ['fast-import', '--quiet'], { cwd: root, input: records.join(''), encoding: 'utf8', windowsHide: true }).status).toBe(0)
  await gitExec(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const git = new GitService(), common = await git.getCommonDirectory(root)
  const open = () => { const store = GitAtlasSqliteCache.acquire(directory, 'repository', common); stores.push(store); return store }
  const consumer = async (checkout = root) => {
    const reader = new GitAtlasReader(checkout, git, code => { throw new Error(code) }, () => open()); readers.push(reader)
    const manifest = await (reader as any).catalogManifest('native')
    await (reader as any).persistenceReady
    const store = open(), state: AtlasCatalogState[] = []
    const value = { store, manifest, fingerprint: vi.fn(() => git.getAtlasSourceFingerprint(checkout)),
      observe: vi.fn(() => (reader as any).catalogManifest('native', true)),
      metadata: vi.fn((shas: string[]) => git.getAtlasFullCommitMetadata(checkout, shas)), busy: vi.fn(() => false), changed: vi.fn((next: AtlasCatalogState) => { state.push(next) }) }
    const round = store.beginRound(manifest)!
    const start = () => { const release = AtlasCollector.attach(value); releases.push(release); return release }
    const complete = () => vi.waitFor(() => expect(state.at(-1)?.coverage).toBe('COMPLETE'), { timeout: 30000, interval: 50 })
    return { value, store, reader, state, round, start, complete }
  }
  return { root, directory, common, git, open, consumer }
}

it('collects a linear frontier with fewer probes and a transaction per unit', async () => {
  const f = await fixture(40), c = await f.consumer()
  const checkpoint = vi.spyOn(c.store, 'checkpoint'), probes = vi.spyOn(f.git, 'getAtlasSourceFingerprint')
  c.start(); await c.complete()
  const round = c.store.getRound(c.round.id)!
  expect(round).toMatchObject({ status: 'COMPLETE', acquired: 40 })
  expect(checkpoint).toHaveBeenCalledTimes(40)
  expect(checkpoint.mock.calls.every(([, commits, processed]) => commits.length <= 32 && processed.length <= 32)).toBe(true)
  expect(probes.mock.calls.length).toBeLessThan(20)
  expect(c.store.frontier(round.id, 32)).toEqual([])
  console.info(JSON.stringify({ collector: { commits: round.acquired, checkpoints: checkpoint.mock.calls.length, fullProbes: probes.mock.calls.length } }))
}, 45000)

it('pauses between checkpoints, reopens the same ledger and never reacquires accepted SHAs', async () => {
  const f = await fixture(), c = await f.consumer()
  const checkpoint = c.store.checkpoint.bind(c.store), accepted: string[] = []
  vi.spyOn(c.store, 'checkpoint').mockImplementation((id, commits, processed) => {
    const result = checkpoint(id, commits, processed)
    if (result) accepted.push(...processed)
    if (accepted.length >= 3) c.value.busy.mockReturnValue(true)
    return result
  })
  const stop = c.start()
  await vi.waitFor(() => expect(accepted).toHaveLength(3), { timeout: 10000 })
  const probes = c.value.fingerprint.mock.calls.length
  await wait(300); expect(c.value.fingerprint).toHaveBeenCalledTimes(probes)
  stop(); c.reader.invalidate(true); c.store.close()
  const next = await f.consumer()
  expect(next.round).toMatchObject({ id: c.round.id, acquired: 3, status: 'PARTIAL' })
  next.start(); await next.complete()
  expect(next.value.metadata.mock.calls.flatMap(([shas]) => shas).some(sha => accepted.includes(sha))).toBe(false)
  expect(next.store.getRound(next.round.id)?.acquired).toBe(12)
  expect(readdirSync(f.directory).filter(file => file.endsWith('.sqlite'))).toHaveLength(1)
}, 45000)

it.each(['new-ref', 'force-push'] as const)('keeps historical facts but authenticates current COMPLETE after %s', async kind => {
  const f = await fixture(8), c = await f.consumer(), oldHead = c.value.manifest.tips[0]
  const metadata = c.value.metadata.getMockImplementation()!
  let moved = false
  c.value.metadata.mockImplementation(async shas => {
    const commits = await metadata(shas)
    if (!moved) {
      moved = true
      if (kind === 'new-ref') {
        await gitExec(f.root, ['commit', '--allow-empty', '-m', 'new tip'])
        await gitExec(f.root, ['branch', 'external-ref'])
      } else await gitExec(f.root, ['update-ref', 'refs/heads/main', 'HEAD~4'])
    }
    return commits
  })
  c.start(); await c.complete()
  const current = c.state.at(-1)!
  expect(current.manifest?.sourceFingerprint).toBe(await f.git.getAtlasSourceFingerprint(f.root))
  expect(current.manifest?.tips).toContain((await gitExec(f.root, ['rev-parse', 'HEAD'])).trim())
  expect(c.store.getRound(c.round.id)?.status).not.toBe('COMPLETE')
  expect(c.store.getCommit(oldHead)?.sha).toBe(oldHead)
  expect(current.manifest?.revision).not.toBe(c.round.manifest.revision)
}, 45000)

it('keeps a failed SQLite checkpoint atomic and resumes only after controlled retry', async () => {
  const f = await fixture(6), c = await f.consumer()
  const metadata = c.value.metadata.getMockImplementation()!
  let calls = 0, lock: Database.Database | undefined
  c.value.metadata.mockImplementation(async shas => {
    const commits = await metadata(shas)
    if (++calls === 2) {
      lock = new Database(join(f.directory, readdirSync(f.directory).find(file => file.endsWith('.sqlite'))!))
      lock.exec('BEGIN IMMEDIATE')
    }
    return commits
  })
  const stop = c.start()
  await vi.waitFor(() => expect(c.state.at(-1)?.reason).toBe('CHECKPOINT_UNAVAILABLE'), { timeout: 15000 })
  const fingerprints = c.value.fingerprint.mock.calls.length
  await wait(300); expect(c.value.fingerprint).toHaveBeenCalledTimes(fingerprints)
  lock!.exec('ROLLBACK'); lock!.close(); lock = undefined
  expect(c.store.retry?.()).toBe(true)
  expect(c.store.getRound(c.round.id)?.acquired).toBe(1)
  expect(c.store.frontier(c.round.id, 32)).toHaveLength(1)
  stop(); c.start(); await c.complete()
  expect(c.store.getRound(c.round.id)?.acquired).toBe(6)
}, 45000)

it('shares one writer across linked worktrees without crossing manifest generations', async () => {
  const f = await fixture(6), linked = join(f.directory, 'linked')
  await gitExec(f.root, ['worktree', 'add', '--detach', linked, 'HEAD'])
  const a = await f.consumer(), b = await f.consumer(linked)
  expect(a.store.catalogIdentity).toBe(b.store.catalogIdentity)
  expect(a.value.manifest.worktreeGeneration).not.toBe(b.value.manifest.worktreeGeneration)
  let running = 0, maximum = 0
  for (const c of [a, b]) {
    const metadata = c.value.metadata.getMockImplementation()!
    c.value.metadata.mockImplementation(async shas => {
      maximum = Math.max(maximum, ++running)
      try { return await metadata(shas) } finally { running-- }
    })
    c.start()
  }
  await Promise.all([a.complete(), b.complete()])
  expect(maximum).toBe(1)
  expect(a.value.metadata.mock.calls.flatMap(([shas]) => shas).length + b.value.metadata.mock.calls.flatMap(([shas]) => shas).length).toBe(6)
  expect(a.state.at(-1)?.manifest?.worktreeGeneration).toBe(a.value.manifest.worktreeGeneration)
  expect(b.state.at(-1)?.manifest?.worktreeGeneration).toBe(b.value.manifest.worktreeGeneration)
}, 45000)

it('closes during metadata I/O without checkpointing on a released connection and reopens safely', async () => {
  const f = await fixture(6), c = await f.consumer()
  const metadata = c.value.metadata.getMockImplementation()!
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  c.value.metadata.mockImplementation(async shas => { const commits = await metadata(shas); entered(); await barrier; return commits })
  const checkpoint = vi.spyOn(c.store, 'checkpoint'), stop = c.start()
  await started
  stop(); c.reader.invalidate(true); c.store.close(); release()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(checkpoint).not.toHaveBeenCalled()
  const resumed = await f.consumer()
  expect(resumed.round.acquired).toBe(0)
  resumed.start(); await resumed.complete()
  expect(resumed.store.getRound(resumed.round.id)?.acquired).toBe(6)
}, 45000)

it.each(['shallow', 'replacement', 'graft'] as const)('preserves physical parents when %s topology changes inside an epoch and later resumes', async kind => {
  const f = await fixture(6), c = await f.consumer()
  const boundary = (await gitExec(f.root, ['rev-parse', 'HEAD~1'])).trim()
  const originalRoot = (await gitExec(f.root, ['rev-parse', 'HEAD~5'])).trim()
  const marker = kind === 'shallow' ? join(f.common, 'shallow') : kind === 'graft' ? join(f.common, 'info/grafts') : join(f.common, 'refs/replace', boundary)
  if (kind === 'replacement') mkdirSync(join(f.common, 'refs/replace'), { recursive: true })
  const checkpoint = c.store.checkpoint.bind(c.store)
  let changed = false
  vi.spyOn(c.store, 'checkpoint').mockImplementation((...args) => {
    const result = checkpoint(...args)
    if (result && !changed) { changed = true; writeFileSync(marker, (kind === 'replacement' ? originalRoot : boundary) + '\n') }
    return result
  })
  const stop = c.start()
  await vi.waitFor(() => expect(c.state.at(-1)?.coverage).toBe('UNKNOWN'), { timeout: 15000 })
  expect(c.state.some(state => state.coverage === 'COMPLETE')).toBe(false)
  stop(); unlinkSync(marker)
  c.reader.invalidate(true); c.store.close()
  const resumed = await f.consumer()
  resumed.start(); await resumed.complete()
  expect(resumed.store.getRound(resumed.round.id)?.acquired).toBe(6)
  expect(resumed.store.getCommit(boundary)?.parents).toEqual([(await gitExec(f.root, ['rev-parse', 'HEAD~2'])).trim()])
}, 45000)
