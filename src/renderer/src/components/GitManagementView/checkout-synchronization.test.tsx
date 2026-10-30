// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitManagementView } from './GitManagementView'
import { useCheckoutSynchronization } from './useCheckoutSynchronization'
import { CheckoutSynchronization } from './CheckoutSynchronization'
import type { GitCheckoutSynchronization } from '../../../../shared/types/git-management-types'

const sha = 'a'.repeat(40), remote = 'b'.repeat(40)
const context = { projectId: 'p', revision: 1 }
const project = { project: { id: 'p', name: 'Repository', path: '/repo' }, revision: 1 }
const ref = { ref: 'refs/heads/topic', sha, name: 'topic', kind: 'LOCAL', upstream: 'origin/topic' }
const page = { snapshot: 'snapshot', head: sha, branch: 'topic', refs: [ref], nodes: [{ sha, parents: [], subject: 'Known commit', timestamp: '2026-10-29T12:00:00Z', author: 'Proof', decorations: [ref] }],
  observation: { referenceFingerprint: 'refs', sourceFingerprint: 'source' }, worktreeGeneration: 'g', queriedAt: '2026-10-29T15:00:00Z', since: null, primaryRef: ref.ref, detachedHeads: [], detachedCoverage: 'COMPLETE', tags: [], boundary: [], pendingParents: [], nextCursor: null, coverage: 'COMPLETE_WINDOW' }
const state = { head: sha, branch: 'topic', upstream: 'origin/topic', dirty: false, ahead: 0, behind: 1, operation: null, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictCount: 0, indexRevision: 'c'.repeat(64), worktreeRevision: 'd'.repeat(64) }
const synchronization: GitCheckoutSynchronization = { state, evidence: { status: 'VERIFIED', source: 'GIT_LS_REMOTE', localHead: sha, remoteHead: remote, trackingHead: remote, remote: 'origin', ref: 'refs/heads/topic', observedAt: '2026-10-29T15:00:00Z', relationship: 'BEHIND', tracking: 'TRACKING_CURRENT', remoteCounts: { ahead: 0, behind: 1 } }, action: 'PULL_FF_ONLY', blockedReason: null }
const ok = (data: unknown) => ({ success: true, context, data })
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
})
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function setup(value = synchronization) {
  const api = {
    getGitAtlasCore: vi.fn().mockResolvedValue(ok({ phase: 'CORE', git: page, gitSnapshot: 'snapshot', worktreeGeneration: 'g', repositoryId: 'repo', worktreeId: 'tree', checkout: { head: sha, ref: ref.ref, detached: false, upstream: ref.upstream, relation: 'UNKNOWN', comparison: null }, worktrees: [], events: [] })),
    getGitAtlasCheckoutState: vi.fn().mockResolvedValue(ok({ head: sha, branch: 'topic', operation: null, ...page.observation })),
    getGitAtlasCatalog: vi.fn().mockResolvedValue({ success: false, code: 'UNAVAILABLE' }),
    stopGitAtlasCollection: vi.fn().mockResolvedValue(ok(null)), onGitAtlasCatalogChanged: vi.fn(() => () => {}),
    getGitAtlasPrEvidence: vi.fn().mockResolvedValue({ success: false, code: 'UNAVAILABLE' }),
    compareGitAtlas: vi.fn().mockResolvedValue(ok({ snapshot: 'snapshot', left: { ref: remote, sha: remote }, right: { ref: sha, sha }, mergeBases: [remote], leftOnly: 1, rightOnly: 1, exclusive: { left: [], right: [], complete: true } })),
    getGitManagementOverview: vi.fn().mockResolvedValue(ok({ state, changes: [] })),
    getGitCheckoutSynchronization: vi.fn().mockResolvedValue(ok(value)),
    mutateGitManagement: vi.fn().mockResolvedValue(ok({ value: {} })),
    getGitManagementCommit: vi.fn().mockResolvedValue(ok({ commit: { ...page.nodes[0], message: 'Known commit' }, base: null, comparison: 'EMPTY_TREE', files: [], nextCursor: null })),
    getGitCommitCorrelation: vi.fn().mockResolvedValue({ success: false, code: 'UNAVAILABLE' })
  }
  window.codeAwareness = api as any
  return api
}

