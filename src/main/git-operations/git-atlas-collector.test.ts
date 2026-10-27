import { afterEach, expect, it, vi } from 'vitest'
import { AtlasCollector } from './git-atlas-collector'
import type { AtlasCommit, AtlasPersistence } from './git-atlas-cache'
import type { AtlasCatalogManifest, AtlasCollectionRound } from '../../shared/types/git-atlas-catalog-types'

const releases: Array<() => void> = []
afterEach(() => { for (const release of releases.splice(0)) release(); vi.restoreAllMocks() })

function fixture(count = 600) {
  const tips = Array.from({ length: count }, (_, i) => (i + 1).toString(16).padStart(40, '0'))
  const manifest: AtlasCatalogManifest = { scopeKey: 'test', revision: 'revision', topology: 'topology', worktreeGeneration: 'generation', tips, refs: [], tags: [], observedAt: new Date().toISOString(), available: true, sourceFingerprint: 'source' }
  const rounds = new Map<string, AtlasCollectionRound>(), frontiers = new Map<string, string[]>(), facts = new Map<string, AtlasCommit>()
  const store = {
    catalogIdentity: crypto.randomUUID(), diagnostic: vi.fn(() => ({ state: 'READY', reason: null })),
    beginRound: vi.fn((value: AtlasCatalogManifest) => {
      if (!rounds.has(value.revision)) {
        rounds.set(value.revision, { id: value.revision, manifest: value, status: 'NOT_STARTED', checkpointVersion: 1, ordering: 'PARENT_FRONTIER_V1', acquired: 0, reason: null })
        frontiers.set(value.revision, [...value.tips])
      }
      return { ...rounds.get(value.revision)! }
    }),
    getRound: vi.fn((id: string) => ({ ...rounds.get(id)! })), getCommit: vi.fn((sha: string) => facts.get(sha)),
    frontier: vi.fn((id: string, limit: number) => frontiers.get(id)!.slice(0, limit)),
    checkpoint: vi.fn((id: string, commits: AtlasCommit[], processed: string[]) => {
      for (const commit of commits) facts.set(commit.sha, commit)
      frontiers.set(id, frontiers.get(id)!.filter(sha => !processed.includes(sha)))
      const round = rounds.get(id)!; round.acquired += processed.length; round.status = 'PARTIAL'
      return true
    }),
    finishRound: vi.fn((id: string) => { rounds.get(id)!.status = 'COMPLETE'; return true }),
    markUnknown: vi.fn((id: string, reason: string) => { rounds.get(id)!.status = 'UNKNOWN'; rounds.get(id)!.reason = reason })
  }
  const consumer = {
    store: store as unknown as AtlasPersistence, manifest,
    fingerprint: vi.fn(async () => consumer.manifest.sourceFingerprint!), observe: vi.fn(async () => consumer.manifest),
    metadata: vi.fn(async (shas: string[]): Promise<AtlasCommit[]> => shas.map(sha => ({ sha, parents: [], author: 'Proof', subject: 'fact', message: 'fact', timestamp: manifest.observedAt }))),
    busy: vi.fn(() => false), changed: vi.fn()
  }
  const release = AtlasCollector.attach(consumer); releases.push(release)
  const coordinator = (AtlasCollector as any).catalogs.get(store.catalogIdentity)
  const step = async () => { clearTimeout(coordinator.timer); coordinator.timer = undefined; await coordinator.step() }
  return { store, consumer, rounds, facts, step, release, coordinator }
}

it('amortizes a stable epoch across eight separately committed units of at most 32 SHAs', async () => {
  const f = fixture()
  await f.step()
  expect(f.consumer.fingerprint).toHaveBeenCalledTimes(1)
  expect(f.consumer.observe).not.toHaveBeenCalled()
  expect(f.store.checkpoint).toHaveBeenCalledTimes(8)
  expect(f.facts.size).toBe(256)
  expect(f.consumer.metadata.mock.calls.every(([shas]) => shas.length <= 32)).toBe(true)
  expect(f.rounds.get('revision')?.status).toBe('PARTIAL')
})

it('ends an epoch at its time budget and revalidates the next epoch', async () => {
  const f = fixture(); let time = 0
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  const checkpoint = f.store.checkpoint.getMockImplementation()!
  f.store.checkpoint.mockImplementation((...args) => { const result = checkpoint(...args); time += 600; return result })
  await f.step()
  expect(f.store.checkpoint).toHaveBeenCalledTimes(2)
  await f.step()
  expect(f.consumer.fingerprint).toHaveBeenCalledTimes(2)
  expect(f.store.checkpoint).toHaveBeenCalledTimes(4)
})

it('yields between units for interactive work and revalidates after it resumes', async () => {
  const f = fixture(); let busy = false
  f.consumer.busy.mockImplementation(() => busy)
  const checkpoint = f.store.checkpoint.getMockImplementation()!
  f.store.checkpoint.mockImplementation((...args) => { const result = checkpoint(...args); setImmediate(() => { busy = true }); return result })
  await f.step()
  expect(busy).toBe(true)
  expect(f.store.checkpoint).toHaveBeenCalledTimes(1)
  await f.step(); expect(f.consumer.fingerprint).toHaveBeenCalledTimes(1)
  busy = false
  await f.step(); expect(f.consumer.fingerprint).toHaveBeenCalledTimes(2)
})

