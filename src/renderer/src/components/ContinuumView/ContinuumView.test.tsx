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
const intersections = new Map<Element, (entries: { isIntersecting: boolean }[]) => void>()
const unsubscribe = vi.fn()
beforeEach(() => {
  intersections.clear()
  vi.stubGlobal('IntersectionObserver', class {
    private targets: Element[] = []
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe(target: Element) { this.targets.push(target); intersections.set(target, this.callback) }
    disconnect() { this.targets.forEach(target => intersections.delete(target)) }
  })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  facets = [{ key: 'futureUnknownKey', values: [{ value: false, count: 2 }, { value: 'other', count: 1 }] }]
  body = '# Freeform content\n\nAny kind works.'
  unsubscribe.mockClear()
  window.codeAwareness = {
    getContinuumFacets: vi.fn(async (path: string) => ({ repositoryId: path === '/A' ? 'catalog-A' : 'catalog-B', facets: path === '/A' ? facets : [] })),
    listContinuumArtifacts: vi.fn(async request => ({ repositoryId: request.repositoryId, artifacts: request.repositoryId === 'catalog-A' ? [{ artifactId: 'one', name: 'First artifact', description: 'Read first', kind: 'NEVER_SEEN_KIND', updatedAt: '2026-10-06T18:00:00Z', relationCount: 0 }] : [] })),
    getContinuumArtifact: vi.fn(async (repositoryId: string, artifactId: string) => ({ repositoryId, artifact: { artifactId, revision: 2, metadata: { name: 'First artifact', kind: 'NEVER_SEEN_KIND', future: { x: ['value'] } }, body, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-06T18:00:00Z' } })),
    onContinuumChanged: vi.fn(callback => { receive = callback; return unsubscribe }),
    publishContinuumArtifact: vi.fn(async () => ({ success: true, artifactId: 'new', revision: 1, updatedAt: 'now' })),
    publishContinuumVisual: vi.fn(async () => ({ success: true, artifactId: 'visual', revision: 1, updatedAt: 'now' })),
    getContinuumVisual: vi.fn(async (repositoryId, artifactId) => ({ repositoryId, artifactId, mimeType: 'image/webp', data: new Uint8Array([1, 2]) })),
    getContinuumVisualThumbnail: vi.fn(async (repositoryId, artifactId) => ({ repositoryId, artifactId, mimeType: 'image/webp', data: new Uint8Array([1, 2]) }))
  } as unknown as Window['codeAwareness']
})

it('publishes only after explicit visual context submission, with optional relation and scoped binary IPC', async () => {
  render(<ContinuumView activeProject={project} />)
  await screen.findByRole('button', { name: /First artifact/ })
  fireEvent.click(screen.getByRole('button', { name: 'Publicar WebP' }))
  const data = new Uint8Array([1, 2, 3])
  fireEvent.change(screen.getByLabelText('Arquivo WebP'), { target: { files: [{ name: 'reference.webp', size: 3, arrayBuffer: async () => data.buffer }] } })
  expect(window.codeAwareness.publishContinuumVisual).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Durable visual' } })
  fireEvent.change(screen.getByLabelText('Contexto'), { target: { value: 'Normative reference' } })
  fireEvent.change(screen.getByLabelText('Relacionar a um Artifact'), { target: { value: 'one' } })
  fireEvent.click(screen.getByRole('button', { name: 'Publicar referência' }))
  await waitFor(() => expect(window.codeAwareness.publishContinuumVisual).toHaveBeenCalledWith({ repositoryId: 'catalog-A', name: 'reference', description: 'Durable visual', context: 'Normative reference', data, relations: [{ artifactId: 'one', kind: 'related-to' }] }))
  expect(window.codeAwareness.publishContinuumArtifact).not.toHaveBeenCalled()
})

it('loads visual bytes only on selection and revokes preview URLs when repository changes', async () => {
  const create = vi.fn(() => 'blob:visual'), revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
  const original = vi.mocked(window.codeAwareness.getContinuumArtifact).getMockImplementation()!
  vi.mocked(window.codeAwareness.getContinuumArtifact).mockImplementation(async (repositoryId, artifactId) => {
    const result = await original(repositoryId, artifactId)
    return { ...result, artifact: { ...result.artifact!, metadata: { ...result.artifact!.metadata, kind: 'VISUAL_REFERENCE' } } }
  })
  const view = render(<ContinuumView activeProject={project} />)
  const item = await screen.findByRole('button', { name: /First artifact/ })
  expect(window.codeAwareness.getContinuumVisual).not.toHaveBeenCalled()
  fireEvent.click(item)
  await screen.findByAltText('Referência visual canônica')
  expect(window.codeAwareness.getContinuumVisual).toHaveBeenCalledWith('catalog-A', 'one')
  view.rerender(<ContinuumView activeProject={{ ...project, path: '/B' }} />)
  await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:visual'))
  expect(screen.queryByAltText('Referência visual canônica')).toBeNull()
  vi.unstubAllGlobals()
})

it('rejects an in-flight visual file read even when selection leaves and returns to the same repository', async () => {
  let finish!: (value: ArrayBuffer) => void
  const view = render(<ContinuumView activeProject={project} />)
  await screen.findByRole('button', { name: /First artifact/ })
  fireEvent.click(screen.getByRole('button', { name: 'Publicar WebP' }))
  fireEvent.change(screen.getByLabelText('Arquivo WebP'), { target: { files: [{ name: 'reference.webp', size: 3, arrayBuffer: () => new Promise(resolve => { finish = resolve }) }] } })
  fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Durable visual' } })
  fireEvent.change(screen.getByLabelText('Contexto'), { target: { value: 'Normative reference' } })
  fireEvent.click(screen.getByRole('button', { name: 'Publicar referência' }))
  view.rerender(<ContinuumView activeProject={{ ...project, path: '/B' }} />)
  await waitFor(() => expect(window.codeAwareness.getContinuumFacets).toHaveBeenCalledWith('/B'))
  view.rerender(<ContinuumView activeProject={project} />)
  await act(async () => finish(new Uint8Array([1, 2, 3]).buffer))
  expect(window.codeAwareness.publishContinuumVisual).not.toHaveBeenCalled()
})

function selectFile(name: string, read: () => Promise<ArrayBuffer>) {
  fireEvent.click(screen.getByRole('button', { name: 'Publicar Markdown' }))
  fireEvent.change(screen.getByLabelText('Arquivo Markdown'), { target: { files: [{ name, arrayBuffer: read }] } })
}

it('publishes exact UTF-8 once, locks concurrent requests and leaves filters/selection to existing change notifications', async () => {
  let complete!: (value: any) => void
  vi.mocked(window.codeAwareness.publishContinuumArtifact).mockImplementation(() => new Promise(resolve => { complete = resolve }))
  render(<ContinuumView activeProject={project} />)
  fireEvent.click(await screen.findByRole('button', { name: /First artifact/ }))
  await screen.findByRole('heading', { name: 'Freeform content' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Buscar no Continuum' }), { target: { value: 'First' } })
  const text = '\uFEFF---\r\nname: Exact\r\ndescription: Exact\r\nkind: CUSTOM\r\n---\r\nç 日本語 🚀 `${literal}`\r\n'
  const bytes = new TextEncoder().encode(text).buffer
  selectFile('exact.md', async () => bytes)
  await waitFor(() => expect(window.codeAwareness.publishContinuumArtifact).toHaveBeenCalledWith({ repositoryId: 'catalog-A', fileName: 'exact.md', rawMarkdown: text }))
  expect((screen.getByRole('button', { name: 'Publicando…' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Arquivo Markdown'), { target: { files: [{ name: 'again.md', arrayBuffer: async () => bytes }] } })
  await act(async () => complete({ success: true, artifactId: 'new', revision: 1, updatedAt: 'now' }))
  expect(screen.getByText(/Artifact publicado: new.*filtros/)).toBeTruthy()
  act(() => receive({ repositoryId: 'catalog-A' }))
  await waitFor(() => expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenLastCalledWith({ repositoryId: 'catalog-A', query: 'First', metadata: {} }))
  expect(await screen.findByRole('heading', { name: 'Freeform content' })).toBeTruthy()
  expect(window.codeAwareness.publishContinuumArtifact).toHaveBeenCalledTimes(1)
})

it('cancel, wrong extension, invalid UTF-8 and read failure do not publish; domain errors have no retry', async () => {
  render(<ContinuumView activeProject={project} />)
  await screen.findByText('First artifact')
  fireEvent.click(screen.getByRole('button', { name: 'Publicar Markdown' }))
  fireEvent.change(screen.getByLabelText('Arquivo Markdown'), { target: { files: [] } })
  selectFile('bad.txt', async () => new ArrayBuffer(0))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('.md'))
  selectFile('bad.md', async () => new Uint8Array([0xc3, 0x28]).buffer)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('UTF-8'))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Publicar Markdown' }) as HTMLButtonElement).disabled).toBe(false))
  selectFile('unreadable.md', async () => { throw new Error('read') })
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('UTF-8'))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Publicar Markdown' }) as HTMLButtonElement).disabled).toBe(false))
  expect(window.codeAwareness.publishContinuumArtifact).not.toHaveBeenCalled()
  vi.mocked(window.codeAwareness.publishContinuumArtifact).mockRejectedValue(new Error('INVALID_ARGUMENT: frontmatter required'))
  selectFile('invalid.md', async () => new TextEncoder().encode('# Body').buffer)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('frontmatter'))
  expect(window.codeAwareness.publishContinuumArtifact).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull()
})

it('refuses a file read finishing after repository switch', async () => {
  let finish!: (value: ArrayBuffer) => void
  const { rerender } = render(<ContinuumView activeProject={project} />)
  await screen.findByText('First artifact')
  selectFile('late.md', () => new Promise(resolve => { finish = resolve }))
  rerender(<ContinuumView activeProject={{ ...project, path: '/B' }} />)
  await act(async () => finish(new TextEncoder().encode('# Late').buffer))
  expect(screen.getByRole('alert').textContent).toContain('repositório ativo mudou')
  expect(window.codeAwareness.publishContinuumArtifact).not.toHaveBeenCalled()
})
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('requests only visible visual projections with two concurrent reads and skips rows leaving the viewport', async () => {
  const create = vi.fn(() => 'blob:thumbnail'), revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
  vi.mocked(window.codeAwareness.listContinuumArtifacts).mockImplementation(async request => ({ repositoryId: request.repositoryId, nextCursor: 'next', artifacts: Array.from({ length: 20 }, (_, index) => ({ artifactId: `visual-${index}`, name: `Visual ${index}`, kind: 'VISUAL_REFERENCE', updatedAt: '2026-10-09', relationCount: 0 })) }))
  const finishes: (() => void)[] = []
  vi.mocked(window.codeAwareness.getContinuumVisualThumbnail).mockImplementation((repositoryId, artifactId) => new Promise(resolve => finishes.push(() => resolve({ repositoryId, artifactId, mimeType: 'image/webp', data: new Uint8Array([1]) }))))
  const view = render(<ContinuumView activeProject={project} />)
  await screen.findByText('Visual 19')
  expect(window.codeAwareness.getContinuumVisualThumbnail).not.toHaveBeenCalled()
  const targets = [...intersections.keys()]
  act(() => targets.slice(0, 5).forEach(target => intersections.get(target)!([{ isIntersecting: true }])))
  await waitFor(() => expect(finishes).toHaveLength(2))
  act(() => intersections.get(targets[2])!([{ isIntersecting: false }]))
  await act(async () => finishes[0]())
  await waitFor(() => expect(finishes).toHaveLength(3))
  expect(window.codeAwareness.getContinuumVisualThumbnail).toHaveBeenNthCalledWith(3, 'catalog-A', 'visual-3')
  expect(window.codeAwareness.getContinuumVisual).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Visual 0/ }))
  expect(window.codeAwareness.getContinuumArtifact).toHaveBeenCalledWith('catalog-A', 'visual-0')
  view.unmount()
  await act(async () => finishes.slice(1).forEach(finish => finish()))
  expect(create).toHaveBeenCalledTimes(1)
  expect(revoke).toHaveBeenCalledWith('blob:thumbnail')
  expect(window.codeAwareness.getContinuumVisualThumbnail).toHaveBeenCalledTimes(3)
})

it('discards late projections on repository switch and leaves selection usable after a thumbnail error', async () => {
  const create = vi.fn(() => 'blob:thumbnail'), revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
  vi.mocked(window.codeAwareness.listContinuumArtifacts).mockImplementation(async request => ({ repositoryId: request.repositoryId, artifacts: request.repositoryId === 'catalog-A' ? [{ artifactId: 'one', name: 'Visual', kind: 'VISUAL_REFERENCE', updatedAt: '2026-10-09', relationCount: 0 }] : [] }))
  let finish!: () => void
  vi.mocked(window.codeAwareness.getContinuumVisualThumbnail).mockImplementationOnce((repositoryId, artifactId) => new Promise(resolve => { finish = () => resolve({ repositoryId, artifactId, mimeType: 'image/webp', data: new Uint8Array([1]) }) }))
  const view = render(<ContinuumView activeProject={project} />)
  await screen.findByText('Visual')
  act(() => [...intersections.values()][0]([{ isIntersecting: true }]))
  await waitFor(() => expect(window.codeAwareness.getContinuumVisualThumbnail).toHaveBeenCalledTimes(1))
  view.rerender(<ContinuumView activeProject={{ ...project, path: '/B' }} />)
  await act(async () => finish())
  expect(create).not.toHaveBeenCalled()
  vi.mocked(window.codeAwareness.getContinuumVisualThumbnail).mockRejectedValueOnce(new Error('corrupt'))
  const original = vi.mocked(window.codeAwareness.getContinuumArtifact).getMockImplementation()!
  vi.mocked(window.codeAwareness.getContinuumArtifact).mockImplementation(async (repositoryId, artifactId) => {
    const result = await original(repositoryId, artifactId)
    return { ...result, artifact: { ...result.artifact!, metadata: { ...result.artifact!.metadata, kind: 'VISUAL_REFERENCE' } } }
  })
  view.rerender(<ContinuumView activeProject={project} />)
  await screen.findByText('Visual')
  act(() => [...intersections.values()][0]([{ isIntersecting: true }]))
  fireEvent.click(screen.getByRole('button', { name: /Visual Referência visual/ }))
  await screen.findByRole('heading', { name: 'Freeform content' })
  expect(screen.queryByAltText('Miniatura da referência visual')).toBeNull()
  await screen.findByAltText('Referência visual canônica')
  expect(window.codeAwareness.getContinuumVisual).toHaveBeenCalledWith('catalog-A', 'one')
})

it('refreshes published visuals without an external event, preserves hiding filters and reveals only on explicit action', async () => {
  vi.mocked(window.codeAwareness.listContinuumArtifacts).mockImplementation(async request => ({ repositoryId: request.repositoryId, artifacts: request.query ? [] : [{ artifactId: 'visual', name: 'New visual', kind: 'VISUAL_REFERENCE', updatedAt: '2026-10-09', relationCount: 0 }] }))
  render(<ContinuumView activeProject={project} />)
  await screen.findByText('New visual')
  fireEvent.change(screen.getByRole('textbox', { name: 'Buscar no Continuum' }), { target: { value: 'hidden' } })
  await screen.findByText('Nenhum artifact encontrado')
  const before = vi.mocked(window.codeAwareness.listContinuumArtifacts).mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Publicar WebP' }))
  fireEvent.change(screen.getByLabelText('Arquivo WebP'), { target: { files: [{ name: 'reference.webp', size: 1, arrayBuffer: async () => new Uint8Array([1]).buffer }] } })
  fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Description' } })
  fireEvent.change(screen.getByLabelText('Contexto'), { target: { value: 'Context' } })
  fireEvent.click(screen.getByRole('button', { name: 'Publicar referência' }))
  const reveal = await screen.findByRole('button', { name: 'Exibir na timeline' })
  expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenCalledTimes(before + 1)
  expect(screen.getByRole('textbox', { name: 'Buscar no Continuum' })).toHaveProperty('value', 'hidden')
  expect(window.codeAwareness.getContinuumArtifact).toHaveBeenCalledWith('catalog-A', 'visual')
  fireEvent.click(reveal)
  await screen.findByText('New visual')
  expect(screen.getByRole('textbox', { name: 'Buscar no Continuum' })).toHaveProperty('value', '')
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled()
  expect(window.codeAwareness.getContinuumVisualThumbnail).not.toHaveBeenCalled()
})

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
  expect((screen.getByRole('button', { name: 'Publicar Markdown' }) as HTMLButtonElement).disabled).toBe(true)
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