it('opens the existing confirmation from the checkout signal and never probes for node selection or wheel gestures', async () => {
  const api = setup()
  render(<GitManagementView state={project} />)
  const pull = await screen.findByRole('button', { name: 'Atualizar — Pull FF-only…' })
  await waitFor(() => expect(pull.hasAttribute('disabled')).toBe(false))
  const reads = api.getGitCheckoutSynchronization.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: /Known commit/ }))
  fireEvent.wheel(screen.getByLabelText('Mapa Git por eventos; role para explorar'), { deltaX: 40 })
  expect(api.getGitCheckoutSynchronization).toHaveBeenCalledTimes(reads)
  fireEvent.click(pull)
  const dialog = await screen.findByRole('dialog', { name: 'Confirmar operação Git' })
  expect(within(dialog).getByText('Atualizar branch')).toBeTruthy()
  expect(within(dialog).getByText(/Atualizar topic a partir de origin\/topic.*sem criar merge/)).toBeTruthy()
  expect(api.mutateGitManagement).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByText('Confirmar operação'))
  await waitFor(() => expect(api.mutateGitManagement).toHaveBeenCalledTimes(1))
  expect(api.mutateGitManagement.mock.calls[0][0]).toMatchObject({ context, snapshot: state, operation: { action: 'PULL_FF_ONLY', contextual: true }, operationId: expect.any(String) })
  await waitFor(() => expect(api.getGitCheckoutSynchronization).toHaveBeenCalledTimes(reads + 1))
})

it.each(['COMPARE', 'REVIEW_PUBLICATION'] as const)('routes %s through the existing comparison without mutation or quick push', async action => {
  const evidence = { ...synchronization.evidence, relationship: action === 'COMPARE' ? 'DIVERGED' : 'AHEAD', remoteCounts: { ahead: 2, behind: action === 'COMPARE' ? 3 : 0 } } as GitCheckoutSynchronization['evidence']
  const api = setup({ ...synchronization, action, evidence })
  render(<GitManagementView state={project} />)
  fireEvent.click(await screen.findByRole('button', { name: action === 'COMPARE' ? 'Inspecionar divergência' : 'Revisar publicação' }))
  await waitFor(() => expect(api.compareGitAtlas).toHaveBeenCalledWith(expect.objectContaining({ left: remote, right: sha })))
  expect(api.mutateGitManagement).not.toHaveBeenCalled()
  expect(within(document.querySelector('.gm-checkout-sync') as HTMLElement).queryByText(/Publicar.*push/i)).toBeNull()
})

it('recovers a lost contextual response with the same operationId and evidence through GitActions', async () => {
  const api = setup()
  api.mutateGitManagement.mockRejectedValueOnce(new Error('lost response'))
  render(<GitManagementView state={project} />)
  const pull = await screen.findByRole('button', { name: 'Atualizar — Pull FF-only…' })
  await waitFor(() => expect(pull.hasAttribute('disabled')).toBe(false))
  fireEvent.click(pull)
  fireEvent.click(await screen.findByRole('button', { name: 'Confirmar operação' }))
  const recover = await screen.findByRole('button', { name: 'Recuperar mesma operação' })
  await waitFor(() => expect(recover.hasAttribute('disabled')).toBe(false))
  fireEvent.click(recover)
  await waitFor(() => expect(api.mutateGitManagement).toHaveBeenCalledTimes(2))
  expect(api.mutateGitManagement.mock.calls[1][0]).toEqual(api.mutateGitManagement.mock.calls[0][0])
})

it('displays unknown remote counts and a useful reason without borrowing local tracking counts', () => {
  const value = { ...synchronization, evidence: { ...synchronization.evidence, relationship: 'UNKNOWN', tracking: 'TRACKING_STALE', remoteCounts: null }, action: 'FETCH' } as GitCheckoutSynchronization
  render(<CheckoutSynchronization value={value} loading={false} error="" blocked={false} verify={() => {}} act={() => {}} />)
  expect(screen.getByRole('status').textContent).toContain('contagem ainda não verificada')
  expect(screen.queryByText(/1 commits atrás/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Buscar atualizações — Fetch…' })).toBeTruthy()
})

it('coalesces verification and discards a late response after switching project or checkout snapshot', async () => {
  const api = setup(); let first!: (value: unknown) => void
  api.getGitCheckoutSynchronization.mockImplementationOnce(() => new Promise(resolve => { first = resolve }))
  function Probe({ revision }: { revision: number }) {
    const ctx = React.useMemo(() => ({ projectId: revision === 1 ? 'p' : 'other', revision }), [revision])
    const observation = useCheckoutSynchronization(ctx, String(revision))
    return <span>{observation.value?.state.branch ?? 'pending'}</span>
  }
  const view = render(<Probe revision={1} />)
  await waitFor(() => expect(api.getGitCheckoutSynchronization).toHaveBeenCalledTimes(1))
  fireEvent.focus(window)
  expect(api.getGitCheckoutSynchronization).toHaveBeenCalledTimes(1)
  api.getGitCheckoutSynchronization.mockResolvedValue(ok({ ...synchronization, state: { ...state, branch: 'other' } }))
  view.rerender(<Probe revision={2} />)
  await screen.findByText('other')
  await act(async () => first(ok(synchronization)))
  expect(screen.queryByText('topic')).toBeNull()
  expect(screen.getByText('other')).toBeTruthy()
})
