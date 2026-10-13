// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkOrchestrationTab } from './WorkOrchestrationTab'
import { orderWorktrees } from './WorkOrchestrationView'
import { LocalChangesInspector } from './LocalChangesInspector'
import type { ObservableWorktree, OrchestrationOverview, OrchestrationRequest, OrchestrationResult, OrchestrationData } from '../../../../shared/types/work-orchestration-types'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const state = { project: { id: 'a', path: '/a', name: 'A' }, revision: 1 }
const tree = (i: number): ObservableWorktree => ({ worktreeId: i.toString(16).padStart(64, '0'), generation: 'g1', path: `/repository/tree-${i}`, branch: i ? `work-${i.toString().padStart(3, '0')}` : 'zzz-reference', head: 'a'.repeat(40), detached: false, locked: false, missing: false, prunable: false, reference: i === 0, snapshot: null, observation: 'NOT_OBSERVED', stagedCount: null, unstagedCount: null, untrackedCount: null, conflictCount: null, reason: null })
const inventory = (count = 21): OrchestrationOverview => ({ repositoryId: 'repo', worktrees: Array.from({ length: count }, (_, i) => tree(i)), pairs: [], inventoryCoverage: 'COMPLETE', relationsCoverage: 'NOT_EVALUATED', observedAt: '2026-10-13T04:00:00Z', revision: 'r1' })
const success = (data: OrchestrationData, context = { projectId: 'a', revision: 1 }): OrchestrationResult<OrchestrationData> => ({ success: true, context, data })
const observe = (w: ObservableWorktree) => success({ repositoryId: 'repo', observedAt: 'now', worktree: { ...w, observation: 'VERIFIED', stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictCount: 0, snapshot: { head: w.head, branch: w.branch, operation: null, indexRevision: 'i', worktreeRevision: 'w' } } })
const install = (read: ReturnType<typeof vi.fn>) => { window.codeAwareness = { getWorkOrchestration: read, mutateGitManagement: vi.fn() } as any }
it('discards an old detail page after the selected snapshot changes', async () => {
  const selected: ObservableWorktree = { ...tree(1), observation: 'VERIFIED', snapshotRevision: 'a'.repeat(64) }
  let finish!: (value: OrchestrationResult<OrchestrationData>) => void
  const data = (snapshotRevision: string, path: string) => success({ repositoryId: 'repo', worktreeId: selected.worktreeId, generation: selected.generation,
    snapshotRevision, changes: [{ path, stagedState: 'A', unstagedState: null, untracked: false, deleted: false, renamed: false, conflicted: false }], totalCount: 1, revision: 'page', nextCursor: null })
  const query = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(data('b'.repeat(64), 'current.txt'))
  const view = render(<LocalChangesInspector tree={selected} query={query} revalidate={vi.fn()} stale={vi.fn()} />)
  view.rerender(<LocalChangesInspector tree={{ ...selected, snapshotRevision: 'b'.repeat(64) }} query={query} revalidate={vi.fn()} stale={vi.fn()} />)
  await screen.findByText('current.txt')
  finish(data('a'.repeat(64), 'old.txt'))
  await waitFor(() => expect(screen.queryByText('old.txt')).toBeNull())
})

