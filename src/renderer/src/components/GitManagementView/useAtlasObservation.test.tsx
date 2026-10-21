// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAtlasObservation } from './useAtlasObservation'
import type { GitAtlasPage } from '../../../../shared/types/git-atlas-types'

const context = { projectId: 'p', revision: 1 }
const page = { head: 'a', branch: 'main', observation: { referenceFingerprint: 'refs-a', sourceFingerprint: 'source-a' } } as GitAtlasPage
const data = { head: 'a', branch: 'main', operation: null, referenceFingerprint: 'refs-a', sourceFingerprint: 'source-a' }
const ok = (value = data) => ({ success: true, context, data: value })
let read: ReturnType<typeof vi.fn>, reconcile: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  read = vi.fn().mockResolvedValue(ok()); reconcile = vi.fn().mockResolvedValue(undefined)
  window.codeAwareness = { getGitAtlasCheckoutState: read } as any
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
function setup() {
  return renderHook((props = { context, page, loading: false }) => useAtlasObservation({ ...props, operation: vi.fn(), reconcile }), { initialProps: { context, page, loading: false } })
}

it('continues observing after collection is complete without refreshing unchanged pages', async () => {
  setup(); await tick(60000)
  expect(read.mock.calls.length).toBe(25)
  expect(read.mock.calls.filter(call => call[1] === false)).toHaveLength(3)
  expect(reconcile).not.toHaveBeenCalled()
})

it('reconciles changed refs once and uses the newly delivered baseline', async () => {
  const view = setup(); await tick(0)
  read.mockResolvedValue(ok({ ...data, referenceFingerprint: 'refs-b', sourceFingerprint: 'source-b' }))
  await tick(4000)
  expect(reconcile).toHaveBeenCalledTimes(1)
  view.rerender({ context, page: { ...page, observation: { referenceFingerprint: 'refs-b', sourceFingerprint: 'source-b' } }, loading: false })
  await tick(12000)
  expect(reconcile).toHaveBeenCalledTimes(1)
})

it('compares full worktree changes on focus and coalesces duplicate wake signals', async () => {
  setup(); await tick(0)
  read.mockResolvedValue(ok({ ...data, sourceFingerprint: 'other-worktree' }))
  act(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')) })
  await tick(0)
  expect(reconcile).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledTimes(2)
})

it('suspends while hidden and performs one full check when visible', async () => {
  setup(); await tick(0)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  await tick(60000)
  expect(read).toHaveBeenCalledTimes(1)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  await tick(0)
  expect(read).toHaveBeenLastCalledWith(context, false)
  expect(read).toHaveBeenCalledTimes(2)
})

it('defers scroll and drag work until interaction settles', async () => {
  setup(); await tick(0)
  act(() => window.dispatchEvent(new Event('pointerdown')))
  await tick(12000)
  expect(read).toHaveBeenCalledTimes(1)
  act(() => window.dispatchEvent(new Event('pointerup')))
  await tick(1500)
  expect(read).toHaveBeenCalledTimes(2)
})

it.each(['operation', 'error', 'absent'] as const)('preserves the graph and backs off after %s', async kind => {
  read.mockResolvedValue(kind === 'error' ? { success: false, code: 'GIT_OPERATION_IN_PROGRESS' } : ok({ ...data, referenceFingerprint: kind === 'absent' ? undefined : 'new', operation: kind === 'operation' ? 'MERGE' : null } as any))
  setup(); await tick(4000)
  expect(read).toHaveBeenCalledTimes(1)
  expect(reconcile).not.toHaveBeenCalled()
  read.mockResolvedValue(ok())
  await tick(1000)
  expect(read).toHaveBeenCalledTimes(2)
})

it('never overlaps reads and ignores a response from the previous project', async () => {
  let finish!: (value: unknown) => void
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = setup(); await tick(0)
  act(() => window.dispatchEvent(new Event('focus')))
  await tick(5000)
  expect(read).toHaveBeenCalledTimes(1)
  view.rerender({ context: { projectId: 'next', revision: 2 }, page, loading: false })
  await tick(0)
  finish(ok({ ...data, referenceFingerprint: 'old-context' }))
  await tick(1000)
  expect(reconcile).not.toHaveBeenCalled()
  expect(read).toHaveBeenCalledTimes(2)
})

it('does not race Core pagination and releases timers on unmount', async () => {
  const view = setup(); view.rerender({ context, page, loading: true })
  await tick(12000)
  expect(read).not.toHaveBeenCalled()
  view.rerender({ context, page, loading: false }); await tick(1000)
  expect(read).toHaveBeenCalledTimes(1)
  view.unmount(); await tick(60000)
  expect(read).toHaveBeenCalledTimes(1)
})

it('backs off failed Core reconciliation instead of repeatedly rebuilding the first page', async () => {
  read.mockResolvedValue(ok({ ...data, referenceFingerprint: 'changed' }))
  reconcile.mockResolvedValue(false)
  setup(); await tick(4999)
  expect(reconcile).toHaveBeenCalledTimes(1)
  await tick(1)
  expect(reconcile).toHaveBeenCalledTimes(2)
  await tick(9999)
  expect(reconcile).toHaveBeenCalledTimes(2)
  await tick(1)
  expect(reconcile).toHaveBeenCalledTimes(3)
})
