// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ContinuumTag } from '../../../../shared/types/continuum-tag-types'
import type { ContinuumTimeline } from '../../../../shared/types/continuum-ui-types'
import { ArtifactTagEditor, ContinuumTagManager } from './ContinuumTags'
const tags = [{ slug: 'architecture', name: 'Architecture', description: 'Decisões aprovadas, não propostas.', count: 2 }]
const artifact = { artifactId: 'one', revision: 7, metadata: { name: 'One', tags: ['architecture'] }, body: '# exact', createdAt: '', updatedAt: '' }
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  window.codeAwareness = { mutateContinuumTags: vi.fn(async () => ({ repositoryId: 'A', tags })), quickContinuumBundle: vi.fn(async () => ({ repositoryId: 'A', outcome: 'copied', count: 2, tokenCount: 20, tokenizerEncoding: 'cl100k_base', hasVisuals: true })) } as unknown as Window['codeAwareness']
  window.codeAwareness.getContinuumTagTokens = vi.fn(async repositoryId => ({ repositoryId, totals: [{ slug: 'architecture', count: 2, rawMarkdownTokenCount: 42, tokenizerId: 'canonical', tokenizerEncoding: 'cl100k_base' }] }))
  window.codeAwareness.listContinuumArtifacts = vi.fn(async ({ repositoryId }) => ({ repositoryId, artifacts: [] }))
})