it('marks failed details stale, allows revalidation and restores the original row focus after closing', async () => {
  let detailReads = 0
  const read = vi.fn(async (request: OrchestrationRequest) => {
    if (request.worktree) {
      const observed = observe(tree(1))
      if (observed.success && 'worktree' in observed.data) observed.data.worktree.snapshotRevision = 'a'.repeat(64)
      return observed
    }
    if (request.changes) return ++detailReads === 1 ? { success: false, code: 'GIT_STATE_CHANGED' } : success({ repositoryId: 'repo', worktreeId: tree(1).worktreeId,
      generation: 'g1', snapshotRevision: 'a'.repeat(64), changes: [], totalCount: 0, revision: 'page', nextCursor: null })
    return success(inventory())
  })
  install(read); render(<WorkOrchestrationTab state={state} active />)
  await screen.findByText('Inventory complete · 21 discovered')
  const row = screen.getByText('work-001').closest('button')!
  row.focus(); fireEvent.click(row)
  await screen.findByText(/Stale or unavailable/)
  expect(screen.getByText('Revalidate worktree').hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByText('Revalidate worktree'))
  await screen.findByText('0 matching paths · page 1')
  fireEvent.keyDown(screen.getByLabelText('Worktree inspector'), { key: 'Escape' })
  expect(document.activeElement).toBe(row)
})
it('observes only visible rows, bounds concurrency and pauses without extra reads on returning to cached rows', async () => {
  let notify!: IntersectionObserverCallback
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { notify = callback }
    observe() {}
    disconnect() {}
  })
  const resolves = new Map<string, (value: OrchestrationResult<OrchestrationData>) => void>()
  const read = vi.fn((request: OrchestrationRequest) => request.worktree ? new Promise(resolve => resolves.set(request.worktree!.worktreeId, resolve)) : Promise.resolve(success(inventory())))
  install(read)
  const view = render(<WorkOrchestrationTab state={state} active />)
  await screen.findByText('Inventory complete · 21 discovered')
  const rows = [...document.querySelectorAll('.wo-tree')]
  notify(rows.slice(0, 4).map(target => ({ target, isIntersecting: true })) as IntersectionObserverEntry[], {} as IntersectionObserver)
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  resolves.get(tree(0).worktreeId)!(observe(tree(0)))
  await waitFor(() => expect(read).toHaveBeenCalledTimes(4))
  view.rerender(<WorkOrchestrationTab state={state} active={false} />)
  resolves.get(tree(1).worktreeId)!(observe(tree(1)))
  resolves.get(tree(2).worktreeId)!(observe(tree(2)))
  await waitFor(() => expect(document.querySelector('.wo-tree')?.textContent).toContain('Last known'))
  expect(read).toHaveBeenCalledTimes(4)
  view.rerender(<WorkOrchestrationTab state={state} active />)
  notify(rows.slice(0, 3).map(target => ({ target, isIntersecting: true })) as IntersectionObserverEntry[], {} as IntersectionObserver)
  expect(read).toHaveBeenCalledTimes(4)
})
it('lazily mounts once under StrictMode, restores filter/selection and performs zero reads on tab toggles', async () => {
  const read = vi.fn(async (request: OrchestrationRequest) => request.worktree ? observe(tree(1)) : success(inventory()))
  install(read)
  const view = render(<React.StrictMode><WorkOrchestrationTab state={state} active={false} /></React.StrictMode>)
  expect(read).not.toHaveBeenCalled()
  view.rerender(<React.StrictMode><WorkOrchestrationTab state={state} active /></React.StrictMode>)
  await screen.findByText('Inventory complete · 21 discovered')
  expect(read).toHaveBeenCalledTimes(1)
  expect(screen.queryByText(/Locally clean/)).toBeNull()
  fireEvent.change(screen.getByLabelText('Filter worktrees'), { target: { value: 'work-001' } })
  fireEvent.click(screen.getByText('work-001'))
  await screen.findByText('Last status observation')
  expect(read).toHaveBeenCalledTimes(2)
  for (let i = 0; i < 3; i++) {
    view.rerender(<React.StrictMode><WorkOrchestrationTab state={state} active={false} /></React.StrictMode>)
    expect(view.container.querySelector('.wo-tab')?.hasAttribute('hidden')).toBe(true)
    view.rerender(<React.StrictMode><WorkOrchestrationTab state={state} active /></React.StrictMode>)
  }
  expect(read).toHaveBeenCalledTimes(2)
  expect((screen.getByLabelText('Filter worktrees') as HTMLInputElement).value).toBe('work-001')
  expect(screen.getByLabelText('Worktree inspector')).not.toBeNull()
  expect(screen.queryByText(/Git Management/)).toBeNull()
})
it('retains old content on refresh failure and clears a replaced selection after explicit refresh', async () => {
  let finish!: (value: OrchestrationResult<OrchestrationData>) => void
  let inventories = 0
  const read = vi.fn((request: OrchestrationRequest) => request.worktree ? Promise.resolve(observe(tree(1))) : ++inventories === 1 ? Promise.resolve(success(inventory())) : new Promise(resolve => { finish = resolve }))
  install(read)
  render(<WorkOrchestrationTab state={state} active />)
  await screen.findByText('Inventory complete · 21 discovered')
  fireEvent.click(screen.getByText('work-001')); await screen.findByText('Last status observation')
  fireEvent.click(screen.getByText('Refresh'))
  expect(screen.getByText(/displaying the previous observation/)).not.toBeNull()
  expect(document.querySelectorAll('.wo-tree')).toHaveLength(21)
  finish({ success: false, code: 'GIT_READ_UNAVAILABLE' })
  await screen.findByText(/Last inventory observation.*Not revalidated/)
  expect(screen.getByLabelText('Worktree inspector')).not.toBeNull()
  fireEvent.click(screen.getByText('Refresh'))
  const data = inventory(); data.worktrees[1].generation = 'replacement'
  finish(success(data))
  await screen.findByText(/removed or replaced/)
  expect(screen.queryByLabelText('Worktree inspector')).toBeNull()
})
it('discards a delayed inventory after a project/revision change', async () => {
  let finish!: (value: OrchestrationResult<OrchestrationData>) => void
  const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(success(inventory(1), { projectId: 'b', revision: 2 }))
  install(read)
  const view = render(<WorkOrchestrationTab key="a:1" state={state} active />)
  view.rerender(<WorkOrchestrationTab key="b:2" state={{ project: { id: 'b', path: '/b', name: 'B' }, revision: 2 }} active />)
  await screen.findByText('Inventory complete · 1 discovered')
  finish(success(inventory(21)))
  await waitFor(() => expect(document.querySelectorAll('.wo-tree')).toHaveLength(1))
  expect(read.mock.calls[1][0].context).toEqual({ projectId: 'b', revision: 2 })
})
it('deduplicates concurrent selected inspections without observing the other records', async () => {
  let finish!: (value: OrchestrationResult<OrchestrationData>) => void
  const read = vi.fn((request: OrchestrationRequest) => request.worktree ? new Promise(resolve => { finish = resolve }) : Promise.resolve(success(inventory(101))))
  install(read)
  render(<WorkOrchestrationTab state={state} active />)
  await screen.findByText('Inventory complete · 101 discovered')
  const row = screen.getByText('work-001')
  fireEvent.click(row); fireEvent.click(row)
  expect(read).toHaveBeenCalledTimes(2)
  finish(observe(tree(1))); await screen.findByText('Last status observation')
  expect(document.querySelectorAll('.wo-tree')).toHaveLength(101)
  fireEvent.change(screen.getByLabelText('Filter worktrees'), { target: { value: 'work-100' } })
  expect(document.querySelectorAll('.wo-tree')).toHaveLength(1)
  expect(screen.getByText('work-100')).not.toBeNull()
})
it('sorts the reference by identity, then branches and detached paths deterministically', () => {
  const a = tree(1), b = { ...tree(2), branch: null, detached: true }, reference = tree(0)
  expect(orderWorktrees([a, b, reference])).toEqual([reference, b, a])
  expect(orderWorktrees([reference, b, a])).toEqual([reference, b, a])
})

