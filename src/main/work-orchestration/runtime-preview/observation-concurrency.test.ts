import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { RuntimePreviewRunner } from './runner'

const observed = vi.hoisted(() => ({ callbacks: [] as Array<(event: string, file?: string) => void>, watchers: [] as any[] }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>(), { EventEmitter } = await import('node:events')
  return { ...actual, watch: vi.fn((_root: unknown, _options: unknown, callback: (event: string, file?: string) => void) => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() })
    observed.callbacks.push(callback); observed.watchers.push(watcher); return watcher
  }) }
})
beforeEach(() => { vi.useFakeTimers(); observed.callbacks.length = 0; observed.watchers.length = 0 })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })
async function fixture(visible = false) {
  const id = randomUUID(), policy = { idleMs: 60000, maxPrivateBytes: 2147483648, maxWorkingSetBytes: 2147483648, maxCpuPercent: 5, minAvailableBytes: 0, sampleMs: 5000 }
  let record: any = { sessionId: id, operationId: randomUUID(), selection: {}, revision: 0, at: new Date().toISOString(), resourceInventory: [],
    state: 'RUNNING', resources: 'RESERVED', readiness: 'READY', attestation: { artifact: 'VERIFIED', loadedCode: 'VERIFIED' },
    standby: { state: visible ? 'RUNNING' : 'QUIESCENT', policy, expiresAt: new Date(Date.now() + 60000).toISOString() } }
  const store = { read: vi.fn(() => record), append: vi.fn((next: any) => { record = next }) }
  const runner = new RuntimePreviewRunner(store as any, {} as any, {} as any)
  const verify = vi.fn(async (_paths: string[]) => {}), identity = { epoch: 0, state: 'CURRENT', assertCurrent: vi.fn(async () => {}), close: vi.fn() }
  const corpus = { epoch: 0, state: 'CURRENT', assertCurrent: vi.fn(async () => {}), close: vi.fn() }
  let gitEvent!: (event: any) => void
  const owner = { available: true }, adapter = { control: vi.fn(async (_action: string) => {
    const now = process.hrtime.bigint().toString(); return { showNs: now, functionalNs: now, focusedNs: now }
  }), observe: vi.fn(async () => ({ readiness: 'READY', attestation: { artifact: 'VERIFIED', loadedCode: 'VERIFIED' } })) }
  const r = runner as any
  r.owners.set(id, owner); r.adapters.set(id, adapter)
  vi.spyOn(r, 'sampleSlot').mockResolvedValue({ privateBytes: 1, workingSetBytes: 1, availableBytes: 2 ** 30, intervalMs: 0, cpuPercent: 0 })
  const evict = vi.spyOn(runner, 'evict').mockImplementation(async () => record)
  await r.monitorSlot(id, 'controlled-worktree', async () => {}, { command: { inputs: [] }, dependencies: { materialization: 'deps.json' } },
    async () => {}, async (paths: string[]) => new Set(paths), async (sink: any) => { gitEvent = sink; return identity }, corpus, verify)
  const slot = r.slots.get(id); if (slot.timer) clearTimeout(slot.timer)
  return { runner, id, slot, verify, identity, corpus, adapter, evict, store, r,
    event: (file?: string) => observed.callbacks[0]('change', file), gitEvent: () => gitEvent({ origin: 'GIT', event: 'change', path: 'git/index', epoch: ++identity.epoch }) }
}
describe('observer coordination before SHOW and QUIESCENT, without Electron', () => {
  it('preserves the same slot after an inoffensive event and writes bounded evidence only in the receipt', async () => {
    const f = await fixture(); f.event('derived/output.js')
    const result = await f.runner.present(f.id)
    expect(result.sessionId).toBe(f.id); expect(result.standby?.state).toBe('RUNNING')
    expect(result.standby?.observations).toMatchObject({ state: 'CURRENT', events: expect.arrayContaining([expect.objectContaining({ origin: 'SOURCE', decision: 'NO_CHANGE' })]) })
    expect(f.adapter.control).toHaveBeenCalledOnce(); expect(f.evict).not.toHaveBeenCalled()
  })
  it('rechecks an epoch that changes while source materiality is being verified', async () => {
    const f = await fixture(); f.event('derived/first.js')
    f.verify.mockImplementationOnce(async () => { f.event('derived/second.js') })
    await f.runner.present(f.id)
    expect(f.verify).toHaveBeenCalledTimes(2); expect(f.identity.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(f.adapter.control).toHaveBeenCalledOnce()
  })
  it('rejects a material event received during the awaited resource sample before SHOW', async () => {
    const f = await fixture()
    f.r.sampleSlot.mockImplementationOnce(async () => { f.event('src/changed.ts'); return { privateBytes: 1, workingSetBytes: 1, availableBytes: 2 ** 30, intervalMs: 0, cpuPercent: 0 } })
    f.verify.mockRejectedValue(new Error('PREPARED_SOURCE_BYTES_CHANGED'))
    await expect(f.runner.present(f.id)).rejects.toThrow('PREPARED_SOURCE_BYTES_CHANGED')
    expect(f.adapter.control).not.toHaveBeenCalled(); expect(f.evict).toHaveBeenCalledWith(f.id, 'PREPARED_SOURCE_BYTES_CHANGED')
  })
  it('does not return READY when an event becomes material during SHOW', async () => {
    const f = await fixture(), control = f.adapter.control.getMockImplementation()!
    f.adapter.control.mockImplementationOnce(async action => { f.event('src/changed.ts'); return control(action) })
    f.verify.mockRejectedValue(new Error('PREPARED_SOURCE_BYTES_CHANGED'))
    await expect(f.runner.present(f.id)).rejects.toThrow('PREPARED_SOURCE_BYTES_CHANGED')
    expect(f.slot.observations().state).toBe('INVALID'); expect(f.store.read().standby.observations.state).toBe('INVALID'); expect(f.evict).toHaveBeenCalledOnce()
  })
  it.each(['distinct paths', 'event storm', 'unknown path', 'absolute path', 'watcher error', 'watcher closed'])('fails closed on %s', async kind => {
    const f = await fixture()
    if (kind === 'distinct paths') for (let i = 0; i < 257; i++) f.event('derived/' + i)
    if (kind === 'event storm') for (let i = 0; i < 1025; i++) f.event('derived/same')
    if (kind === 'unknown path') f.event()
    if (kind === 'absolute path') f.event('C:/private/token')
    if (kind === 'watcher error') observed.watchers[0].emit('error', new Error('lost'))
    if (kind === 'watcher closed') observed.watchers[0].emit('close')
    await expect(f.runner.present(f.id)).rejects.toThrow('PREPARED_OBSERVATION_COVERAGE_LOST')
    const evidence = f.slot.observations()
    expect(JSON.stringify(evidence)).not.toContain('C:/private')
    expect(evidence.state).toBe('UNVERIFIABLE'); expect(evidence.events.length).toBeLessThanOrEqual(24)
    expect(f.adapter.control).not.toHaveBeenCalled()
  })
  it('limits a Git notification storm to three checks and never consumes an obsolete proof', async () => {
    const f = await fixture(); f.identity.assertCurrent.mockImplementation(async () => { f.gitEvent() })
    await expect(f.runner.present(f.id)).rejects.toThrow('PREPARED_OBSERVATION_EPOCH_UNSTABLE')
    expect(f.identity.assertCurrent).toHaveBeenCalledTimes(3); expect(f.adapter.control).not.toHaveBeenCalled()
  })
  it('resolves suspicion before returning to QUIESCENT', async () => {
    const f = await fixture(true); f.event('derived/output.js')
    const record = await f.runner.park(f.id)
    expect(record.standby?.state).toBe('QUIESCENT'); expect(f.adapter.control).toHaveBeenCalledWith('QUIESCE', undefined)
  })
  it('does not consume a proof invalidated during the QUIESCE acknowledgement', async () => {
    const f = await fixture(true), control = f.adapter.control.getMockImplementation()!
    f.adapter.control.mockImplementationOnce(async action => { f.event('src/changed.ts'); return control(action) })
    f.verify.mockRejectedValue(new Error('PREPARED_SOURCE_BYTES_CHANGED'))
    await expect(f.runner.park(f.id)).rejects.toThrow('PREPARED_SOURCE_BYTES_CHANGED')
    expect(f.evict).toHaveBeenCalledOnce()
  })
  it('redacts sensitive event paths from the existing runtime evidence', async () => {
    const f = await fixture(); f.event('.env.secret'); f.event('derived/output.js')
    await f.runner.present(f.id)
    const evidence = JSON.stringify(f.slot.observations())
    expect(evidence).not.toContain('.env'); expect(evidence).toContain('UNKNOWN')
  })
})
