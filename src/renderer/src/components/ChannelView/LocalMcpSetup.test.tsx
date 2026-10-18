// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { LocalMcpSetup } from './LocalMcpSetup'
import type { LocalMcpAction, LocalMcpClientApi, LocalMcpClientState } from '../../../../shared/types/local-mcp-client-types'
afterEach(cleanup)
const row: LocalMcpClientState = { id: 'codex', name: 'Codex', path: 'C:/user/.codex/config.toml', detected: true, configuration: 'ABSENT', launcherPresent: false, bootstrap: 'NOT_CHECKED', clientUse: 'NOT_CONFIRMED' }
function setup(conflict = false) {
  const api = { detect: vi.fn(async () => [row, { ...row, id: 'antigravity', name: 'Antigravity' }, { ...row, id: 'cline', name: 'Cline', detected: false, configuration: 'UNSUPPORTED' }]),
    verify: vi.fn(async () => ({ ...row, configuration: 'INSTALLED', bootstrap: 'ERROR', diagnostic: 'MCP_SESSION_INVALIDATED' })),
    preview: vi.fn(async (_id: string, action: LocalMcpAction) => ({ token: 'preview', client: 'codex', path: row.path, action, before: 'Nenhuma entrada', after: '{"command":"node"}', launcherPath: 'C:/local/launcher.cjs', conflict, changes: true, restartRequired: true })),
    apply: vi.fn(async () => ({ ...row, configuration: 'INSTALLED', launcherPresent: true })) }
  window.codeAwareness = { localMcpClients: api as unknown as LocalMcpClientApi } as Window['codeAwareness']
  const view = render(<LocalMcpSetup />)
  return { ...api, view }
}
async function detect() {
  fireEvent.click(screen.getByRole('button', { name: 'Detectar' }))
  await within(screen.getByRole('article', { name: 'Codex' })).findByText('Disponível para instalação')
}
it('requires preview and specific confirmation before writing; preserves the distinction between installed and used', async () => {
  const api = setup()
  await detect()
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
  await detect()
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
  await within(screen.getByRole('article', { name: 'Codex' })).findByText('Disponível para instalação')
  const select = await screen.findByRole('combobox', { name: 'Destino Cline' })
  expect(screen.getAllByRole('article')).toHaveLength(3)
  expect(screen.getAllByRole('heading', { level: 3 }).map(node => node.textContent)).toEqual(['Codex', 'Antigravity', 'Cline'])
  fireEvent.change(select, { target: { value: 'cline-vscode' } })
  fireEvent.click(within(screen.getByRole('article', { name: 'Cline' })).getByRole('button', { name: 'Conectar' }))
  await screen.findByLabelText('Prévia da configuração')
  expect(api.preview).toHaveBeenCalledWith('cline-vscode', 'connect')
  expect(screen.getAllByRole('article')).toHaveLength(3)
})

it('renders three neutral cards before any lookup and only detects on an explicit click', async () => {
  const api = setup()
  expect(screen.getAllByRole('article')).toHaveLength(3)
  expect(screen.getAllByText('Não verificado')).toHaveLength(3)
  expect(api.detect).not.toHaveBeenCalled()
  expect(api.verify).not.toHaveBeenCalled()
  expect(api.preview).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toMatch(/Launcher: ausente|Configurado|Disponível para instalação|falhou/)
  api.view.rerender(<LocalMcpSetup active={false} />)
  api.view.rerender(<LocalMcpSetup active />)
  expect(api.detect).not.toHaveBeenCalled()
  await detect()
  expect(api.detect).toHaveBeenCalledTimes(1)
  expect(screen.getAllByRole('article')).toHaveLength(3)
})

