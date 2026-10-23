// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ContinuumBundleComposer } from './ContinuumBundleComposer'
const preview = { repositoryId: 'A', snapshotId: 'snapshot-1', slug: 'architecture', tagName: 'Architecture', generatedAt: 'now', members: [{ artifactId: 'one', name: 'First', kind: 'DOCUMENT', revision: 2 }, { artifactId: 'visual', name: 'Visual', kind: 'VISUAL_REFERENCE', revision: 3, mediaPath: 'media/visual.webp' }], markdown: 'EXACT\r\n---\r\n# sources', markdownBytes: 30, tokenCount: 14, tokenizerEncoding: 'cl100k_base', hasVisuals: true }
beforeEach(() => { window.codeAwareness = { prepareContinuumBundle: vi.fn(async () => preview), exportContinuumBundle: vi.fn(async () => ({ snapshotId: preview.snapshotId, outcome: 'copied' })) } as unknown as Window['codeAwareness'] })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('shows coherent members, revision and tokens, warns about visual clipboard limits and exports only the prepared snapshot', async () => {
  render(<ContinuumBundleComposer repositoryId="A" slug="architecture" onClose={vi.fn()} />)
  await waitFor(() => expect((screen.getByLabelText('Prévia do Context Bundle') as HTMLTextAreaElement).value).toBe(preview.markdown.replace(/\r\n/g, '\n')))
  expect(window.codeAwareness.prepareContinuumBundle).toHaveBeenCalledWith({ repositoryId: 'A', slug: 'architecture' })
  expect(screen.queryByLabelText('Objetivo do Context Bundle')).toBeNull()
  expect(screen.getByText(/pixels WebP não são transmitidos/)).toBeTruthy()
  expect(screen.getByText(/cl100k_base/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Copiar Context Bundle' }))
  await screen.findByText('Context Bundle copiado.')
  expect(window.codeAwareness.exportContinuumBundle).toHaveBeenCalledWith({ repositoryId: 'A', snapshotId: 'snapshot-1', intent: 'copy' })
  fireEvent.click(screen.getByRole('button', { name: 'Salvar pacote ZIP completo' }))
  await waitFor(() => expect(window.codeAwareness.exportContinuumBundle).toHaveBeenLastCalledWith({ repositoryId: 'A', snapshotId: 'snapshot-1', intent: 'zip' }))
})
it('requires regeneration after human ordering changes and stale snapshot errors', async () => {
  render(<ContinuumBundleComposer repositoryId="A" slug="architecture" onClose={vi.fn()} />)
  await waitFor(() => expect((screen.getByLabelText('Prévia do Context Bundle') as HTMLTextAreaElement).value).toBe(preview.markdown.replace(/\r\n/g, '\n')))
  fireEvent.click(screen.getByRole('button', { name: 'Mover visual acima' }))
  expect((screen.getByRole('button', { name: 'Copiar Context Bundle' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Regenerar Context Bundle' }))
  await waitFor(() => expect(window.codeAwareness.prepareContinuumBundle).toHaveBeenLastCalledWith({ repositoryId: 'A', slug: 'architecture', order: ['visual', 'one'] }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Copiar Context Bundle' }) as HTMLButtonElement).disabled).toBe(false))
  vi.mocked(window.codeAwareness.exportContinuumBundle).mockRejectedValueOnce(new Error('BUNDLE_SNAPSHOT_STALE'))
  fireEvent.click(screen.getByRole('button', { name: 'Copiar Context Bundle' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('BUNDLE_SNAPSHOT_STALE'))
  expect((screen.getByRole('button', { name: 'Salvar Markdown do Bundle' }) as HTMLButtonElement).disabled).toBe(true)
})
it('never shows a delayed result from an unmounted repository context', async () => {
  let finish!: (value: any) => void
  vi.mocked(window.codeAwareness.prepareContinuumBundle).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = render(<ContinuumBundleComposer repositoryId="A" slug="architecture" onClose={vi.fn()} />)
  view.unmount()
  await act(async () => finish(preview))
  expect(screen.queryByText(/Context Bundle copiado/)).toBeNull()
})
