// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GitManagementView } from './GitManagementView'
import type { GitAtlasPage } from '../../../../shared/types/git-atlas-types'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const sha = 'a'.repeat(40), parent = 'b'.repeat(40)
const state: ActiveProjectState = { project: { id: 'p', name: 'Repository', path: '/repo' }, revision: 1 }
const refs = ['trunk', 'topic'].map((name, index) => ({ ref: `refs/heads/${name}`, name, sha: index ? parent : sha, kind: 'LOCAL' as const, upstream: null }))
const page: GitAtlasPage = { snapshot: 'snapshot', nodes: [{ sha, parents: [parent], subject: 'Real change', timestamp: '2026-10-15T12:00:00Z', author: 'Author', decorations: [refs[0]] }], head: sha, branch: 'trunk', refs, pendingParents: [parent], nextCursor: null, queriedAt: '2026-10-16T00:00:00Z', since: '2026-07-18T00:00:00Z', primaryRef: null, detachedHeads: [], detachedCoverage: 'COMPLETE', tags: [], boundary: [parent], coverage: 'COMPLETE_WINDOW' }
const ok = (data: unknown) => ({ success: true, context: { projectId: 'p', revision: 1 }, data })
function setup() {
  const api = {
    getGitAtlas: vi.fn().mockResolvedValue(ok(page)),
    compareGitAtlas: vi.fn().mockResolvedValue(ok({ snapshot: 'snapshot', left: refs[0], right: refs[1], mergeBases: [parent], leftOnly: 1, rightOnly: 0, exclusive: { left: [sha], right: [], complete: true } })),
    getGitManagementOverview: vi.fn().mockResolvedValue(ok({ state: { head: sha, branch: 'trunk', operation: null, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictCount: 0 }, changes: [] })),
    getGitManagementCommit: vi.fn().mockResolvedValue(ok({ commit: page.nodes[0], base: parent, comparison: 'PARENT', files: [], nextCursor: null })),
    getGitCommitCorrelation: vi.fn()
  }
  window.codeAwareness = api as any
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  return api
}

it('queries temporal windows and requires an explicit base instead of assuming main', async () => {
  const api = setup(); render(<GitManagementView state={state} />)
  await screen.findByRole('button', { name: /Real change/ })
  expect(api.getGitAtlas.mock.calls[0][0]).toMatchObject({ window: 90, context: { projectId: 'p', revision: 1 } })
  fireEvent.click(screen.getByText('30d'))
  await waitFor(() => expect(api.getGitAtlas.mock.calls.at(-1)![0].window).toBe(30))
  fireEvent.click(screen.getByText('Foco'))
  expect((screen.getByLabelText('Referência base') as HTMLSelectElement).value).toBe('')
  fireEvent.change(screen.getByLabelText('Referência em foco'), { target: { value: refs[1].ref } })
  expect(api.compareGitAtlas).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Referência base'), { target: { value: refs[0].ref } })
  await waitFor(() => expect(api.compareGitAtlas).toHaveBeenCalledWith({ context: { projectId: 'p', revision: 1 }, snapshot: 'snapshot', left: refs[0].ref, right: refs[1].ref }))
  await screen.findByText('1 exclusivos da base · 0 exclusivos do alvo')
})

it('inspects out-of-window SHAs without asking current worktrees for fictitious origin', async () => {
  const api = setup(); api.getGitManagementOverview.mockResolvedValue(ok({ state: {}, changes: [] }) as any)
  render(<GitManagementView state={state} />)
  await screen.findByRole('button', { name: /Real change/ })
  fireEvent.change(screen.getByLabelText('SHA completo'), { target: { value: parent } })
  fireEvent.submit(screen.getByLabelText('SHA completo').closest('form')!)
  await screen.findByText('Origem: Não registrada')
  expect(api.getGitManagementCommit).toHaveBeenCalledWith({ context: { projectId: 'p', revision: 1 }, sha: parent })
  expect(api.getGitCommitCorrelation).not.toHaveBeenCalled()
  expect(screen.queryByText(/Worktrees atuais/)).toBeNull()
})

it('discards history completing after a project change and rejects stale pagination visibly', async () => {
  const api = setup(); let complete!: (value: unknown) => void
  api.getGitAtlas.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const view = render(<GitManagementView state={state} />)
  api.getGitAtlas.mockResolvedValue(ok({ ...page, nodes: [], refs: [], head: null }))
  view.rerender(<GitManagementView state={{ ...state, project: { id: 'other', name: 'Other', path: '/other' }, revision: 2 }} />)
  await screen.findByText('Nenhum commit no período selecionado.')
  complete(ok(page))
  await waitFor(() => expect(screen.queryByRole('button', { name: /Real change/ })).toBeNull())
  view.unmount()
  api.getGitAtlas.mockResolvedValueOnce(ok({ ...page, nextCursor: 'cursor', coverage: 'PARTIAL' })).mockResolvedValueOnce({ success: false, code: 'GIT_STATE_CHANGED' })
  render(<GitManagementView state={state} />)
  fireEvent.click(await screen.findByText('Carregar anteriores'))
  await screen.findByText('Histórico desatualizado. Atualize para carregar um novo snapshot.')
  expect((screen.getByText('Carregar anteriores') as HTMLButtonElement).disabled).toBe(true)
})
