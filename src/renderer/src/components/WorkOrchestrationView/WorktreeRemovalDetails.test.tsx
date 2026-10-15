// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorktreeRemovalDetails } from './WorktreeRemovalDetails'

afterEach(cleanup)
const context = { projectId: 'a', revision: 1 }
const tree = { worktreeId: 'a'.repeat(64), generation: 'b'.repeat(64), head: 'c'.repeat(40), reference: false } as any
const preview = { preparationId: '12345678-1234-1234-1234-123456789abc', fingerprint: 'd'.repeat(64), path: '/fixture', managed: false,
  state: 'PREPARING', blockers: [], content: [{ path: 'scratch.txt', bytes: 10, kind: 'UNTRACKED' }], preservedRef: 'refs/heads/attempt', intent: { delivery: null } }
async function prepare() {
  fireEvent.change(screen.getByLabelText('Contexto útil e motivo do abandono'), { target: { value: 'Abandonada; conhecimento retido' } })
  fireEvent.click(screen.getByLabelText('Confirmo que esta tentativa não tem Pull Request'))
  fireEvent.click(screen.getByText('Preparar para remoção'))
  await screen.findByText('Prévia disponível; revisão e consentimento obrigatórios')
}
it('does no background mutation and requires both release and exact content consent', async () => {
  const api = vi.fn().mockResolvedValue({ success: true, data: preview }), removed = vi.fn()
  window.codeAwareness = { manageWorktreeRemoval: api } as any
  render(<WorktreeRemovalDetails tree={tree} context={context} active removed={removed} />)
  expect(api).not.toHaveBeenCalled()
  await prepare()
  const remove = screen.getByText('Remover WorkTree') as HTMLButtonElement
  expect(remove.disabled).toBe(true)
  fireEvent.click(screen.getByLabelText(/Sou o proprietário/)); expect(remove.disabled).toBe(true)
  fireEvent.click(screen.getByLabelText(/Revisei todos/)); expect(remove.disabled).toBe(false)
  api.mockResolvedValueOnce({ success: true, data: { state: 'CLOSED' } })
  fireEvent.click(remove); await waitFor(() => expect(removed).toHaveBeenCalledTimes(1))
  expect(api.mock.calls[1][0].operation.consent).toMatchObject({ fingerprint: preview.fingerprint, exactPath: preview.path, discardPaths: ['scratch.txt'] })
})
it('cancels a preparation without executing removal and offers no automatic enrollment for external trees', async () => {
  const api = vi.fn().mockResolvedValue({ success: true, data: preview })
  window.codeAwareness = { manageWorktreeRemoval: api } as any
  render(<WorktreeRemovalDetails tree={tree} context={context} active removed={vi.fn()} />)
  await prepare()
  expect(screen.queryByText('Inscrever após liberar sessão gerenciada')).toBeNull()
  api.mockResolvedValueOnce({ success: true, data: { state: 'CANCELLED' } })
  fireEvent.click(screen.getByText('Cancelar preparação'))
  await screen.findByText('Preparar para remoção')
  expect(api.mock.calls.map(call => call[0].operation.action)).toEqual(['PREPARE', 'CANCEL'])
})
it('drops an old preparation after project change and ignores a late response', async () => {
  let resolve!: (response: any) => void
  const api = vi.fn(() => new Promise(done => { resolve = done }))
  window.codeAwareness = { manageWorktreeRemoval: api } as any
  const view = render(<WorktreeRemovalDetails tree={tree} context={context} active removed={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Contexto útil e motivo do abandono'), { target: { value: 'Abandonada' } })
  fireEvent.click(screen.getByLabelText('Confirmo que esta tentativa não tem Pull Request'))
  fireEvent.click(screen.getByText('Preparar para remoção'))
  view.rerender(<WorktreeRemovalDetails tree={tree} context={{ projectId: 'b', revision: 2 }} active removed={vi.fn()} />)
  resolve({ success: true, data: preview })
  await waitFor(() => expect((screen.getByText('Preparar para remoção') as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByText('Remover WorkTree')).toBeNull()
})
