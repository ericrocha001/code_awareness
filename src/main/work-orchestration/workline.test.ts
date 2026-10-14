import { afterEach, expect, it, vi } from 'vitest'
import { Workline } from './workline'
import type { OrchestrationOverview, ObservableWorktree } from '../../shared/types/work-orchestration-types'
const record = (i: number): ObservableWorktree => ({ worktreeId: String(i), generation: 'g', path: '/r/' + i, branch: 'w' + i, head: 'a'.repeat(40), detached: false, locked: false, missing: false, prunable: false, reference: i === 0, snapshot: null, observation: 'NOT_OBSERVED', reason: null, stagedCount: null, unstagedCount: null, untrackedCount: null, conflictCount: null })
const inventory = (count: number): OrchestrationOverview => ({ repositoryId: 'repo', worktrees: Array.from({ length: count }, (_, i) => record(i)), pairs: [], inventoryCoverage: 'COMPLETE', relationsCoverage: 'NOT_EVALUATED', revision: 'r', observedAt: 'now' })
function driver() {
  return { captures: new Map(), pending: new Map(), stats: { observations: 0, captures: 0, extractions: 0, bytes: 0, confirmedPairs: 0 },
    observe: vi.fn(async (_id: string, _head: string) => false), investigate: vi.fn(async () => [] as any[]), remove: vi.fn(), invalidate: vi.fn() }
}
afterEach(() => { vi.useRealTimers() })
it('withdraws the decision on local revision and generation drift without reading Git', async () => {
  vi.useFakeTimers()
  const data = inventory(3), engine = { ...driver(), observedStates: new Map<string, any>() }
  for (const r of data.worktrees) engine.observedStates.set(r.worktreeId, { repositoryId: 'repo', generation: 'g', localRevision: 'local', head: r.head })
  const finding = { provider: '1', consumer: '2', providerGeneration: 'g', consumerGeneration: 'g', providerRevision: 'p1', consumerRevision: 'c1', base: 'base', evidence: [{ contractPath: 's.ts', consumerPath: 'c.ts', symbol: 's', contractLine: 1, consumerLine: 2, signature: 'new', previousSignature: 'old', binding: 'RESOLVED_DIRECT' }] }
  engine.investigate.mockResolvedValueOnce([finding])
  const line = new Workline(async () => data, engine as any, vi.fn(), () => 1000)
  line.start(); await line.runOnce()
  const calls = engine.observe.mock.calls.length
  expect(line.snapshot().alerts[0].recommendation?.action).toBe('REVIEW_CONTRACT_COMPATIBILITY')
  engine.observedStates.get('2').localRevision = 'new'
  expect(line.snapshot().alerts[0].recommendation?.action).toBe('REVALIDATE_EVIDENCE')
  engine.observedStates.get('2').localRevision = 'local'; data.worktrees[1].generation = 'reset'
  expect(line.snapshot().alerts[0].recommendation?.action).toBe('REVALIDATE_EVIDENCE')
  data.worktrees[1].generation = 'g'; line.pause(true)
  expect(line.snapshot().alerts[0].recommendation?.action).toBe('REVALIDATE_EVIDENCE')
  expect(engine.observe).toHaveBeenCalledTimes(calls)
  line.stop()
})
it('budgets each cycle and observes every old worktree without requiring the tab', async () => {
  vi.useFakeTimers()
  const engine = driver(), data = inventory(101)
  data.worktrees[100].creation = { quality: 'ESTIMATED', at: '2026-10-13T00:00:00Z', source: 'ADMIN_DIRECTORY_BIRTHTIME' }
  let now = 1000
  const line = new Workline(async () => data, engine as any, vi.fn(), () => now++)
  line.start()
  for (let i = 0; i < 55; i++) { const calls = engine.observe.mock.calls.length; await line.runOnce(); expect(engine.observe.mock.calls.length - calls).toBeLessThanOrEqual(2) }
  expect(engine.observe.mock.calls[0][0]).toBe('100')
  expect(new Set(engine.observe.mock.calls.map(c => c[0])).size).toBe(101)
  expect(engine.investigate).toHaveBeenCalledWith(1)
  expect(line.snapshot()).toMatchObject({ coverage: 'PARTIAL', known: 101, observed: 101 })
  line.stop()
})
it('keeps alerts stale through drift, pause, removal and late completion', async () => {
  vi.useFakeTimers()
  const engine = driver(), changed = vi.fn(), data = inventory(3)
  const finding = { provider: '1', consumer: '2', providerGeneration: 'g', consumerGeneration: 'g', providerRevision: 'p1', consumerRevision: 'c1', base: 'base', evidence: [{ contractPath: 's.ts', consumerPath: 'c.ts', symbol: 's', contractLine: 1, consumerLine: 2, signature: 'new', previousSignature: 'old', binding: 'RESOLVED_DIRECT' }] }
  engine.investigate.mockResolvedValueOnce([finding])
  let now = 1000
  const line = new Workline(async () => data, engine as any, changed, () => now++)
  line.start(); await line.runOnce()
  const initial = line.snapshot(); expect(initial.alerts[0].state).toBe('CURRENT')
  line.pause(true); expect(line.snapshot().alerts[0].state).toBe('STALE'); expect(initial.alerts[0].state).toBe('CURRENT')
  const calls = engine.observe.mock.calls.length; await line.runOnce(); expect(engine.observe.mock.calls.length).toBe(calls)
  line.pause(false); engine.investigate.mockResolvedValueOnce([finding]); await line.runOnce()
  expect(line.snapshot().alerts).toHaveLength(1)
  engine.observe.mockResolvedValue(true); await line.runOnce(); expect(line.snapshot().alerts[0].state).toBe('STALE')
  let release!: (value: any[]) => void
  engine.investigate.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const pending = line.runOnce(); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const deliveries = changed.mock.calls.length; line.stop(); release([finding]); await pending
  expect(changed.mock.calls.length).toBe(deliveries)
})
it('honors the time budget and leaves explicit pending coverage on failed reads', async () => {
  vi.useFakeTimers()
  const engine = driver(); let now = 1000
  engine.observe.mockImplementation(async () => { now += 6000; throw new Error('GIT_STATE_CHANGED') })
  const line = new Workline(async () => inventory(21), engine as any, vi.fn(), () => now)
  line.start(); await line.runOnce()
  expect(engine.observe).toHaveBeenCalledTimes(1)
  expect(line.snapshot().pending).toHaveLength(21)
  expect(line.snapshot().pending.some(p => p.reason === 'GIT_STATE_CHANGED')).toBe(true)
  line.stop()
})

