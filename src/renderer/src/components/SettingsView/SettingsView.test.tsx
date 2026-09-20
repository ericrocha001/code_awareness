// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatGptIntegrationState } from '../../../../shared/types/chatgpt-integration-types'
import { SettingsView } from './SettingsView'

let state: ChatGptIntegrationState
let receive: (state: ChatGptIntegrationState) => void
const unsubscribe = vi.fn()
beforeEach(() => {
  state = { revision: 1, status: 'READY', remoteAccessEnabled: true, transport: 'relay', connectionStatus: 'CONNECTED', mcpStatus: 'RUNNING', activeProject: { id: 'A', name: 'project-a' }, installationConfigured: true, codeScopeStatus: 'OPERATIONAL', lastSuccessfulToolCall: 'discover_repository', lastSuccessfulAt: '2026-09-17T20:00:00.000Z', lastFailedToolCall: null, lastFailedAt: null, lastFailureStage: null, lastError: null }
  unsubscribe.mockClear()
  window.codeAwareness = {
    getChatGptIntegrationState: vi.fn(async () => state),
    onChatGptIntegrationChanged: vi.fn((callback) => { receive = callback; return unsubscribe }),
    connect: vi.fn(async () => ({ success: true })), disconnect: vi.fn(async () => ({ success: true }))
  } as unknown as Window['codeAwareness']
})
afterEach(cleanup)

it.each([
  ['READY', 'Pronto para o ChatGPT'], ['WAITING_FOR_PROJECT', 'Aguardando um projeto'], ['DISABLED', 'O acesso remoto está desativado'],
  ['NEEDS_ATTENTION', 'Requer atenção'], ['OFFLINE', 'Temporariamente offline'], ['SETUP_REQUIRED', 'Configuração necessária'], ['CONNECTING', 'Conectando…']
] as const)('renders %s as a product state', async (status, title) => {
  state.status = status
  render(<SettingsView />)
  expect(await screen.findByText(title)).toBeTruthy()
  expect(screen.queryByText('ChatGPT Connected')).toBeNull()
})

it('shows current project and collapsible sanitized diagnostics', async () => {
  state.lastError = 'INVALID_CREDENTIAL'; state.status = 'NEEDS_ATTENTION'
  const view = render(<SettingsView />)
  await screen.findByText('Requer atenção')
  const details = view.container.querySelector('details')!
  expect(details.open).toBe(false)
  fireEvent.click(screen.getByText('Diagnóstico'))
  expect(details.open).toBe(true)
  expect(screen.getByText('INVALID_CREDENTIAL')).toBeTruthy()
  expect(screen.getAllByText('project-a')).toHaveLength(2)
  expect(screen.getByText('Configurada')).toBeTruthy()
  expect(screen.getByText('OPERATIONAL')).toBeTruthy()
  expect(screen.getByText(/discover_repository/)).toBeTruthy()
})

it('invokes existing enable/disable intents without optimistic state or remount', async () => {
  state.status = 'DISABLED'; state.remoteAccessEnabled = false
  const view = render(<SettingsView />)
  fireEvent.click(await screen.findByRole('button', { name: 'Ativar acesso remoto' }))
  await waitFor(() => expect(window.codeAwareness.connect).toHaveBeenCalledTimes(1))
  expect(screen.getByText('O acesso remoto está desativado')).toBeTruthy()
  act(() => { state = { ...state, revision: 2, status: 'READY', remoteAccessEnabled: true }; receive(state) })
  fireEvent.click(await screen.findByRole('button', { name: 'Desativar acesso remoto' }))
  await waitFor(() => expect(window.codeAwareness.disconnect).toHaveBeenCalledTimes(1))
  act(() => receive({ ...state, revision: 3, status: 'WAITING_FOR_PROJECT', activeProject: null }))
  expect(screen.queryByText('project-a')).toBeNull()
  expect(screen.getByText('Aguardando um projeto')).toBeTruthy()
  view.unmount(); expect(unsubscribe).toHaveBeenCalledTimes(1)
})

it('does not overwrite a new event with stale query data', async () => {
  let resolve!: (state: ChatGptIntegrationState) => void
  vi.mocked(window.codeAwareness.getChatGptIntegrationState).mockReturnValue(new Promise((done) => { resolve = done }))
  render(<SettingsView />)
  act(() => receive({ ...state, revision: 5, status: 'WAITING_FOR_PROJECT', activeProject: null }))
  await act(async () => resolve(state))
  expect(screen.queryByText('project-a')).toBeNull()
})

it('presents ngrok as development transport and never displays operation exception details', async () => {
  state.status = 'NEEDS_ATTENTION'; state.transport = 'ngrok'; state.lastError = 'DEVELOPMENT_TRANSPORT'
  vi.mocked(window.codeAwareness.disconnect).mockRejectedValue(new Error('secret JWT credential'))
  render(<SettingsView />)
  expect(await screen.findByText('Transporte de desenvolvimento ativo')).toBeTruthy()
  expect(screen.queryByText('Pronto para o ChatGPT')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Desativar acesso remoto' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(document.body.textContent).not.toContain('secret JWT credential')
})
