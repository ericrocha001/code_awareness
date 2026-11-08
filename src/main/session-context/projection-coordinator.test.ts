import { afterEach, expect, it, vi } from 'vitest'
import { SessionProjectionCoordinator } from './projection-coordinator'

afterEach(() => vi.useRealTimers())
const result = (drainable: boolean) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ backlog: { drainable } }) }] })
it('coalesces concurrent changes and drains bounded rounds until the backlog is exhausted', async () => {
  vi.useFakeTimers()
  let release!: (value: ReturnType<typeof result>) => void
  const reconcile = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValue(result(false))
  const coordinator = new SessionProjectionCoordinator(reconcile, () => true)
  coordinator.request(); coordinator.request()
  await vi.advanceTimersByTimeAsync(0)
  expect(reconcile).toHaveBeenCalledTimes(1)
  coordinator.request(); coordinator.request()
  release(result(true))
  await vi.advanceTimersByTimeAsync(50)
  expect(reconcile).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1000)
  expect(reconcile).toHaveBeenCalledTimes(3)
  coordinator.stop()
})
it('does not resume after stop or repository change while a round is still in flight', async () => {
  vi.useFakeTimers()
  let release!: (value: ReturnType<typeof result>) => void, current = true
  const reconcile = vi.fn(() => new Promise<ReturnType<typeof result>>(resolve => { release = resolve }))
  const coordinator = new SessionProjectionCoordinator(reconcile, () => current)
  coordinator.request(); await vi.advanceTimersByTimeAsync(0)
  current = false; coordinator.stop(); release(result(true))
  await vi.advanceTimersByTimeAsync(1000)
  expect(reconcile).toHaveBeenCalledTimes(1)
})
it('uses bounded backoff for failed rounds and waits for another opportunity after the retry budget', async () => {
  vi.useFakeTimers()
  const reconcile = vi.fn().mockRejectedValue(new Error('OFFLINE'))
  const coordinator = new SessionProjectionCoordinator(reconcile, () => true)
  coordinator.request(); await vi.runAllTimersAsync()
  expect(reconcile).toHaveBeenCalledTimes(4)
  expect(vi.getTimerCount()).toBe(0)
  coordinator.stop()
})
