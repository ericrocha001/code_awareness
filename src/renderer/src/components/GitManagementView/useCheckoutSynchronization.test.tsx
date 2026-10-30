// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useCheckoutSynchronization } from './useCheckoutSynchronization'

const context = { projectId: 'p', revision: 1 }
const value = { state: { branch: 'topic' }, evidence: { status: 'VERIFIED' } }
let read: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  read = vi.fn().mockResolvedValue({ success: true, context, data: value })
  window.codeAwareness = { getGitCheckoutSynchronization: read } as any
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

it('verifies every thirty healthy seconds, suspends hidden and defers interaction without reading history', async () => {
  renderHook(() => useCheckoutSynchronization(context, 'snapshot'))
  await tick(0); expect(read).toHaveBeenCalledTimes(1)
  await tick(30000); expect(read).toHaveBeenCalledTimes(2)
  act(() => window.dispatchEvent(new Event('pointerdown')))
  await tick(30000); expect(read).toHaveBeenCalledTimes(2)
  act(() => window.dispatchEvent(new Event('pointerup')))
  await tick(1000); expect(read).toHaveBeenCalledTimes(3)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  await tick(90000); expect(read).toHaveBeenCalledTimes(3)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  await tick(0); expect(read).toHaveBeenCalledTimes(4)
})

it('backs off unavailable observations and ignores hidden responses', async () => {
  read.mockResolvedValue({ success: false, code: 'UNAVAILABLE' })
  const view = renderHook(() => useCheckoutSynchronization(context, 'snapshot'))
  await tick(0); await tick(30000); expect(read).toHaveBeenCalledTimes(1)
  await tick(30000); expect(read).toHaveBeenCalledTimes(2)
  view.unmount(); await tick(240000); expect(read).toHaveBeenCalledTimes(2)
})
