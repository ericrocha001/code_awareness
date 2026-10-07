// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ContinuumView } from './ContinuumView'
import { NAV_ITEMS } from '../../config/navigation'
import type { ContinuumChange, ContinuumDetail, ContinuumFacet, ContinuumSelection, ContinuumTimeline } from '../../../../shared/types/continuum-ui-types'

const project = { id: 'workspace-id', path: '/A', name: 'Repository A' }
let receive: (change: ContinuumChange) => void
let facets: ContinuumFacet[]
let body: string
const unsubscribe = vi.fn()
beforeEach(() => {
  facets = [{ key: 'futureUnknownKey', values: [{ value: false, count: 2 }, { value: 'other', count: 1 }] }]
  body = '# Freeform content\n\nAny kind works.'
  unsubscribe.mockClear()
  window.codeAwareness = {
    getContinuumFacets: vi.fn(async (path: string) => ({ repositoryId: path === '/A' ? 'catalog-A' : 'catalog-B', facets: path === '/A' ? facets : [] })),
    listContinuumArtifacts: vi.fn(async request => ({ repositoryId: request.repositoryId, artifacts: request.repositoryId === 'catalog-A' ? [{ artifactId: 'one', name: 'First artifact', description: 'Read first', kind: 'NEVER_SEEN_KIND', updatedAt: '2026-10-06T18:00:00Z', relationCount: 0 }] : [] })),
    getContinuumArtifact: vi.fn(async (repositoryId: string, artifactId: string) => ({ repositoryId, artifact: { artifactId, revision: 2, metadata: { name: 'First artifact', kind: 'NEVER_SEEN_KIND', future: { x: ['value'] } }, body, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-06T18:00:00Z' } })),
    onContinuumChanged: vi.fn(callback => { receive = callback; return unsubscribe })
  } as unknown as Window['codeAwareness']
})
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

it('resizes adjacent panes, persists on drag end and restores separate widths for each repository', async () => {
  const { container, rerender, unmount } = render(<ContinuumView activeProject={project} />)
  await screen.findByText('First artifact')
  for (const [selector, width] of [['.continuum-context', 200], ['.continuum-timeline', 600], ['.continuum-inspector', 400]] as const) {
    vi.spyOn(container.querySelector(selector)!, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect)
  }
  const handle = container.querySelector('.continuum-context-resizer .crs-root')!
  fireEvent.mouseDown(handle, { clientX: 200, button: 0 })
  fireEvent.mouseMove(document, { clientX: 280 })
  expect(localStorage.getItem('continuum:columns:/A')).toBeNull()
  fireEvent.mouseUp(document)
  const stored = JSON.parse(localStorage.getItem('continuum:columns:/A')!)
  expect(stored.context).toBeCloseTo(280 / 1200)
  expect(stored.timeline).toBeCloseTo(520 / 1200)
  rerender(<ContinuumView activeProject={{ ...project, path: '/B' }} />)
  await waitFor(() => expect((container.querySelector('.continuum-workspace') as HTMLElement).style.getPropertyValue('--continuum-context-track')).toBe('0.16fr'))
  expect(localStorage.getItem('continuum:columns:/B')).toBeNull()
  rerender(<ContinuumView activeProject={project} />)
  await waitFor(() => expect(parseFloat((container.querySelector('.continuum-workspace') as HTMLElement).style.getPropertyValue('--continuum-context-track'))).toBeCloseTo(stored.context))
  unmount()
  const remounted = render(<ContinuumView activeProject={project} />)
  await screen.findByText('First artifact')
  expect(parseFloat((remounted.container.querySelector('.continuum-workspace') as HTMLElement).style.getPropertyValue('--continuum-timeline-track'))).toBeCloseTo(stored.timeline)
})

it('bounds inspector resizing and ignores corrupt persisted widths', async () => {
  localStorage.setItem('continuum:columns:/A', JSON.stringify({ context: -1, timeline: 20 }))
  const { container } = render(<ContinuumView activeProject={project} />)
  await screen.findByText('First artifact')
  expect((container.querySelector('.continuum-workspace') as HTMLElement).style.getPropertyValue('--continuum-context-track')).toBe('0.16fr')
  for (const [selector, width] of [['.continuum-context', 200], ['.continuum-timeline', 600], ['.continuum-inspector', 400]] as const) {
    vi.spyOn(container.querySelector(selector)!, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect)
  }
  fireEvent.mouseDown(container.querySelector('.continuum-inspector-resizer .crs-root')!, { clientX: 800, button: 0 })
  fireEvent.mouseMove(document, { clientX: 10000 })
  fireEvent.mouseUp(document)
  const stored = JSON.parse(localStorage.getItem('continuum:columns:/A')!)
  expect(stored.context).toBeCloseTo(200 / 1200)
  expect(stored.timeline).toBeCloseTo(720 / 1200)
  expect(1 - stored.context - stored.timeline).toBeCloseTo(280 / 1200)
})

it('provides navigation and an empty state without querying another repository', () => {
  expect(NAV_ITEMS.find(item => item.id === 'continuum')?.label).toBe('Continuum')
  render(<ContinuumView activeProject={null} />)
  expect(screen.getByText('Nenhum repositório ativo')).toBeTruthy()
  expect(window.codeAwareness.getContinuumFacets).not.toHaveBeenCalled()
  expect(window.codeAwareness.listContinuumArtifacts).not.toHaveBeenCalled()
})

it('derives typed filters, search and generic detail from the read API and refreshes on local changes', async () => {
  const { unmount } = render(<ContinuumView activeProject={project} />)
  expect(await screen.findByText('First artifact')).toBeTruthy()
  expect(screen.getByText('futureUnknownKey')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'false 2' }))
  await waitFor(() => expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenLastCalledWith({ repositoryId: 'catalog-A', query: '', metadata: { futureUnknownKey: false } }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Buscar no Continuum' }), { target: { value: 'First' } })
  await waitFor(() => expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenLastCalledWith({ repositoryId: 'catalog-A', query: 'First', metadata: { futureUnknownKey: false } }))
  fireEvent.click(await screen.findByRole('button', { name: /First artifact/ }))
  expect(await screen.findByRole('heading', { name: 'Freeform content' })).toBeTruthy()
  expect(window.codeAwareness.getContinuumArtifact).toHaveBeenCalledWith('catalog-A', 'one')
  const inspector = within(screen.getByRole('complementary', { name: 'Inspector' }))
  expect(inspector.getByText(/"value"/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /criar|editar|apagar|novo artifact|continuar/i })).toBeNull()
  body = '# Updated body'; facets = [{ key: 'brandNew', values: [{ value: 7, count: 1 }] }]
  act(() => receive({ repositoryId: 'catalog-A' }))
  expect(await screen.findByText('brandNew')).toBeTruthy()
  expect(await screen.findByRole('heading', { name: 'Updated body' })).toBeTruthy()
  await waitFor(() => expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenLastCalledWith({ repositoryId: 'catalog-A', query: 'First', metadata: {} }))
  unmount(); expect(unsubscribe).toHaveBeenCalled()
})

it('clears repository state and discards a detail response arriving after a repository switch', async () => {
  let resolve!: (selection: ContinuumSelection) => void
  vi.mocked(window.codeAwareness.getContinuumArtifact).mockImplementation(() => new Promise(done => { resolve = done }))
  const { rerender } = render(<ContinuumView activeProject={project} />)
  fireEvent.click(await screen.findByRole('button', { name: /First artifact/ }))
  fireEvent.click(screen.getByRole('button', { name: 'false 2' }))
  rerender(<ContinuumView activeProject={{ id: 'workspace-B', path: '/B', name: 'B' }} />)
  await waitFor(() => expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenLastCalledWith({ repositoryId: 'catalog-B', query: '', metadata: {} }))
  await act(async () => resolve({ repositoryId: 'catalog-A', artifact: { artifactId: 'one', metadata: { name: 'STALE DATA' }, body: '# Stale', revision: 1, createdAt: '', updatedAt: '' } }))
  expect(screen.queryByText('STALE DATA')).toBeNull()
  expect(screen.queryByText('futureUnknownKey')).toBeNull()
  expect(screen.queryByText('First artifact')).toBeNull()
  expect(screen.getByText('Nenhum artifact selecionado')).toBeTruthy()
})

it('uses the existing cursor and discards late pagination on query changes', async () => {
  let resolveMore!: (page: ContinuumTimeline) => void
  vi.mocked(window.codeAwareness.listContinuumArtifacts).mockImplementation(async request => {
    if (request.cursor) return new Promise(done => { resolveMore = done })
    return { repositoryId: request.repositoryId, artifacts: [], ...(request.query ? {} : { nextCursor: 'next' }) }
  })
  render(<ContinuumView activeProject={project} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }))
  expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenLastCalledWith({ repositoryId: 'catalog-A', query: '', metadata: {}, cursor: 'next' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Buscar no Continuum' }), { target: { value: 'different' } })
  await waitFor(() => expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenLastCalledWith({ repositoryId: 'catalog-A', query: 'different', metadata: {} }))
  await act(async () => resolveMore({ repositoryId: 'catalog-A', artifacts: [{ artifactId: 'late', name: 'Late page', kind: 'ANY', relationCount: 0, updatedAt: '' }] }))
  expect(screen.queryByText('Late page')).toBeNull()
})

it('renders read errors and treats raw HTML as text', async () => {
  vi.mocked(window.codeAwareness.getContinuumFacets).mockRejectedValueOnce(new Error('Read failed'))
  render(<ContinuumView activeProject={project} />)
  expect(await screen.findByRole('alert')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
  body = '# Safe\n\n<script>globalThis.bad = true</script><iframe src="https://example.test" />'
  fireEvent.click(await screen.findByRole('button', { name: /First artifact/ }))
  expect(await screen.findByRole('heading', { name: 'Safe' })).toBeTruthy()
  expect(document.querySelector('script, iframe')).toBeNull()
})