it('manager flow preserves tag identity through CRUD, selection and the existing filter/builder callbacks', async () => {
  let catalog: ContinuumTag[] = [...tags]
  vi.mocked(window.codeAwareness.mutateContinuumTags).mockImplementation(async request => {
    if (request.intent === 'create') catalog = [...catalog, { ...request.tag, description: request.tag.description ?? '', count: 0 }]
    if (request.intent === 'edit') catalog = catalog.map(tag => tag.slug === request.tag.slug ? { ...tag, ...request.tag } : tag)
    if (request.intent === 'delete') catalog = catalog.filter(tag => tag.slug !== request.slug)
    return { repositoryId: request.repositoryId, tags: catalog }
  })
  vi.mocked(window.codeAwareness.listContinuumArtifacts).mockResolvedValue({ repositoryId: 'A', artifacts: Array.from({ length: 4 }, (_, i) => ({ artifactId: String(i), name: `Preview ${i}`, kind: 'DOCUMENT', updatedAt: '2026-10-28T12:00:00Z', relationCount: 0 })) })
  const filter = vi.fn(), bundle = vi.fn(), changed = vi.fn(), close = vi.fn(), totals = vi.fn()
  render(<ContinuumTagManager repositoryId="A" tags={tags} onBundle={bundle} onFilter={filter} onChanged={changed} onClose={close} onTokenTotals={totals} />)
  expect(document.activeElement).toBe(screen.getByLabelText('Buscar tags'))
  expect(await screen.findByText('Preview 2')).toBeTruthy()
  expect(screen.queryByText('Preview 3')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Architecture 2 Artifacts/ }))
  expect(filter).not.toHaveBeenCalled(); expect(bundle).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Buscar tags'), { target: { value: 'missing' } })
  expect(screen.getByText('Nenhuma tag encontrada.')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Architecture' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Buscar tags'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Nova tag' }))
  fireEvent.change(screen.getByLabelText('Nome da tag'), { target: { value: 'Nova tag' } })
  const description = screen.getByLabelText('Descrição — quando usar esta tag') as HTMLTextAreaElement
  expect(description.maxLength).toBe(280); expect(description.required).toBe(false)
  fireEvent.change(description, { target: { value: 'Critério opcional' } })
  fireEvent.click(screen.getByRole('button', { name: 'Criar tag' }))
  await screen.findByText('Tag salva.')
  expect(window.codeAwareness.mutateContinuumTags).toHaveBeenLastCalledWith({ repositoryId: 'A', intent: 'create', tag: { slug: 'nova-tag', name: 'Nova tag', description: 'Critério opcional' } })
  expect(screen.getByRole('button', { name: /Nova tag 0 Artifacts/ }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  expect(screen.queryByLabelText('Slug da tag')).toBeNull(); expect(screen.queryByLabelText('Cor da tag')).toBeNull()
  fireEvent.change(screen.getByLabelText('Nome da tag'), { target: { value: 'Renamed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar tag' }))
  await screen.findByRole('heading', { name: 'Renamed' })
  expect(window.codeAwareness.mutateContinuumTags).toHaveBeenLastCalledWith({ repositoryId: 'A', intent: 'edit', tag: { slug: 'nova-tag', name: 'Renamed', description: 'Critério opcional' } })
  fireEvent.click(screen.getByLabelText('Mais ações da tag'))
  fireEvent.click(screen.getByRole('button', { name: 'Excluir tag vazia' }))
  expect(window.codeAwareness.mutateContinuumTags).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar exclusão' }))
  await screen.findByText('Tag excluída.')
  expect(window.codeAwareness.mutateContinuumTags).toHaveBeenLastCalledWith({ repositoryId: 'A', intent: 'delete', slug: 'nova-tag' })
  expect(changed).toHaveBeenCalledTimes(3)
  fireEvent.click(screen.getByRole('button', { name: 'Ver todos (2)' }))
  expect(filter).toHaveBeenCalledWith('architecture'); expect(close).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Montar no Context Builder' }))
  expect(bundle).toHaveBeenCalledWith('architecture'); expect(close).toHaveBeenCalledTimes(2)
  expect(window.codeAwareness.quickContinuumBundle).not.toHaveBeenCalled()
  expect(totals).toHaveBeenCalled()
})

it('manager adversarial guards used tags, dirty forms, failed reads and stale repository/selection responses', async () => {
  const empty = { slug: 'empty', name: 'Empty', description: '', count: 0 }
  const catalog = [...tags, empty]
  let finishPreview!: (result: ContinuumTimeline) => void
  vi.mocked(window.codeAwareness.listContinuumArtifacts).mockImplementationOnce(() => new Promise(resolve => { finishPreview = resolve }))
  const changed = vi.fn(), close = vi.fn(), tokenTotals = vi.fn()
  const props = { tags: catalog, onFilter: vi.fn(), onBundle: vi.fn(), onChanged: changed, onClose: close, onTokenTotals: tokenTotals }
  const view = render(<ContinuumTagManager repositoryId="A" {...props} />)
  fireEvent.click(screen.getByLabelText('Mais ações da tag'))
  expect((screen.getByRole('button', { name: 'Excluir tag vazia' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /Empty 0 Artifacts/ }))
  await screen.findByText('Nenhum Artifact nesta tag.')
  await act(async () => finishPreview({ repositoryId: 'A', artifacts: [{ artifactId: 'stale', name: 'Stale preview', kind: 'DOCUMENT', updatedAt: '', relationCount: 0 }] }))
  expect(screen.queryByText('Stale preview')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  fireEvent.change(screen.getByLabelText('Nome da tag'), { target: { value: 'Unsaved' } })
  fireEvent.click(screen.getByRole('button', { name: /Architecture 2 Artifacts/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Fechar tags' }))
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(screen.getByRole('alert').textContent).toContain('não salvas'); expect(close).not.toHaveBeenCalled()
  expect((screen.getByLabelText('Nome da tag') as HTMLInputElement).value).toBe('Unsaved')
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar edição' }))
  expect(screen.getByRole('heading', { name: 'Empty' })).toBeTruthy()
  vi.mocked(window.codeAwareness.listContinuumArtifacts).mockRejectedValueOnce(new Error('READ_FAILED'))
  fireEvent.click(screen.getByRole('button', { name: /Architecture 2 Artifacts/ }))
  expect((await screen.findByRole('alert')).textContent).toContain('Não foi possível')
  fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
  await screen.findByText('Nenhum Artifact nesta tag.')
  let finishMutation!: (result: { repositoryId: string; tags: ContinuumTag[] }) => void
  let finishTokens!: (result: { repositoryId: string; totals: [] }) => void
  vi.mocked(window.codeAwareness.mutateContinuumTags).mockImplementationOnce(() => new Promise(resolve => { finishMutation = resolve }))
  vi.mocked(window.codeAwareness.getContinuumTagTokens).mockImplementationOnce(() => new Promise(resolve => { finishTokens = resolve })).mockRejectedValueOnce(new Error('TOKEN_FAILED'))
  view.rerender(<ContinuumTagManager repositoryId="B" {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Editar' }))
  fireEvent.change(screen.getByLabelText('Nome da tag'), { target: { value: 'Late mutation' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar tag' }))
  view.rerender(<ContinuumTagManager repositoryId="A" {...props} />)
  await act(async () => { finishMutation({ repositoryId: 'B', tags: [{ ...empty, name: 'Wrong repository' }] }); finishTokens({ repositoryId: 'B', totals: [] }) })
  expect(changed).not.toHaveBeenCalled(); expect(screen.queryByText('Tag salva.')).toBeNull(); expect(screen.queryByText('Wrong repository')).toBeNull()
  expect(within(screen.getByLabelText('Detalhes da tag')).getAllByText(/Tokens indisponíveis/).length).toBe(2)
  view.rerender(<ContinuumTagManager repositoryId="C" {...props} tags={[]} />)
  expect(screen.getByText('Nenhuma tag ainda. Crie sua primeira tag.')).toBeTruthy()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('opens a focused nonmodal picker, assigns through CAS, reports conflicts and restores focus on Escape', async () => {
  const changed = vi.fn()
  render(<ArtifactTagEditor repositoryId="A" artifact={artifact} tags={tags} onChanged={changed} />)
  expect(screen.queryByRole('checkbox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Tags do Artifact' }))
  expect(document.activeElement).toBe(screen.getByLabelText('Buscar ou criar tag'))
  vi.mocked(window.codeAwareness.mutateContinuumTags).mockRejectedValueOnce(new Error('REVISION_CONFLICT'))
  fireEvent.click(screen.getByRole('button', { name: 'Architecture' }))
  expect((await screen.findByRole('alert')).textContent).toContain('REVISION_CONFLICT')
  expect(window.codeAwareness.mutateContinuumTags).toHaveBeenCalledWith({ repositoryId: 'A', intent: 'assign', slug: 'architecture', assigned: false, confirmed: true, selected: [{ artifactId: 'one', expectedRevision: 7 }] })
  expect(changed).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByLabelText('Buscar ou criar tag'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Tags do Artifact' }))
})
it('creates the first tag with only a name and Enter, and never creates an empty name', async () => {
  const changed = vi.fn()
  render(<ArtifactTagEditor repositoryId="A" artifact={artifact} tags={[]} onChanged={changed} />)
  fireEvent.click(screen.getByRole('button', { name: 'Tags do Artifact' }))
  fireEvent.submit(screen.getByLabelText('Buscar ou criar tag').closest('form')!)
  expect(window.codeAwareness.mutateContinuumTags).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Buscar ou criar tag'), { target: { value: 'Primeira tag' } })
  fireEvent.submit(screen.getByLabelText('Buscar ou criar tag').closest('form')!)
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
  expect(window.codeAwareness.mutateContinuumTags).toHaveBeenCalledWith({ repositoryId: 'A', intent: 'quick-create', name: 'Primeira tag', selected: [{ artifactId: 'one', expectedRevision: 7 }] })
})
it('uses an existing exact name on Enter and discards late results after a context change', async () => {
  let finish!: (result: { repositoryId: string; tags: typeof tags }) => void
  vi.mocked(window.codeAwareness.mutateContinuumTags).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const changed = vi.fn(), view = render(<ArtifactTagEditor repositoryId="A" artifact={artifact} tags={tags} onChanged={changed} />)
  fireEvent.click(screen.getByRole('button', { name: 'Tags do Artifact' }))
  fireEvent.change(screen.getByLabelText('Buscar ou criar tag'), { target: { value: 'Architecture' } })
  fireEvent.submit(screen.getByLabelText('Buscar ou criar tag').closest('form')!)
  expect(window.codeAwareness.mutateContinuumTags).toHaveBeenCalledWith(expect.objectContaining({ intent: 'assign', slug: 'architecture', assigned: true }))
  view.rerender(<ArtifactTagEditor repositoryId="B" artifact={{ ...artifact, revision: 8 }} tags={tags} onChanged={changed} />)
  finish({ repositoryId: 'A', tags })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(changed).not.toHaveBeenCalled()
})
