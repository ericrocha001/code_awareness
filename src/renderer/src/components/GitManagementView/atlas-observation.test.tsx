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
    getGitManagementCommit: vi.fn().mockResolvedValue(ok({ commit: { ...page.nodes[0], message: 'Known commit' }, base: null, comparison: 'EMPTY_TREE', files: [], nextCursor: null })),
    getGitCommitCorrelation: vi.fn().mockResolvedValue({ success: false, code: 'UNAVAILABLE' })
  }
  window.codeAwareness = api as any
  return api
}

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
  expect(api.getGitAtlasCore.mock.calls.at(-1)?.[0]).toMatchObject({ scope: { kind: 'CHECKOUT' }, window: 'ALL', limit: 100 })
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