it('discards hidden previews and all consent while retaining the selection and client snapshot', async () => {
  const api = setup(true)
  await detect()
  const selector = screen.getByRole('combobox', { name: 'Destino Cline' }) as HTMLSelectElement
  fireEvent.change(selector, { target: { value: 'cline-vscode' } })
  const card = within(screen.getByRole('article', { name: 'Codex' }))
  fireEvent.click(card.getByRole('button', { name: 'Conectar' }))
  await screen.findByLabelText('Prévia da configuração')
  fireEvent.click(screen.getByLabelText('Confirmo a operação neste destino'))
  fireEvent.click(screen.getByLabelText('Substituir explicitamente a entrada divergente Code Awareness'))
  api.view.rerender(<LocalMcpSetup active={false} />)
  api.view.rerender(<LocalMcpSetup active />)
  expect(screen.queryByLabelText('Prévia da configuração')).toBeNull()
  expect(selector.value).toBe('cline-vscode')
  expect(card.getByText('Disponível para instalação')).toBeTruthy()
  fireEvent.click(card.getByRole('button', { name: 'Conectar' }))
  await screen.findByLabelText('Prévia da configuração')
  expect((screen.getByLabelText('Confirmo a operação neste destino') as HTMLInputElement).checked).toBe(false)
  expect((screen.getByLabelText('Substituir explicitamente a entrada divergente Code Awareness') as HTMLInputElement).checked).toBe(false)
  expect(api.apply).not.toHaveBeenCalled()
  expect(api.detect).toHaveBeenCalledTimes(1)
})

it('does not resurrect an outstanding preview after hiding and reactivating', async () => {
  const api = setup()
  await detect()
  let finish!: (preview: Awaited<ReturnType<typeof api.preview>>) => void
  const original = await api.preview('codex', 'connect')
  api.preview.mockClear()
  api.preview.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  fireEvent.click(within(screen.getByRole('article', { name: 'Codex' })).getByRole('button', { name: 'Conectar' }))
  api.view.rerender(<LocalMcpSetup active={false} />)
  api.view.rerender(<LocalMcpSetup active />)
  await act(async () => finish(original))
  expect(screen.queryByLabelText('Prévia da configuração')).toBeNull()
  expect(api.preview).toHaveBeenCalledTimes(1)
  expect(api.apply).not.toHaveBeenCalled()
})

it.each(['success', 'revision-error'])('reconciles a mutation completing while hidden (%s) without a second execution', async outcome => {
  const api = setup()
  await detect()
  const card = within(screen.getByRole('article', { name: 'Codex' }))
  fireEvent.click(card.getByRole('button', { name: 'Conectar' }))
  await screen.findByLabelText('Prévia da configuração')
  let finish!: (state: Awaited<ReturnType<typeof api.apply>>) => void, fail!: (error: Error) => void
  api.apply.mockReturnValueOnce(new Promise((resolve, reject) => { finish = resolve; fail = reject }))
  fireEvent.click(screen.getByLabelText('Confirmo a operação neste destino'))
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar conectar' }))
  api.view.rerender(<LocalMcpSetup active={false} />)
  await act(async () => {
    if (outcome === 'success') finish({ ...row, configuration: 'INSTALLED', launcherPresent: true })
    else fail(new Error('CONFIG_REVISION_CONFLICT'))
  })
  api.view.rerender(<LocalMcpSetup active />)
  expect(screen.queryByLabelText('Prévia da configuração')).toBeNull()
  if (outcome === 'success') expect(card.getByText('Configurado')).toBeTruthy()
  else expect(screen.getByRole('alert').textContent).toContain('O arquivo mudou desde a prévia')
  expect(api.apply).toHaveBeenCalledTimes(1)
  expect(api.detect).toHaveBeenCalledTimes(1)
})

it('repairs and disconnects the selected client with confirmation and no global redetection', async () => {
  const api = setup()
  await detect()
  const card = within(screen.getByRole('article', { name: 'Codex' }))
  for (const [trigger, confirm, installed] of [['Conectar', 'Confirmar conectar', true], ['Reparar / atualizar', 'Confirmar reparar / atualizar', true], ['Desconectar', 'Confirmar desconectar', false]] as const) {
    api.apply.mockResolvedValueOnce({ ...row, configuration: installed ? 'INSTALLED' : 'ABSENT', launcherPresent: true })
    fireEvent.click(card.getByRole('button', { name: trigger }))
    await screen.findByLabelText('Prévia da configuração')
    fireEvent.click(screen.getByLabelText('Confirmo a operação neste destino'))
    fireEvent.click(screen.getByRole('button', { name: confirm }))
    await card.findByText(installed ? 'Configurado' : 'Disponível para instalação')
  }
  expect(api.preview.mock.calls.map(call => call[1])).toEqual(['connect', 'repair', 'disconnect'])
  expect(api.apply).toHaveBeenCalledTimes(3)
  expect(api.detect).toHaveBeenCalledTimes(1)
})
