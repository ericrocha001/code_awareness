import { describe, expect, it } from 'vitest'
import { PreviewStartClock, startTimingSchema } from './start-timing'

describe('bounded monotonic startup evidence', () => {
  it('keeps actual dependencies and overlap separate from nested work and human waiting', async () => {
    const clock = new PreviewStartClock()
    await clock.measure('approval', async () => { await Promise.resolve() })
    let release!: () => void
    const context = clock.measure('context', () => new Promise<void>(resolve => { release = resolve }))
    await clock.measure('adapter', async () => { await clock.measure('cache', async () => {}) })
    release(); await context
    await clock.measure('spawn', async () => {})
    clock.presented(process.hrtime.bigint().toString()); clock.ready()
    const result = clock.snapshot()
    const approval = result.phases.find(p => p.stage === 'approval')!, adapter = result.phases.find(p => p.stage === 'adapter')!, provision = result.phases.find(p => p.stage === 'context')!
    expect(adapter.after).toEqual([approval.id]); expect(provision.after).toEqual([approval.id])
    expect(result.phases.find(p => p.stage === 'spawn')?.after.sort()).toEqual([adapter.id, provision.id].sort())
    expect(result.phases.find(p => p.stage === 'cache')?.parent).toBe(adapter.id)
    expect(result.criticalPathMs).toBeLessThanOrEqual(result.totalMs + 1)
    expect(result.technicalMs + result.approvalMs).toBeCloseTo(result.totalMs, 5)
    expect(result.windowMs).toBeLessThanOrEqual(result.readyMs!)
    expect(result.technicalWindowMs).toBeLessThanOrEqual(result.windowMs!)
    expect(result.preparationBeforeRequestMs).toBe(0)
  })
  it('does not invent a window signal, bounds receipts and rejects forged timing values', async () => {
    const clock = new PreviewStartClock()
    for (let index = 0; index < 112; index++) await clock.measure('guard', async () => {})
    const result = clock.snapshot()
    expect(result.phases).toHaveLength(96); expect(result.windowMs).toBeNull(); expect(result.readyMs).toBeNull()
    expect(startTimingSchema.safeParse({ ...result, privatePath: 'forbidden' }).success).toBe(false)
    expect(() => clock.presented('0')).toThrow('WINDOW_TIMING_INVALID')
    expect(() => clock.presented((process.hrtime.bigint() + 1000000000n).toString())).toThrow('WINDOW_TIMING_INVALID')
    expect(() => clock.external('abi', '0', '1', 'abi')).toThrow('BOOTSTRAP_TIMING_INVALID')
  })
  it('records a target probe concurrent with a host guard instead of nesting it in a later host stage', async () => {
    const clock = new PreviewStartClock()
    await clock.measure('spawn', async () => {})
    let start = '', end = ''
    await clock.measure('guard', async () => { start = process.hrtime.bigint().toString(); await Promise.resolve(); end = process.hrtime.bigint().toString() })
    await clock.measure('abi', async () => {})
    clock.external('abi', start, end, 'abi')
    const result = clock.snapshot(), probe = result.phases.at(-1)!, host = result.phases.find(phase => phase.stage === 'abi')!
    expect(probe.parent).toBeNull(); expect(probe.after).toEqual([0]); expect(host.after).toContain(probe.id)
    expect(result.criticalPathMs).toBeLessThanOrEqual(result.totalMs + 1)
  })
})