it('never checkpoints a metadata result after its consumer was detached', async () => {
  const f = fixture()
  let release!: (value: AtlasCommit[]) => void
  f.consumer.metadata.mockImplementation(() => new Promise(resolve => { release = resolve }))
  const pending = f.step()
  await vi.waitFor(() => expect(f.consumer.metadata).toHaveBeenCalledTimes(1))
  f.release(); release([]); await pending
  expect(f.store.checkpoint).not.toHaveBeenCalled()
  expect(f.consumer.changed.mock.calls.some(([state]) => state.coverage === 'COMPLETE')).toBe(false)
})

it('retains pinned historical checkpoints when refs move and reconciles before another epoch', async () => {
  const f = fixture()
  let source = 'source'
  f.consumer.fingerprint.mockImplementation(async () => source)
  const metadata = f.consumer.metadata.getMockImplementation()!
  f.consumer.metadata.mockImplementation(async shas => { source = 'new-source'; return metadata(shas) })
  f.consumer.observe.mockImplementation(async () => ({ ...f.consumer.manifest, revision: 'next', sourceFingerprint: source }))
  await f.step()
  expect(f.facts.size).toBe(256)
  expect(f.store.finishRound).not.toHaveBeenCalled()
  await f.step()
  expect(f.consumer.manifest.revision).toBe('next')
  expect(f.facts.size).toBe(256)
  expect(f.store.finishRound).not.toHaveBeenCalled()
})

it('always authenticates exhausted and already COMPLETE rounds before emitting current COMPLETE', async () => {
  const f = fixture(1)
  f.consumer.observe.mockResolvedValueOnce({ ...f.consumer.manifest, revision: 'next', sourceFingerprint: 'next-source' })
  await f.step()
  expect(f.store.finishRound).not.toHaveBeenCalled()
  expect(f.facts.size).toBe(1)
  await f.step()
  expect(f.consumer.observe).toHaveBeenCalledTimes(2)
  expect(f.store.finishRound).toHaveBeenCalledTimes(1)
  expect(f.rounds.get('next')?.status).toBe('COMPLETE')
  f.release()
  const changed = vi.fn(), resumed = { ...f.consumer, changed }
  releases.push(AtlasCollector.attach(resumed))
  const coordinator = (AtlasCollector as any).catalogs.get(f.store.catalogIdentity)
  clearTimeout(coordinator.timer); coordinator.timer = undefined; await coordinator.step()
  expect(f.consumer.observe).toHaveBeenCalledTimes(3)
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({ coverage: 'COMPLETE' }))
})

it.each(['sqlite', 'git', 'coverage'] as const)('does not promote failed %s evidence or spin after failure', async kind => {
  const f = fixture(1)
  if (kind === 'sqlite') f.store.checkpoint.mockReturnValue(false)
  if (kind === 'git') f.consumer.fingerprint.mockRejectedValue(new Error('GIT_STATE_UNAVAILABLE'))
  if (kind === 'coverage') f.consumer.observe.mockImplementation(async () => ({ ...f.consumer.manifest, available: false }))
  await f.step()
  expect(f.consumer.changed.mock.calls.some(([state]) => state.coverage === 'COMPLETE')).toBe(false)
  const calls = f.consumer.fingerprint.mock.calls.length
  await f.step()
  expect(f.consumer.fingerprint).toHaveBeenCalledTimes(calls)
  expect(f.coordinator.timer).toBeUndefined()
})

it('does not mistake an unavailable SQLite frontier for an empty, complete history', async () => {
  const f = fixture(1)
  f.store.frontier.mockImplementation(() => { f.store.diagnostic.mockReturnValue({ state: 'UNAVAILABLE', reason: 'SQLITE_IOERR' } as any); return [] })
  await f.step()
  expect(f.consumer.observe).not.toHaveBeenCalled()
  expect(f.store.finishRound).not.toHaveBeenCalled()
  expect(f.consumer.changed).toHaveBeenLastCalledWith(expect.objectContaining({ coverage: 'UNKNOWN', reason: 'CHECKPOINT_UNAVAILABLE' }))
})

it('does not publish a cached COMPLETE if storage fails while its confirmation was deferred by interaction', async () => {
  const f = fixture(1)
  f.store.beginRound(f.consumer.manifest); f.store.finishRound('revision')
  f.consumer.busy.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true)
  await f.step()
  expect(f.consumer.observe).not.toHaveBeenCalled()
  f.consumer.busy.mockReturnValue(false)
  f.store.diagnostic.mockReturnValue({ state: 'UNAVAILABLE', reason: 'SQLITE_IOERR' } as any)
  await f.step()
  expect(f.consumer.changed).toHaveBeenLastCalledWith(expect.objectContaining({ coverage: 'UNKNOWN', reason: 'CHECKPOINT_UNAVAILABLE' }))
})
