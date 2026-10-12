// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Core } from 'cytoscape'
import { ContinuumGraph } from './ContinuumGraph'
import { ContinuumView } from './ContinuumView'
import type { ContinuumGraph as Graph } from '../../../../shared/types/continuum-graph-types'

const { cores } = vi.hoisted(() => ({ cores: [] as Core[] }))
vi.mock('cytoscape', async original => {
  const actual = await original<{ default: typeof import('cytoscape') }>()
  return { default: (options: object) => {
    const instance = actual.default({ ...options, container: undefined, headless: true, styleEnabled: true })
    cores.push(instance)
    return instance
  } }
})
const node = (artifactId: string) => ({ artifactId, name: 'Artifact ' + artifactId, kind: 'DECISION', updatedAt: '2026-10-12T00:00:00Z', revision: 1, relationCount: 2, incomingDegree: 1, outgoingDegree: 1 })
function graph(repositoryId = 'A', ids = ['one', 'two', 'isolated']): Graph {
  return { repositoryId, revision: 12, freshness: 'CURRENT', nodes: ids.map(node), edges: ids.includes('two') ? [
    { sourceId: 'one', targetId: 'two', kind: 'implements', nature: 'DECLARED', origin: 'metadata.relations', sourceRevision: 1, sourceHash: 'hash' },
    { sourceId: 'two', targetId: 'one', kind: 'references', nature: 'DERIVED', origin: 'explicit-artifact-reference', sourceRevision: 1, sourceHash: 'hash' }
  ] : [], executionGroups: [], truncated: { nodes: true, edges: false } }
}
const props = { repositoryId: 'A', query: '', metadata: {}, periods: {}, refresh: 0, selectedId: 'one', onSelect: vi.fn() }
beforeEach(() => {
  cores.length = 0; props.onSelect.mockClear()
  window.codeAwareness = {
    getContinuumGraph: vi.fn(async request => graph(request.repositoryId, request.artifactIds ?? ['one', 'two', 'isolated'])),
    getContinuumSuggestions: vi.fn(async request => ({ repositoryId: request.repositoryId, sourceArtifactId: request.artifactId, graphRevision: 12,
      suggestions: [{ targetArtifactId: 'candidate', name: 'Candidate', kind: 'DECISION', targetRevision: 1, origin: 'SUGGESTED', proposedKind: 'related-to', score: 6, reasons: [{ signal: 'shared-terms', terms: ['sqlite', 'migration'] }] }] })),
    getContinuumFacets: vi.fn(async path => ({ repositoryId: path === '/A' ? 'A' : 'B', facets: [] })),
    listContinuumArtifacts: vi.fn(async request => ({ repositoryId: request.repositoryId, artifacts: [node('one')] })),
    getContinuumArtifact: vi.fn(async (repositoryId, artifactId) => ({ repositoryId, artifact: { artifactId, revision: 1, metadata: { name: 'Artifact ' + artifactId }, body: '# Shared inspector', createdAt: 'now', updatedAt: 'now' } })),
    onContinuumChanged: vi.fn(() => () => {})
  } as unknown as Window['codeAwareness']
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('uses capped scoped queries with temporal filters, isolated nodes and no whole-document reads', async () => {
  render(<ContinuumGraph {...props} query="SQLite" metadata={{ kind: 'DECISION' }} periods={{ date: { year: 2026, month: 10 } }} />)
  await screen.findByRole('option', { name: 'Artifact isolated' })
  expect(window.codeAwareness.getContinuumGraph).toHaveBeenCalledWith({ repositoryId: 'A', query: 'SQLite', metadata: { kind: 'DECISION' }, periods: { date: { year: 2026, month: 10 } }, nodeLimit: 50, edgeLimit: 200 })
  expect(window.codeAwareness.getContinuumArtifact).not.toHaveBeenCalled()
  expect(screen.getByText(/recorte incompleto/)).toBeTruthy()
  expect(window.codeAwareness.getContinuumSuggestions).not.toHaveBeenCalled()
  expect(cores[0].edges().map(edge => edge.style('line-style'))).toEqual(['solid', 'dotted'])
})

it('keeps Timeline selection, list requests and Inspector shared across both views', async () => {
  render(<ContinuumView activeProject={{ id: 'p', path: '/A', name: 'A' }} />)
  fireEvent.click(await screen.findByRole('button', { name: /Artifact one/ }))
  await screen.findByRole('heading', { name: 'Shared inspector' })
  const calls = vi.mocked(window.codeAwareness.listContinuumArtifacts).mock.calls.length
  fireEvent.click(screen.getByRole('tab', { name: 'Graph' }))
  await screen.findByRole('option', { name: 'Artifact isolated' })
  fireEvent.change(screen.getByLabelText('Selecionar artifact no grafo'), { target: { value: 'isolated' } })
  await waitFor(() => expect(window.codeAwareness.getContinuumArtifact).toHaveBeenCalledWith('A', 'isolated'))
  fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }))
  expect(cores[0].destroyed()).toBe(true)
  expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenCalledTimes(calls)
  expect(screen.getByRole('heading', { name: 'Artifact isolated' })).toBeTruthy()
})

