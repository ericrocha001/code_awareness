// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ContinuumTimeline } from '../../../../shared/types/continuum-ui-types'
import { ContextBundleBuilder } from './ContextBundleBuilder'
import { consolidateBundle } from '../../../../shared/types/continuum-builder-types'
const member = { artifactId: 'one', name: 'Source', kind: 'DOCUMENT', revision: 1, updatedAt: '', relationCount: 0, rawMarkdownTokenCount: 20 }
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  window.codeAwareness = {
    listContinuumArtifacts: vi.fn(async () => ({ repositoryId: 'A', artifacts: [member] })),
    continuumBuilder: vi.fn(async request => {
      if (request.action === 'resolve') return { id: crypto.randomUUID(), source: request.source, members: [member] }
      if (request.action === 'preview') return { repositoryId: 'A', fingerprint: 'f', count: consolidateBundle(request.composition).length, tokenCount: 30, documentTokens: 20, markdown: '# context', markdownBytes: 9, tokenizerEncoding: 'cl100k_base', hasVisuals: false }
      return { repositoryId: 'A', outcome: 'copied' }
    })
  } as unknown as Window['codeAwareness']
})
afterEach(cleanup)
it('browses a chronological paginated catalog without changing composition, exclusions, order or preview', async () => {
  const day = new Date(2026, 9, 20, 12).toISOString(), older = new Date(2026, 9, 19, 12).toISOString()
  const source = { ...member, createdAt: day, updatedAt: older }
  const second = { ...source, artifactId: 'two', name: 'Second', updatedAt: day }
  const third = { ...source, artifactId: 'three', name: 'Third', createdAt: older }
  let holdPages = false, delayUpdated = true
  let finishPage!: (page: ContinuumTimeline) => void, finishInitial!: (page: ContinuumTimeline) => void
  vi.mocked(window.codeAwareness.listContinuumArtifacts).mockImplementation(async request => {
    if (request.repositoryId !== 'A') return { repositoryId: request.repositoryId, artifacts: [] }
    if (request.cursor) return holdPages ? new Promise(resolve => { finishPage = resolve }) : { repositoryId: 'A', artifacts: [second, third], nextCursor: 'p2' }
    if (request.sortBy === 'updatedAt' && delayUpdated) return new Promise(resolve => { finishInitial = resolve })
    return { repositoryId: 'A', artifacts: request.query === 'Second' ? [second] : request.query ? [source] : request.sortBy === 'updatedAt' ? [second, source] : [source], nextCursor: 'p1' }
  })
  const api = vi.mocked(window.codeAwareness.continuumBuilder), original = api.getMockImplementation()!
  api.mockImplementation(async request => request.action === 'resolve' && request.source.kind === 'artifact'
    ? { id: crypto.randomUUID(), source: request.source, members: request.source.selected.map(item => [source, second, third].find(member => member.artifactId === item.artifactId)!) }
    : original(request))
  const view = render(<ContextBundleBuilder repositoryId="A" facets={[]} tags={[{ slug: 'atlas', name: 'Git Atlas', count: 1, description: 'data only' }]} onClose={vi.fn()} />)
  const inputs = screen.getByRole('region', { name: 'Adicionar fontes' })
  const catalogNames = () => [...inputs.querySelectorAll('.continuum-builder-source')].map(element => element.textContent)
  const groups = () => [...inputs.querySelectorAll('.continuum-builder-catalog-date')].map(element => element.textContent)
  const order = screen.getByRole('combobox', { name: 'Ordenar fontes por' })
  expect((order as HTMLSelectElement).value).toBe('createdAt')
  fireEvent.click(await screen.findByRole('button', { name: /Source DOCUMENT/ }))
  await screen.findByText('1 Artifacts únicos')
  expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenLastCalledWith({ repositoryId: 'A', query: '', sortBy: 'createdAt' })
  expect(inputs.querySelector('time')?.getAttribute('datetime')).toBe(day)
  expect(inputs.querySelector('time')?.textContent).toContain('Criado')
  fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }))
  fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }))
  await screen.findByRole('button', { name: /Second DOCUMENT/ })
  expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenCalledTimes(2)
  expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenLastCalledWith({ repositoryId: 'A', query: '', sortBy: 'createdAt', cursor: 'p1' })
  expect(groups()).toEqual([new Date(day).toLocaleDateString(undefined, { dateStyle: 'long' }), new Date(older).toLocaleDateString(undefined, { dateStyle: 'long' })])
  fireEvent.click(screen.getByRole('button', { name: /Second DOCUMENT/ }))
  await screen.findByText('2 Artifacts únicos')
  fireEvent.click(screen.getByRole('button', { name: 'Tags' }))
  expect(screen.queryByRole('combobox', { name: 'Ordenar fontes por' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Git Atlas/ }))
  await waitFor(() => expect(document.querySelectorAll('.continuum-builder-components > div')).toHaveLength(3))
  expect(document.querySelectorAll('.continuum-builder-members li')).toHaveLength(2)
  expect(window.codeAwareness.continuumBuilder).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'preview' }))
  fireEvent.click(screen.getByRole('button', { name: 'Subir Second' }))
  fireEvent.click(screen.getByLabelText('Retirar Source'))
  await screen.findByText('1 Artifacts únicos')
  fireEvent.click(screen.getByRole('button', { name: 'Gerar prévia' }))
  await screen.findByLabelText('Prévia do pacote')
  const previewRequest = api.mock.calls.find(([request]) => request.action === 'preview')![0]
  expect(previewRequest.action).toBe('preview')
  if (previewRequest.action !== 'preview') throw new Error('Missing preview')
  const snapshot = structuredClone(previewRequest.composition)
  expect(snapshot.order).toEqual(['two', 'one'])
  expect(snapshot.excluded).toEqual(['one'])
  fireEvent.click(within(inputs).getByRole('button', { name: 'Artifacts' }))
  holdPages = true
  fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }))
  const mode = screen.getByRole('combobox', { name: 'Ordenar fontes por' })
  inputs.scrollTop = 300
  fireEvent.change(mode, { target: { value: 'updatedAt' } })
  expect(inputs.scrollTop).toBe(0)
  expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenLastCalledWith({ repositoryId: 'A', query: '', sortBy: 'updatedAt' })
  fireEvent.change(mode, { target: { value: 'createdAt' } })
  await act(async () => {
    finishPage({ repositoryId: 'A', artifacts: [{ ...third, name: 'Stale page' }] })
    finishInitial({ repositoryId: 'A', artifacts: [{ ...third, name: 'Stale initial' }] })
  })
  expect(catalogNames()).toHaveLength(1)
  expect(screen.queryByText(/Stale/)).toBeNull()
  delayUpdated = false
  fireEvent.change(mode, { target: { value: 'updatedAt' } })
  await waitFor(() => expect(catalogNames()).toHaveLength(2))
  expect(catalogNames()[0]).toContain('Second')
  expect(inputs.querySelector('time')?.getAttribute('datetime')).toBe(day)
  expect(inputs.querySelector('time')?.textContent).toContain('Atualizado')
  expect(inputs.querySelector('[data-selected=true]')?.textContent).toContain('Second')
  fireEvent.change(screen.getByLabelText('Buscar fontes'), { target: { value: 'Second' } })
  await waitFor(() => expect(catalogNames()).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }))
  expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenLastCalledWith({ repositoryId: 'A', query: 'Second', sortBy: 'updatedAt', cursor: 'p1' })
  inputs.scrollTop = 200
  fireEvent.change(screen.getByLabelText('Buscar fontes'), { target: { value: 'Source' } })
  expect(inputs.scrollTop).toBe(0)
  await act(async () => finishPage({ repositoryId: 'A', artifacts: [{ ...third, name: 'Stale search' }] }))
  expect(window.codeAwareness.listContinuumArtifacts).toHaveBeenLastCalledWith({ repositoryId: 'A', query: 'Source', sortBy: 'updatedAt' })
  expect(catalogNames()).toHaveLength(1)
  expect(catalogNames()[0]).toContain('Source')
  expect(screen.getByLabelText('Prévia do pacote').textContent).toBe('# context')
  fireEvent.click(screen.getByRole('button', { name: 'Copiar contexto' }))
  await screen.findByText('Contexto copiado.')
  const exportRequest = api.mock.calls.find(([request]) => request.action === 'export')![0]
  expect(exportRequest).toMatchObject({ action: 'export', intent: 'copy', composition: snapshot })
  expect(api.mock.calls.filter(([request]) => request.action === 'resolve').every(([request]) => !JSON.stringify(request).includes('sortBy'))).toBe(true)
  fireEvent.click(screen.getByText('1 excluídos manualmente'))
  fireEvent.click(screen.getByRole('button', { name: 'Reintroduzir Source' }))
  expect(screen.queryByLabelText('Prévia do pacote')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }))
  view.rerender(<ContextBundleBuilder repositoryId="B" facets={[]} tags={[]} onClose={vi.fn()} />)
  await act(async () => finishPage({ repositoryId: 'A', artifacts: [{ ...third, name: 'Stale repository' }] }))
  expect(catalogNames()).toHaveLength(0)
})
it('discards a late component after closing and sends explicit cancellation', async () => {
  let finish!: (value: any) => void
  vi.mocked(window.codeAwareness.continuumBuilder).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const close = vi.fn(), view = render(<ContextBundleBuilder repositoryId="A" facets={[]} tags={[]} onClose={close} />)
  fireEvent.click(await screen.findByRole('button', { name: /Source DOCUMENT/ }))
  fireEvent.click(screen.getByLabelText('Fechar construtor')); view.unmount()
  finish({ id: 'late', members: [member] })
  expect(close).toHaveBeenCalledTimes(1)
  expect(window.codeAwareness.continuumBuilder).toHaveBeenCalledWith({ repositoryId: 'A', action: 'cancel' })
})
it('keeps generation literal, removes compression controls and labels only applied legacy history', async () => {
  const api = vi.mocked(window.codeAwareness.continuumBuilder), original = api.getMockImplementation()!
  api.mockImplementation(((async (request: any) => request.action === 'recent'
    ? [{ id: 'legacy', name: 'Legado', format: 'copy' as const, generatedAt: '2026-01-01', count: 1, bytes: 20, tokenCount: 10, compression: { applied: true, profile: 'strong' } }, { id: 'plain', name: 'Integral', format: 'copy' as const, generatedAt: '2026-01-02', count: 1, bytes: 20, tokenCount: 10, compression: { applied: false, profile: 'off' } }]
    : original(request)) as any))
  render(<ContextBundleBuilder repositoryId="A" facets={[]} tags={[]} onClose={vi.fn()} />)
  expect(screen.queryByLabelText('Compressão PAKT')).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: /Source DOCUMENT/ }))
  await screen.findByText('1 Artifacts únicos')
  fireEvent.click(screen.getByRole('button', { name: 'Gerar prévia' }))
  await screen.findByLabelText('Prévia do pacote')
  const previewRequest = api.mock.calls.find(([request]) => request.action === 'preview')![0]
  expect(previewRequest).not.toHaveProperty('profile')
  fireEvent.change(screen.getByLabelText('Formato do pacote'), { target: { value: 'markdown' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar pacote' }))
  await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ action: 'export', intent: 'markdown' })))
  fireEvent.click(screen.getByRole('button', { name: 'Recentes (15)' }))
  expect(await screen.findAllByText('Pacote histórico com compressão legada')).toHaveLength(1)
  expect(screen.queryByText('strong')).toBeNull()
})
