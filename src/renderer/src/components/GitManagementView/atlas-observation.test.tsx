// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitManagementView } from './GitManagementView'
import type { GitAtlasPage } from '../../../../shared/types/git-atlas-types'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'

const sha = 'a'.repeat(40)
const state: ActiveProjectState = { project: { id: 'p', name: 'Repository', path: '/repo' }, revision: 1 }
const branch = (name: string) => ({ ref: `refs/heads/${name}`, sha, name, kind: 'LOCAL' as const, upstream: null })
const page: GitAtlasPage = {
  snapshot: 'first', head: sha, branch: 'main', refs: [branch('main')], nodes: [{ sha, parents: [], subject: 'Known commit', timestamp: '2026-10-20T12:00:00Z', author: 'Proof', decorations: [branch('main')] }],
  observation: { referenceFingerprint: 'refs-a', sourceFingerprint: 'source-a' }, worktreeGeneration: 'g', queriedAt: '2026-10-20T15:00:00Z', since: null,
  primaryRef: 'refs/heads/main', detachedHeads: [], detachedCoverage: 'COMPLETE', tags: [], boundary: [], pendingParents: [], nextCursor: null, coverage: 'COMPLETE_WINDOW'
}
const ok = (data: unknown) => ({ success: true, context: { projectId: 'p', revision: 1 }, data })
const core = (git: GitAtlasPage) => ({ phase: 'CORE', git, gitSnapshot: git.snapshot, worktreeGeneration: 'g', repositoryId: 'repo', worktreeId: 'tree', checkout: { head: sha, ref: 'refs/heads/main', detached: false, upstream: null, relation: 'UNKNOWN', comparison: null }, worktrees: [], events: [] })
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-20T15:00:00Z'))
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const option = (name: string) => within(screen.getByLabelText('Referência em foco')).getByRole('option', { name })
function setup() {
  const unavailable = { manifest: null, coverage: 'UNKNOWN', acquired: 0, diagnostic: { state: 'UNAVAILABLE', reason: 'SQLITE_UNAVAILABLE' }, reason: 'SQLITE_UNAVAILABLE' }
  const api = {
    getGitAtlasCore: vi.fn().mockResolvedValue(ok(core(page))),
    getGitAtlasCheckoutState: vi.fn().mockResolvedValue(ok({ head: sha, branch: 'main', operation: null, ...page.observation })),
    getGitAtlasCatalog: vi.fn().mockResolvedValue(ok(unavailable)),
    stopGitAtlasCollection: vi.fn().mockResolvedValue(ok(null)), onGitAtlasCatalogChanged: vi.fn(() => () => {}),
    getGitAtlasPrEvidence: vi.fn().mockResolvedValue({ success: false, code: 'UNAVAILABLE' }),
    compareGitAtlas: vi.fn().mockResolvedValue({ success: false, code: 'UNAVAILABLE' }),
    getGitManagementOverview: vi.fn().mockResolvedValue(ok({ state: { head: sha, branch: 'main', operation: null }, changes: [] })),
    getGitCheckoutSynchronization: vi.fn().mockResolvedValue({ success: false, code: 'UNAVAILABLE' }),
    getGitManagementCommit: vi.fn().mockResolvedValue(ok({ commit: { ...page.nodes[0], message: 'Known commit' }, base: null, comparison: 'EMPTY_TREE', files: [], nextCursor: null })),
    getGitCommitCorrelation: vi.fn().mockResolvedValue({ success: false, code: 'UNAVAILABLE' })
  }
  window.codeAwareness = api as any
  return api
}

it('revisits PR evidence independently of unchanged Git and shows a later remote event without a fictitious node', async () => {
  const api = setup()
  const evidence = { phase: 'PR_ENRICHMENT', gitSnapshot: page.snapshot, repositoryId: 'repo', worktreeId: 'tree', worktreeGeneration: 'g', coverage: 'COMPLETE', pullRequests: [], events: [] }
  api.getGitAtlasPrEvidence.mockResolvedValue(ok(evidence) as any)
  render(<GitManagementView state={state} />); await tick(1500)
  const reads = api.getGitAtlasCore.mock.calls.length
  api.getGitAtlasPrEvidence.mockResolvedValue(ok({ ...evidence, events: [{ kind: 'PR_CREATED', prNumber: 77, at: '2026-10-21T12:00:00Z', observedAt: '2026-10-21T12:01:00Z', source: 'GITHUB_REST' }] }) as any)
  await tick(60000)
  expect(screen.getByLabelText('Eventos remotos fora do histórico local').textContent).toContain('PR #77 · criado remotamente')
  expect(api.getGitAtlasCore).toHaveBeenCalledTimes(reads)
  expect(document.querySelectorAll('.gm-atlas-node')).toHaveLength(1)
})