it('expands one hop with revision guards and explains extra nodes outside the initial filters', async () => {
  const read = vi.mocked(window.codeAwareness.getContinuumGraph)
  read.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph('A', ['one', 'outside']))
  render(<ContinuumGraph {...props} />)
  await screen.findByRole('option', { name: 'Artifact two' })
  fireEvent.click(screen.getByRole('button', { name: 'Expandir vizinhança' }))
  await screen.findByRole('option', { name: /Artifact outside/ })
  expect(read).toHaveBeenLastCalledWith({ repositoryId: 'A', artifactIds: ['one'], expand: true, nodeLimit: 100, edgeLimit: 500, expectedRevision: 12 })
  expect(screen.getByText(/fora da busca/)).toBeTruthy()
})

it('shows suggested ghost edges only on request and reads evidence without promoting relations', async () => {
  render(<ContinuumGraph {...props} />)
  await screen.findByRole('option', { name: 'Artifact two' })
  fireEvent.click(screen.getByLabelText('Sugestões'))
  await screen.findByRole('option', { name: /SUGGESTED.*related-to/ })
  expect(window.codeAwareness.getContinuumSuggestions).toHaveBeenCalledWith({ repositoryId: 'A', artifactId: 'one', limit: 5, expectedGraphRevision: 12 })
  expect(cores[0].edges('[nature="SUGGESTED"]').style('line-style')).toBe('dashed')
  const option = screen.getByRole('option', { name: /SUGGESTED.*related-to/ }) as HTMLOptionElement
  fireEvent.change(screen.getByLabelText('Inspecionar relação'), { target: { value: option.value } })
  expect(screen.getByLabelText('Detalhes da relação').textContent).toContain('Termos: sqlite, migration')
  fireEvent.click(screen.getByLabelText('Sugestões'))
  await waitFor(() => expect(cores[0].edges('[nature="SUGGESTED"]').length).toBe(0))
  expect(window.codeAwareness.getContinuumArtifact).not.toHaveBeenCalled()
})

it('discards stale filter/repository responses and destroys instances on context switch', async () => {
  let finish!: (value: Graph) => void
  vi.mocked(window.codeAwareness.getContinuumGraph).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = render(<ContinuumGraph {...props} />)
  view.rerender(<ContinuumGraph {...props} query="new" />)
  await screen.findByRole('option', { name: 'Artifact two' })
  await act(async () => finish(graph('A', ['old'])))
  expect(screen.queryByRole('option', { name: 'Artifact old' })).toBeNull()
  view.unmount()
  expect(cores[0].destroyed()).toBe(true)
  render(<ContinuumGraph {...props} repositoryId="B" selectedId={null} />)
  await waitFor(() => expect(window.codeAwareness.getContinuumGraph).toHaveBeenLastCalledWith(expect.objectContaining({ repositoryId: 'B' })))
})

it('supports native Cytoscape selection, keyboard pan/zoom, edge inspection and reset', async () => {
  render(<ContinuumGraph {...props} />)
  await screen.findByRole('option', { name: 'Artifact isolated' })
  act(() => cores[0].getElementById('artifact:isolated').emit('tap'))
  expect(props.onSelect).toHaveBeenCalledWith('isolated')
  const pan = { ...cores[0].pan() }
  fireEvent.keyDown(screen.getByRole('img'), { key: 'ArrowLeft' })
  expect(cores[0].pan().x).toBe(pan.x + 40)
  const fit = vi.spyOn(cores[0], 'fit')
  fireEvent.keyDown(screen.getByRole('img'), { key: 'Home' })
  expect(fit).toHaveBeenCalled()
  act(() => cores[0].edges()[0].emit('tap'))
  expect(screen.getByLabelText('Detalhes da relação').textContent).toContain('metadata.relations')
})

it('uses honest empty/error states and retries without retaining stale graph content', async () => {
  vi.mocked(window.codeAwareness.getContinuumGraph).mockRejectedValueOnce(new Error('REPOSITORY_CONTEXT_CHANGED')).mockResolvedValueOnce(graph('A', []))
  render(<ContinuumGraph {...props} />)
  expect((await screen.findByRole('alert')).textContent).toContain('REPOSITORY_CONTEXT_CHANGED')
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar grafo' }))
  await screen.findByRole('heading', { name: 'Nenhum artifact encontrado' })
  expect(cores[0].elements().length).toBe(0)
})
