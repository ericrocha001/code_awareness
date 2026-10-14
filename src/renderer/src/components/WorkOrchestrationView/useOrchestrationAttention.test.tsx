// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useOrchestrationAttention } from './useOrchestrationAttention'
import type { OrchestrationAttention, OrchestrationAttentionChange } from '../../../../shared/types/work-orchestration-attention-types'
const attention = (alerts: any[] = []): OrchestrationAttention => ({ repositoryId: 'repo', alerts, coverage: 'PARTIAL', paused: false, known: 4, observed: 2, pending: [], checkedAt: null, cadenceMs: 30000, inventoryCadenceMs: 180000, cycleMs: 1, budget: { observations: 2, pairs: 1, timeMs: 5000, captures: 64, alerts: 64 }, stats: { observations: 2, captures: 1, extractions: 2, bytes: 123, confirmedPairs: 1 } })
const state = (id: string) => ({ project: { id, path: '/' + id, name: id }, revision: 1 })
function Consumer({ id = 'a', active = false }) { const result = useOrchestrationAttention(state(id), active); return <><output aria-label="Novos alertas">{result.unseen}</output><output aria-label="Cobertura">{result.attention?.coverage ?? 'pending'}</output></> }
afterEach(cleanup)
it('receives alerts off-tab, avoids duplicate badges, ignores stale projects and keeps newer events over a delayed initial read', async () => {
  let receive!: (change: OrchestrationAttentionChange) => void, finish!: (value: any) => void
  const unsubscribe = vi.fn(), read = vi.fn(() => new Promise(resolve => { finish = resolve }))
  window.codeAwareness = { getWorkOrchestration: read, onWorkOrchestrationChanged: (callback: typeof receive) => { receive = callback; return unsubscribe } } as any
  const view = render(<Consumer />)
  const alert = { id: 'alert', state: 'CURRENT', providerRevision: 'p', consumerRevision: 'c' }
  act(() => receive({ context: { projectId: 'a', revision: 1 }, attention: attention([alert]) }))
  expect(screen.getByLabelText('Novos alertas').textContent).toBe('1')
  act(() => finish({ success: true, context: { projectId: 'a', revision: 1 }, data: attention() }))
  await waitFor(() => expect(screen.getByLabelText('Novos alertas').textContent).toBe('1'))
  view.rerender(<Consumer active />); view.rerender(<Consumer />)
  expect(screen.getByLabelText('Novos alertas').textContent).toBe('0')
  act(() => receive({ context: { projectId: 'a', revision: 1 }, attention: attention([alert]) }))
  expect(screen.getByLabelText('Novos alertas').textContent).toBe('0')
  const obsolete = receive; view.rerender(<Consumer id="b" />)
  act(() => obsolete({ context: { projectId: 'a', revision: 1 }, attention: attention([alert]) }))
  expect(screen.getByLabelText('Novos alertas').textContent).toBe('0')
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})
