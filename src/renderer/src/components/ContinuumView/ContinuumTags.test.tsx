// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ArtifactTagEditor, ContinuumTagManager } from './ContinuumTags'
const tags = [{ slug: 'architecture', name: 'Architecture', count: 2 }]
const artifact = { artifactId: 'one', revision: 7, metadata: { name: 'One', tags: ['architecture'] }, body: '# exact', createdAt: '', updatedAt: '' }
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  window.codeAwareness = { mutateContinuumTags: vi.fn(async () => ({ repositoryId: 'A', tags })), quickContinuumBundle: vi.fn(async () => ({ repositoryId: 'A', outcome: 'copied', count: 2, tokenCount: 20, tokenizerEncoding: 'cl100k_base', hasVisuals: true })) } as unknown as Window['codeAwareness']
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
it('copies once without opening composer, warns about pixels, protects deletion and edits stable identity', async () => {
  const filter = vi.fn(), composer = vi.fn()
  render(<ContinuumTagManager repositoryId="A" tags={tags} onFilter={filter} onBundle={composer} onChanged={vi.fn()} onClose={vi.fn()} />)
  expect((screen.getByRole('button', { name: 'Excluir tag architecture', hidden: true }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Copiar contexto Architecture' }))
  expect((await screen.findByRole('status')).textContent).toContain('salve o ZIP completo')
  expect(window.codeAwareness.quickContinuumBundle).toHaveBeenCalledExactlyOnceWith({ repositoryId: 'A', slug: 'architecture', intent: 'copy' })
  expect(composer).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Architecture 2' }))
  expect(filter).toHaveBeenCalledWith('architecture')
  fireEvent.click(document.querySelector('summary[aria-label]')!)
  fireEvent.click(screen.getByRole('button', { name: 'Editar tag' }))
  expect(screen.queryByLabelText('Slug da tag')).toBeNull()
  expect(screen.queryByLabelText('Cor da tag')).toBeNull()
  expect(screen.queryByLabelText('Objetivo da tag')).toBeNull()
  fireEvent.change(screen.getByLabelText('Nome da tag'), { target: { value: 'Renamed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar tag' }))
  await waitFor(() => expect(window.codeAwareness.mutateContinuumTags).toHaveBeenCalledWith({ repositoryId: 'A', intent: 'edit', tag: { slug: 'architecture', name: 'Renamed' } }))
})