it('rejects an unavailable reference after inventory refresh instead of reusing its old HEAD', async () => {
  vi.useFakeTimers()
  const data = inventory(3), engine = { ...driver(), observedStates: new Map<string, any>() }
  let now = 1000
  engine.observe.mockImplementation(async id => { if (id === '0') engine.observedStates.set(id, { generation: 'g', head: data.worktrees[0].head }); return false })
  const line = new Workline(async () => data, engine as any, vi.fn(), () => now)
  line.start(); await line.runOnce()
  const calls = engine.observe.mock.calls.length
  data.worktrees[0].head = null; now += line.inventoryCadenceMs
  await line.runOnce()
  expect(engine.observe).toHaveBeenCalledTimes(calls)
  expect(line.snapshot().coverage).toBe('UNAVAILABLE')
  line.stop()
})

it('restarts with a fresh inventory and no previous observation claims', async () => {
  vi.useFakeTimers()
  const engine = driver(), load = vi.fn(async () => inventory(3)), line = new Workline(load, engine as any, vi.fn(), () => 1000)
  line.start(); await line.runOnce(); line.stop(); line.start()
  expect(line.snapshot()).toMatchObject({ known: 0, observed: 0, coverage: 'PENDING' })
  await line.runOnce(); expect(load).toHaveBeenCalledTimes(2); expect(engine.invalidate).toHaveBeenCalled()
  line.stop()
})
