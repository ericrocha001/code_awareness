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
  api.getGitAtlas.mockResolvedValue(ok(page)).mockResolvedValueOnce(ok({ ...page, nextCursor: 'cursor', coverage: 'PARTIAL' })).mockResolvedValueOnce({ success: false, code: 'GIT_STATE_CHANGED' })
  render(<GitManagementView state={state} />)
  await waitFor(() => expect(api.getGitAtlas.mock.calls.filter(([query]) => query.cursor === 'cursor')).toHaveLength(1))
  await screen.findByRole('button', { name: /Real change/ })
  expect(api.getGitAtlas.mock.calls.at(-1)![0].cursor).toBeUndefined()
})

it('renders structured branch details and reads the selected branch tip through the canonical API', async () => {
  const api = setup()
  api.getGitManagementCommit.mockResolvedValue(ok({ commit: { ...page.nodes[0], sha: parent }, base: null, comparison: 'ROOT', files: [], nextCursor: null }))
  render(<GitManagementView state={state} />)
  await screen.findByRole('button', { name: /Real change/ })
  fireEvent.change(screen.getByLabelText('Referência em foco'), { target: { value: refs[1].ref } })
  await screen.findByText('Último commit')
  expect(api.getGitManagementCommit).toHaveBeenCalledWith({ context: { projectId: 'p', revision: 1 }, sha: parent })
  expect(screen.getByRole('button', { name: 'Copiar SHA da branch' })).toBeTruthy()
  expect(screen.getByText('Rastreamento')).toBeTruthy()
  expect(screen.getByText('Author')).toBeTruthy()
})

it('prefetches at most one page while idle and continues only after exploration', async () => {
  const api = setup()
  api.getGitAtlas.mockResolvedValueOnce(ok({ ...page, nextCursor: 'one', coverage: 'PARTIAL' })).mockResolvedValueOnce(ok({ ...page, nextCursor: 'two', coverage: 'PARTIAL' }))
  render(<GitManagementView state={state} />)
  await waitFor(() => expect(api.getGitAtlas).toHaveBeenCalledTimes(2))
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(api.getGitAtlas).toHaveBeenCalledTimes(2)
  expect(screen.getByText('Carregar anteriores')).toBeTruthy()
  fireEvent.wheel(screen.getByLabelText('Mapa temporal Git; role para explorar'), { deltaX: -100 })
  await waitFor(() => expect(api.getGitAtlas).toHaveBeenCalledTimes(3))
  expect(api.getGitAtlas.mock.calls[2][0].cursor).toBe('two')
})

it('renders history before secondary overview finishes and explicit refresh bypasses derived pages', async () => {
  const api = setup()
  api.getGitManagementOverview.mockImplementation(() => new Promise(() => {}))
  render(<GitManagementView state={state} />)
  await screen.findByRole('button', { name: /Real change/ })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Atualizar Git' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar Git' }))
  await waitFor(() => expect(api.getGitAtlas.mock.calls.at(-1)![0].refresh).toBe(true))
})

it('discards a late window response after rapid filter changes', async () => {
  const api = setup(); let finish!: (value: unknown) => void
  render(<GitManagementView state={state} />)
  await screen.findByRole('button', { name: /Real change/ })
  api.getGitAtlas.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(screen.getByText('30d'))
  api.getGitAtlas.mockResolvedValue(ok({ ...page, nodes: [{ ...page.nodes[0], subject: 'Sixty day window' }] }))
  fireEvent.click(screen.getByText('60d'))
  await screen.findByRole('button', { name: /Sixty day window/ })
  finish(ok(page))
  await waitFor(() => expect(screen.queryByRole('button', { name: /Real change/ })).toBeNull())
})

it('preserves the established visual shell and ornaments while using cached reads', async () => {
  const api = setup(); render(<GitManagementView state={state} />)
  await screen.findByRole('button', { name: /Real change/ })
  expect(screen.getByLabelText('Detalhes Git')).toBeTruthy()
  expect(screen.queryByLabelText('Branch do Atlas')).toBeNull()
  expect(screen.getByLabelText('Referência em foco')).toBeTruthy()
  expect(screen.queryByLabelText('Atualizar Atlas')).toBeNull()
  expect(screen.getAllByRole('button', { name: 'Atualizar Git' })).toHaveLength(1)
  expect(screen.getByLabelText('Modo do Atlas')).toBeTruthy()
  expect(document.querySelector('.gm-feature-icon')).toBeTruthy()
  expect(document.querySelector('.gm-atlas-legend')).toBeTruthy()
  expect(document.querySelector('.gm-atlas-lane-label small')?.textContent).toContain('commits neste trecho')
  fireEvent.click(screen.getByText('30d'))
  await waitFor(() => expect(api.getGitAtlas.mock.calls.at(-1)![0].window).toBe(30))
  expect(api.getGitManagementOverview).toHaveBeenCalledTimes(1)
})

it('does not reload selected immutable commit details when overview completes later', async () => {
  const api = setup(); let complete!: (value: unknown) => void
  api.getGitManagementOverview.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  render(<GitManagementView state={state} />)
  fireEvent.click(await screen.findByRole('button', { name: /Real change/ }))
  await screen.findByText('Origem: Não registrada')
  const reads = api.getGitManagementCommit.mock.calls.length
  complete(ok({ state: { head: sha, branch: 'trunk' }, changes: [] }))
  await waitFor(() => expect(screen.getByLabelText('Detalhes Git').getAttribute('aria-busy')).toBe('false'))
  expect(api.getGitManagementCommit).toHaveBeenCalledTimes(reads)
  expect(screen.getByText('Origem: Não registrada')).toBeTruthy()
})

it.each([7, 15] as const)('requests the %i-day window and renders each daily column', async days => {
  const api = setup(); render(<GitManagementView state={state} />)
  await screen.findByRole('button', { name: /Real change/ })
  fireEvent.click(screen.getByRole('button', { name: days + 'd' }))
  await waitFor(() => expect(api.getGitAtlas.mock.calls.at(-1)![0].window).toBe(days))
  await waitFor(() => expect(document.querySelectorAll('.gm-atlas-date')).toHaveLength(days))
})

it('shows every active trajectory without noise controls and drops older rows on a short window', async () => {
  const api = setup()
  const nodes = Array.from({ length: 20 }, (_, index) => ({ ...page.nodes[0], sha: String(index).padStart(40, '0'), parents: [] }))
  nodes.push({ ...nodes[0], sha: 'f'.repeat(40), timestamp: '2026-10-01T00:00:00Z' })
  const branches = nodes.map((node, index) => ({ ...refs[0], ref: 'refs/heads/row-' + index, name: 'row-' + index, sha: node.sha }))
  api.getGitAtlas.mockResolvedValue(ok({ ...page, nodes, refs: branches, head: nodes[0].sha }))
  render(<GitManagementView state={state} />)
  await waitFor(() => expect(document.querySelectorAll('.gm-atlas-lane-label')).toHaveLength(21))
  expect(document.querySelector('.gm-secondary-toggle')).toBeNull()
  expect(document.querySelector('.gm-inactive')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '7d' }))
  await waitFor(() => expect(document.querySelectorAll('.gm-atlas-lane-label')).toHaveLength(20))
  expect(document.querySelector('[data-track="refs/heads/row-20"]')).toBeNull()
})
