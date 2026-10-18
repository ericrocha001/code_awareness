// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { LocalMcpSetup } from './LocalMcpSetup'
import type { LocalMcpClientApi, LocalMcpClientState } from '../../../../shared/types/local-mcp-client-types'
afterEach(cleanup)
const row: LocalMcpClientState = { id: 'codex', name: 'Codex', path: 'C:/user/.codex/config.toml', detected: true, configuration: 'ABSENT', launcherPresent: false, bootstrap: 'NOT_CHECKED', clientUse: 'NOT_CONFIRMED' }
function setup(conflict = false) {
  const api = { detect: vi.fn(async () => [row, { ...row, id: 'antigravity', name: 'Antigravity' }, { ...row, id: 'cline', name: 'Cline', detected: false, configuration: 'UNSUPPORTED' }]),
    verify: vi.fn(async () => ({ ...row, configuration: 'INSTALLED', bootstrap: 'ERROR', diagnostic: 'MCP_SESSION_INVALIDATED' })),
    preview: vi.fn(async () => ({ token: 'preview', client: 'codex', path: row.path, action: 'connect', before: 'Nenhuma entrada', after: '{"command":"node"}', launcherPath: 'C:/local/launcher.cjs', conflict, changes: true, restartRequired: true })),
    apply: vi.fn(async () => ({ ...row, configuration: 'INSTALLED', launcherPresent: true })) }
  window.codeAwareness = { localMcpClients: api as unknown as LocalMcpClientApi } as Window['codeAwareness']
  render(<LocalMcpSetup />)
  return api
}
it('requires preview and specific confirmation before writing; preserves the distinction between installed and used', async () => {
  const api = setup()
  const card = within(await screen.findByRole('article', { name: 'Codex' }))
  fireEvent.click(card.getByRole('button', { name: 'Conectar' }))
  const preview = within(await screen.findByLabelText('Prévia da configuração'))
  expect(api.apply).not.toHaveBeenCalled()
  expect((preview.getByRole('button', { name: 'Confirmar conectar' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(preview.getByLabelText('Confirmo a operação neste destino'))
  fireEvent.click(preview.getByRole('button', { name: 'Confirmar conectar' }))
  expect(await card.findByText('Configurado')).toBeTruthy()
  expect(api.apply).toHaveBeenCalledWith('preview', true, false)
  expect(card.getByText(/Uso pelo cliente: não confirmado/)).toBeTruthy()
})
it('requires an additional explicit choice for a conflicting entry and supports cancellation without writes', async () => {
  const api = setup(true)
  fireEvent.click(within(await screen.findByRole('article', { name: 'Codex' })).getByRole('button', { name: 'Conectar' }))
  const preview = within(await screen.findByLabelText('Prévia da configuração'))
  fireEvent.click(preview.getByLabelText('Confirmo a operação neste destino'))
  expect((preview.getByRole('button', { name: 'Confirmar conectar' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(preview.getByRole('button', { name: 'Cancelar' }))
  expect(api.apply).not.toHaveBeenCalled()
})
it('verifies session failure without repairing or claiming client acceptance', async () => {
  const api = setup()
  const card = within(await screen.findByRole('article', { name: 'Codex' }))
  fireEvent.click(card.getByRole('button', { name: 'Verificar' }))
  expect(await card.findByText(/Sessão do cliente invalidada/)).toBeTruthy()
  expect(api.preview).not.toHaveBeenCalled()
  expect(api.apply).not.toHaveBeenCalled()
})

it('renders exactly three client cards and keeps variants inside their owning card', async () => {
  const api = setup()
  await screen.findByRole('article', { name: 'Cline' })
  api.detect.mockResolvedValueOnce([row, { ...row, id: 'antigravity', name: 'Antigravity 2.0 · plugin' },
    { ...row, id: 'antigravity-settings', name: 'IDE fallback' }, { ...row, id: 'cline', name: 'Desktop · Agent Plugin v1' },
    { ...row, id: 'cline-settings', name: 'Desktop fallback' }, { ...row, id: 'cline-vscode', name: 'VS Code fallback' }] as never)
  fireEvent.click(screen.getByRole('button', { name: 'Detectar' }))
  const select = await screen.findByRole('combobox', { name: 'Destino Cline' })
  expect(screen.getAllByRole('article')).toHaveLength(3)
  expect(screen.getAllByRole('heading', { level: 3 }).map(node => node.textContent)).toEqual(['Codex', 'Antigravity', 'Cline'])
  fireEvent.change(select, { target: { value: 'cline-vscode' } })
  fireEvent.click(within(screen.getByRole('article', { name: 'Cline' })).getByRole('button', { name: 'Conectar' }))
  await screen.findByLabelText('Prévia da configuração')
  expect(api.preview).toHaveBeenCalledWith('cline-vscode', 'connect')
  expect(screen.getAllByRole('article')).toHaveLength(3)
})
