// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ArtifactTagEditor, ContinuumTagManager } from './ContinuumTags'
const tags = [{ slug: 'architecture', name: 'Architecture', color: '#7852ee', description: 'Purpose', count: 2 }]
const artifact = { artifactId: 'one', revision: 7, metadata: { name: 'One', tags: ['architecture'] }, body: '# exact', createdAt: '', updatedAt: '' }
beforeEach(() => { window.codeAwareness = { mutateContinuumTags: vi.fn(async () => ({ repositoryId: 'A', tags })) } as unknown as Window['codeAwareness'] })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('assigns through the human IPC with exact artifact revision and keeps conflicts explicit', async () => {
  const changed = vi.fn()
  render(<ArtifactTagEditor repositoryId="A" artifact={artifact} tags={tags} onChanged={changed} />)
  vi.mocked(window.codeAwareness.mutateContinuumTags).mockRejectedValueOnce(new Error('REVISION_CONFLICT'))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Architecture' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('REVISION_CONFLICT'))
  expect(window.codeAwareness.mutateContinuumTags).toHaveBeenCalledWith({ repositoryId: 'A', intent: 'assign', slug: 'architecture', assigned: false, confirmed: true, selected: [{ artifactId: 'one', expectedRevision: 7 }] })
  expect(changed).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar revisão' })); expect(changed).toHaveBeenCalledTimes(1)
})
it('confirms only the explicitly selected IDs before batch changes and protects nonempty deletion', async () => {
  render(<ContinuumTagManager repositoryId="A" tags={tags} selected={[{ artifactId: 'selected', expectedRevision: 3 }]} onFilter={vi.fn()} onChanged={vi.fn()} onClose={vi.fn()} />)
  expect((screen.getByRole('button', { name: 'Excluir tag architecture' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar architecture à seleção' }))
  expect(window.codeAwareness.mutateContinuumTags).not.toHaveBeenCalled()
  expect(screen.getByText('selected · revisão 3')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar marcação' }))
  await waitFor(() => expect(window.codeAwareness.mutateContinuumTags).toHaveBeenCalledWith({ repositoryId: 'A', intent: 'assign', slug: 'architecture', assigned: true, confirmed: true, selected: [{ artifactId: 'selected', expectedRevision: 3 }] }))
})
it('edits display properties without changing slug and never sends mutation on filter selection', async () => {
  const filter = vi.fn()
  render(<ContinuumTagManager repositoryId="A" tags={tags} selected={[]} onFilter={filter} onChanged={vi.fn()} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Architecture 2' }))
  expect(filter).toHaveBeenCalledWith('architecture'); expect(window.codeAwareness.mutateContinuumTags).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Editar tag architecture' }))
  expect((screen.getByLabelText('Slug da tag') as HTMLInputElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Nome da tag'), { target: { value: 'Renamed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar tag' }))
  await waitFor(() => expect(window.codeAwareness.mutateContinuumTags).toHaveBeenCalledWith({ repositoryId: 'A', intent: 'edit', tag: { slug: 'architecture', name: 'Renamed', color: '#7852ee', description: 'Purpose' } }))
})