it('marks both the pair evidence and relationship signals stale after failed revalidation', async () => {
  let inventories = 0
  const read = vi.fn(async (request: OrchestrationRequest) => {
    if (request.worktree) return observe(tree(1))
    if (request.pair) return success({ repositoryId: 'repo', left: tree(1), right: tree(0), base: 'a'.repeat(40), category: 'NO_PATH_OVERLAP', reason: null, totalPaths: 0, paths: [], revision: 'r-pair', nextCursor: null })
    return ++inventories === 1 ? success(inventory()) : { success: false, code: 'GIT_READ_UNAVAILABLE' }
  })
  install(read)
  render(<WorkOrchestrationTab state={state} active />)
  await screen.findByText('Inventory complete · 21 discovered')
  fireEvent.click(screen.getByText('work-001')); await screen.findByText('Last status observation')
  fireEvent.change(screen.getByLabelText('Compare with worktree'), { target: { value: tree(0).worktreeId } })
  fireEvent.click(screen.getByText('Compare')); await screen.findByText('No path overlap verified')
  fireEvent.click(screen.getByText('Refresh'))
  await screen.findByText(/Relationships stale/)
  expect(document.querySelector('.wo-pair')?.textContent).toContain('Stale observation')
  expect(screen.queryByText('No path overlap verified')).toBeNull()
})
