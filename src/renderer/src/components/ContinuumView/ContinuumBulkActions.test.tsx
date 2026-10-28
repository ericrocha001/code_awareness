// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ContinuumBulkActions } from './ContinuumBulkActions'

afterEach(cleanup)
const selected = ['one', 'two'].map(artifactId => ({ artifactId, revision: 3, name: artifactId, kind: 'DOCUMENT', updatedAt: '', relationCount: 0, rawMarkdownTokenCount: 10 }))
const sources = [{ artifactId: 'one', expectedRevision: 3 }, { artifactId: 'two', expectedRevision: 3 }]

beforeEach(() => {
  window.codeAwareness = {
    mutateContinuumTags: vi.fn(async () => ({ repositoryId: 'A', tags: [] })),
    quickContinuumBundle: vi.fn(async () => ({ repositoryId: 'A', slug: '', count: 2, outcome: 'copied', hasVisuals: false, markdownBytes: 100, tokenCount: 50, tokenizerEncoding: 'cl100k_base', snapshotId: 'snap' }))
  } as unknown as Window['codeAwareness']
})

it('blocks all actions when disabled', () => {
  const clear = vi.fn()
  render(<ContinuumBulkActions repositoryId="A" selected={selected} tags={[]} onClear={clear} onChanged={vi.fn()} onBusy={vi.fn()} disabled />)
  for (const name of ['Adicionar tag', 'Montar pacote', 'Limpar seleção']) {
    const button = screen.getByRole('button', { name }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
  }
  expect(window.codeAwareness.quickContinuumBundle).not.toHaveBeenCalled()
  expect(clear).not.toHaveBeenCalled()
})

it('opens the single builder without exporting the selection', () => {
  const bundle = vi.fn()
  render(<ContinuumBulkActions repositoryId="A" selected={selected} tags={[]} onBundle={bundle} onClear={vi.fn()} onChanged={vi.fn()} onBusy={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Montar pacote' }))
  expect(bundle).toHaveBeenCalledTimes(1)
  expect(window.codeAwareness.quickContinuumBundle).not.toHaveBeenCalled()
})

it('requires deliberate bulk tag confirmation, sends every revision and clears only on success', async () => {
  const mutate = vi.fn().mockRejectedValueOnce(new Error('REVISION_CONFLICT')).mockResolvedValue({ repositoryId: 'A', tags: [] })
  window.codeAwareness = { mutateContinuumTags: mutate, quickContinuumBundle: vi.fn() } as unknown as Window['codeAwareness']
  const clear = vi.fn(), changed = vi.fn(), busy = vi.fn()
  render(<ContinuumBulkActions repositoryId="A" selected={selected} tags={[{ slug: 'existing', name: 'Existing', description: '', count: 0 }]} onClear={clear} onChanged={changed} onBusy={busy} />)
  fireEvent.click(screen.getByText('Adicionar tag'))
  fireEvent.change(screen.getByLabelText('Tag da seleção'), { target: { value: 'Existing' } })
  expect(mutate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Confirmar tag em 2 Artifacts'))
  expect((await screen.findByRole('alert')).textContent).toContain('REVISION_CONFLICT')
  expect(clear).not.toHaveBeenCalled()
  expect(mutate).toHaveBeenCalledWith({ repositoryId: 'A', intent: 'assign', slug: 'existing', assigned: true, confirmed: true, selected: sources })
  fireEvent.change(screen.getByLabelText('Tag da seleção'), { target: { value: 'New tag' } })
  fireEvent.click(screen.getByText('Confirmar tag em 2 Artifacts'))
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
  expect(clear).toHaveBeenCalledTimes(1)
  expect(busy).toHaveBeenLastCalledWith(false)
  expect(mutate).toHaveBeenLastCalledWith(expect.objectContaining({ intent: 'quick-create', name: 'New tag', selected: expect.any(Array) }))
})