it('keeps a larger remote catalog in a bounded disclosure while surfacing its latest event', async () => {
  const api = setup()
  const events = Array.from({ length: 40 }, (_, index) => ({ kind: 'PR_CREATED', prNumber: index + 1, at: new Date(Date.UTC(2026, 10, index + 1)).toISOString(), observedAt: '2026-12-11T12:00:00Z' }))
  api.getGitAtlasPrEvidence.mockResolvedValue(ok({ phase: 'PR_ENRICHMENT', gitSnapshot: page.snapshot, repositoryId: 'repo', worktreeId: 'tree', worktreeGeneration: 'g', coverage: 'COMPLETE', pullRequests: [], events }) as any)
  render(<GitManagementView state={state} />); await tick(1500)
  const activity = screen.getByLabelText('Eventos remotos fora do histórico local')
  expect(activity.querySelector(':scope > button')?.textContent).toContain('PR #40')
  expect(activity.querySelector('details')?.open).toBe(false)
  expect(activity.querySelector('summary')?.textContent).toContain('Mais 39 eventos')
  expect(document.querySelectorAll('.gm-atlas-node')).toHaveLength(1)
})

it('reconciles fetched tracking once while preserving the live behind observation and checkout marker', async () => {
  const api = setup(), remote = 'b'.repeat(40)
  const local = { ...branch('main'), upstream: 'origin/main' }
  const tracking = { ...branch('origin/main'), ref: 'refs/remotes/origin/main', kind: 'REMOTE' as const, upstream: null }
  const initial = { ...page, refs: [local, tracking] } as GitAtlasPage
  const delivered = (git: GitAtlasPage) => ({ ...core(git), checkout: { ...core(git).checkout, upstream: 'origin/main' } })
  api.getGitAtlasCore.mockResolvedValue(ok(delivered(initial)))
  const sync = (head: string, behind: number) => ok({ state: { head: sha, branch: 'main', upstream: 'origin/main' }, evidence: { status: 'VERIFIED', remote: 'origin', ref: 'refs/heads/main', remoteHead: head, trackingHead: head, tracking: 'TRACKING_CURRENT', relationship: behind ? 'BEHIND' : 'IN_SYNC', remoteCounts: { ahead: 0, behind }, observedAt: new Date().toISOString() }, action: null, blockedReason: null })
  api.getGitCheckoutSynchronization.mockResolvedValue(sync(sha, 0) as any)
  render(<GitManagementView state={state} />); await tick(1500)
  const reads = api.getGitAtlasCore.mock.calls.length
  const changed = { ...initial, snapshot: 'new', refs: [local, { ...tracking, sha: remote }], nodes: [...initial.nodes, { ...initial.nodes[0], sha: remote, subject: 'External merge', parents: [sha] }] }
  api.getGitAtlasCore.mockResolvedValue(ok(delivered(changed)))
  api.getGitCheckoutSynchronization.mockResolvedValue(sync(remote, 1) as any)
  fireEvent.focus(window); await tick(1500)
  expect(api.getGitAtlasCore).toHaveBeenCalledTimes(reads + 1)
  expect(document.querySelector('.gm-checkout-sync')?.textContent).toContain('1 commit atrás')
  expect(document.querySelectorAll('.gm-checkout-marker')).toHaveLength(1)
  expect(screen.getByRole('button', { name: /External merge/ })).toBeTruthy()
})

