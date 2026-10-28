// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
it('unions overlapping components, excludes and reintroduces members, previews only on demand and routes export explicitly', async () => {
  render(<ContextBundleBuilder repositoryId="A" facets={[]} tags={[{ slug: 'atlas', name: 'Git Atlas', count: 1, description: 'data only' }]} onClose={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: /Source DOCUMENT/ }))
  await screen.findByText('1 Artifacts únicos')
  fireEvent.click(screen.getByRole('button', { name: 'Tags' }))
  fireEvent.click(screen.getByRole('button', { name: /Git Atlas/ }))
  await waitFor(() => expect(document.querySelectorAll('.continuum-builder-components > div')).toHaveLength(2))
  expect(document.querySelectorAll('.continuum-builder-members li')).toHaveLength(1)
  expect(window.codeAwareness.continuumBuilder).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'preview' }))
  fireEvent.click(screen.getByLabelText('Retirar Source'))
  await screen.findByText('0 Artifacts únicos')
  fireEvent.click(screen.getByText('1 excluídos manualmente'))
  fireEvent.click(screen.getByRole('button', { name: 'Reintroduzir Source' }))
  fireEvent.click(screen.getByRole('button', { name: 'Gerar prévia' }))
  expect((await screen.findByLabelText('Prévia do pacote')).textContent).toBe('# context')
  fireEvent.click(screen.getByRole('button', { name: 'Copiar contexto' }))
  await screen.findByText('Contexto copiado.')
  expect(window.codeAwareness.continuumBuilder).toHaveBeenCalledWith(expect.objectContaining({ action: 'export', intent: 'copy' }))
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
it('explains zero savings and invalidates the diagnostic when the compression profile changes', async () => {
  const api = vi.mocked(window.codeAwareness.continuumBuilder), original = api.getMockImplementation()!
  api.mockImplementation(async request => request.action === 'preview'
    ? { ...await original(request) as any, compression: { profile: 'strong', applied: false, outcome: 'no-eligible-blocks', originalTokens: 30, outputTokens: 30, savedTokens: 0, savedPercent: 0, transformedBlocks: 0, detectedBlocks: 0, rejectedBlocks: 0, unchangedBlocks: 0, reason: 'Nenhum bloco estruturado elegível detectado.' } }
    : original(request))
  render(<ContextBundleBuilder repositoryId="A" facets={[]} tags={[]} onClose={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: /Source DOCUMENT/ }))
  await screen.findByText('1 Artifacts únicos')
  fireEvent.change(screen.getByLabelText('Compressão PAKT'), { target: { value: 'strong' } })
  fireEvent.click(screen.getByRole('button', { name: 'Gerar prévia' }))
  await screen.findByText('Sem redução neste pacote')
  fireEvent.click(screen.getByText('Diagnóstico da compressão'))
  expect(screen.getByText(/0 blocos detectados/).textContent).toContain('0 transformados')
  expect(api).toHaveBeenCalledWith(expect.objectContaining({ action: 'preview', profile: 'strong' }))
  fireEvent.change(screen.getByLabelText('Compressão PAKT'), { target: { value: 'off' } })
  expect(screen.queryByText('Sem redução neste pacote')).toBeNull()
  expect(screen.queryByLabelText('Prévia do pacote')).toBeNull()
})