it('keeps the delivered revision stable without SQLite and reconciles two decorations at the same SHA once', async () => {
  const api = setup(); render(<GitManagementView state={state} />); await tick(1500)
  await tick(100)
  expect(option('main')).toBeTruthy()
  const initial = { core: api.getGitAtlasCore.mock.calls.length, pr: api.getGitAtlasPrEvidence.mock.calls.length, overview: api.getGitManagementOverview.mock.calls.length }
  await tick(12000)
  expect(api.getGitAtlasCore).toHaveBeenCalledTimes(initial.core)
  expect(api.getGitAtlasPrEvidence).toHaveBeenCalledTimes(initial.pr)
  expect(api.getGitManagementOverview).toHaveBeenCalledTimes(initial.overview)
  const updated = { ...page, snapshot: 'second', observation: { referenceFingerprint: 'refs-b', sourceFingerprint: 'source-b' }, refs: [...page.refs, branch('external-a'), branch('external-b')] }
  api.getGitAtlasCheckoutState.mockResolvedValue(ok({ head: sha, branch: 'main', operation: null, ...updated.observation }))
  api.getGitAtlasCore.mockResolvedValue(ok(core(updated)))
  await tick(2000); await tick(2000)
  expect(option('external-a')).toBeTruthy()
  expect(option('external-b')).toBeTruthy()
  expect(api.getGitAtlasCore).toHaveBeenCalledTimes(initial.core + 1)
  expect(api.getGitAtlasCore.mock.calls.at(-1)?.[0]).toMatchObject({ scope: { kind: 'ALL_REFS' }, window: 'ALL', limit: 100 })
  expect(api.getGitAtlasCore.mock.calls.at(-1)?.[0].refresh).toBeUndefined()
  await tick(12000)
  expect(api.getGitAtlasCore).toHaveBeenCalledTimes(initial.core + 1)
})

it('preserves a selected branch and clears only a deleted reference after reconciliation', async () => {
  const api = setup(); render(<GitManagementView state={state} />); await tick(1500)
  api.getGitManagementCommit.mockResolvedValue({ success: false, code: 'UNAVAILABLE' })
  fireEvent.change(screen.getByLabelText('Referência em foco'), { target: { value: 'refs/heads/main' } })
  await tick(1000)
  expect((screen.getByLabelText('Referência em foco') as HTMLSelectElement).value).toBe('refs/heads/main')
  const updated = { ...page, snapshot: 'second', observation: { referenceFingerprint: 'refs-b', sourceFingerprint: 'source-b' }, refs: [...page.refs, branch('external')] }
  api.getGitAtlasCheckoutState.mockResolvedValue(ok({ head: sha, branch: 'main', operation: null, ...updated.observation }))
  api.getGitAtlasCore.mockResolvedValue(ok(core(updated)))
  await tick(4000)
  expect((screen.getByLabelText('Referência em foco') as HTMLSelectElement).value).toBe('refs/heads/main')
  const removed = { ...updated, snapshot: 'third', refs: [branch('external')], observation: { referenceFingerprint: 'refs-c', sourceFingerprint: 'source-c' } }
  api.getGitAtlasCheckoutState.mockResolvedValue(ok({ head: sha, branch: 'main', operation: null, ...removed.observation }))
  api.getGitAtlasCore.mockResolvedValue(ok(core(removed)))
  await tick(4000)
  expect((screen.getByLabelText('Referência em foco') as HTMLSelectElement).value).toBe('')
  expect(option('external')).toBeTruthy()
})

it('finishes a remounted loading generation under StrictMode and preserves enrichment on an unchanged refresh', async () => {
  const api = setup()
  api.getGitAtlasPrEvidence.mockResolvedValue(ok({ phase: 'PR_ENRICHMENT', gitSnapshot: page.snapshot, repositoryId: 'repo', worktreeId: 'tree', worktreeGeneration: 'g', coverage: 'COMPLETE', pullRequests: [], events: [] }) as any)
  render(<React.StrictMode><GitManagementView state={state} /></React.StrictMode>)
  await tick(1500)
  expect(document.querySelector('.gm-history')?.getAttribute('aria-busy')).toBe('false')
  const requests = api.getGitAtlasPrEvidence.mock.calls.length
  fireEvent.change(screen.getByLabelText('Referência em foco'), { target: { value: 'refs/heads/main' } })
  await tick(100)
  fireEvent.click(screen.getByLabelText('Atualizar Git'))
  await tick(1000)
  expect(api.getGitAtlasPrEvidence).toHaveBeenCalledTimes(requests)
  expect((screen.getByLabelText('Referência em foco') as HTMLSelectElement).value).toBe('refs/heads/main')
  expect(document.querySelector('.gm-history')?.getAttribute('aria-busy')).toBe('false')
})
