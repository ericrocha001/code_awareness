// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChannelState } from '../../../../shared/types/channel-state-types'
import type { ConnectionResult } from '../../../../shared/types/connection-types'
import { ChannelView } from './ChannelView'
import { NAV_ITEMS, type NavId } from '../../config/navigation'
import { GlobalSidebarNav } from '../GlobalSidebar/GlobalSidebarNav'

let state: ChannelState
let receive: (state: ChannelState) => void
const unsubscribe = vi.fn()
beforeEach(() => {
  state = { revision: 1, availability: 'READY', remoteAccessEnabled: true, transport: 'relay', connectionStatus: 'CONNECTED', mcpStatus: 'RUNNING', activeProject: { id: 'A', name: 'project-a' }, installationConfigured: true,
    lastError: null, functionalHealth: { status: 'UNKNOWN', lastSuccessfulToolCall: null, lastSuccessfulAt: null, lastFailedToolCall: null, lastFailedAt: null, lastFailureStage: null, lastError: null, lastStageLatencyMs: null, lastDeadlineRemainingMs: null },
    activity: { activeRequests: 0, peakConcurrentRequests: 0, totalRequests: 0, succeededRequests: 0, failedRequests: 0, timedOutRequests: 0, latency: { completedRequests: 0, totalDurationMs: 0, lastDurationMs: null, maxDurationMs: null }, byTool: {}, byCapability: {} }
  }
  unsubscribe.mockClear()
  window.codeAwareness = {
    getChannelState: vi.fn(async () => structuredClone(state)),
    onChannelChanged: vi.fn(callback => { receive = callback; return unsubscribe }),
    connect: vi.fn(async () => ({ success: true })), disconnect: vi.fn(async () => ({ success: true })),
    getSystemHealthState: vi.fn(async () => ({ status: 'UNKNOWN', stale: false, lastFailure: { operation: 'read_code', at: '2026-10-06T10:00:00Z', traceId: 'trace', firstFailedBoundary: 'CodeScope Execution', lastSuccessfulStage: 'MCP Dispatch', reasonCode: 'INVALID_TARGET', stages: [{ stage: 'CodeScope Execution', status: 'FAILED', durationMs: 10, reasonCode: 'INVALID_TARGET' }] }, lastFunctionalProof: null })),
    onSystemHealthChanged: vi.fn(() => () => {})
  } as unknown as Window['codeAwareness']
})
afterEach(cleanup)

it('opens Channel through navigation immediately after Home and removes Settings', async () => {
  expect(NAV_ITEMS.slice(0, 2).map(item => item.id)).toEqual(['home', 'channel'])
  expect(NAV_ITEMS.some(item => item.label === 'Settings')).toBe(false)
  function Navigation() {
    const [tab, setTab] = React.useState<NavId>('home')
    return <><GlobalSidebarNav items={NAV_ITEMS} activeTab={tab} onSelect={setTab} isSidebarOpen />{tab === 'channel' && <ChannelView />}</>
  }
  render(<Navigation />)
  expect(screen.queryByRole('heading', { name: 'Code Awareness Channel' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Channel' }))
  expect(await screen.findByRole('heading', { name: 'Code Awareness Channel' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Channel' }).getAttribute('aria-current')).toBe('page')
})

it.each([
  ['READY', 'Pronto para acesso remoto'], ['WAITING_FOR_PROJECT', 'Aguardando um projeto'], ['DISABLED', 'Acesso remoto desativado'],
  ['ERROR', 'A conexão requer atenção'], ['OFFLINE', 'Temporariamente offline'], ['SETUP_REQUIRED', 'Configuração necessária'], ['CONNECTING', 'Conectando…']
] as const)('renders %s locally', async (availability, title) => {
  state.availability = availability
  render(<ChannelView />)
  expect(await screen.findByText(title)).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Code Awareness Channel' })).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/CodeScope|Settings/)
})

it.each(['UNKNOWN', 'OPERATIONAL', 'DEGRADED'] as const)('separates READY from %s', async status => {
  state.functionalHealth.status = status
  render(<ChannelView />)
  expect(await screen.findByText(status === 'DEGRADED' ? 'Disponível · operação requer atenção' : 'Pronto para acesso remoto')).toBeTruthy()
})

it('shows empty runtime counters without invented capabilities or latency', async () => {
  render(<ChannelView />)
  await screen.findByText('Pronto para acesso remoto')
  expect(screen.getByText(/Nenhuma capacidade observada/)).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.getByText('Latência média').nextElementSibling?.textContent).toBe('—')
  expect(screen.getByText('Chamadas ativas').nextElementSibling?.textContent).toBe('0')
})

it('renders reactive runtime and observed capability aggregates without a byTool table', async () => {
  render(<ChannelView />)
  await screen.findByText('Pronto para acesso remoto')
  const counters = { ...state.activity, activeRequests: 2, peakConcurrentRequests: 4, totalRequests: 8, succeededRequests: 4, failedRequests: 1, timedOutRequests: 1, latency: { completedRequests: 6, totalDurationMs: 180, lastDurationMs: 20, maxDurationMs: 60 } }
  act(() => receive({ ...state, revision: 2, activity: { ...counters, byTool: { secret_tool: counters }, byCapability: { 'Code Navigation': counters, Continuum: { ...counters, totalRequests: 3 } } } }))
  expect(screen.getByText('Chamadas ativas').nextElementSibling?.textContent).toBe('2')
  expect(screen.getByText('Pico simultâneo').nextElementSibling?.textContent).toBe('4')
  const row = screen.getByRole('row', { name: /Code Navigation/ })
  expect(within(row).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['2', '8', '4', '1', '1', '30 ms'])
  expect(screen.getByText('Latência máxima').nextElementSibling?.textContent).toBe('60 ms')
  expect(screen.queryByText('secret_tool')).toBeNull()
})

it('guards pending intents and receives authoritative transitions without optimistic state', async () => {
  state.remoteAccessEnabled = false; state.availability = 'DISABLED'
  let resolve!: (result: ConnectionResult) => void
  vi.mocked(window.codeAwareness.connect).mockReturnValue(new Promise(done => { resolve = done }))
  render(<ChannelView />)
  const button = await screen.findByRole('button', { name: 'Ativar acesso remoto' })
  fireEvent.click(button); fireEvent.click(button)
  expect(window.codeAwareness.connect).toHaveBeenCalledTimes(1)
  expect((screen.getByRole('button', { name: 'Atualizando…' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('button', { name: 'Atualizando…' }).getAttribute('aria-busy')).toBe('true')
  expect(screen.getByText('Acesso remoto desativado')).toBeTruthy()
  state = { ...state, revision: 2, availability: 'WAITING_FOR_PROJECT', remoteAccessEnabled: true, activeProject: null }
  await act(async () => resolve({ success: true, state: { status: 'DISCONNECTED' } }))
  expect(await screen.findByText('Aguardando um projeto')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Desativar acesso remoto' }))
  await waitFor(() => expect(window.codeAwareness.disconnect).toHaveBeenCalledTimes(1))
})

it('ignores late hydration and lower or equal event revisions, unsubscribes on unmount', async () => {
  let hydrate!: (state: ChannelState) => void
  vi.mocked(window.codeAwareness.getChannelState).mockReturnValue(new Promise(done => { hydrate = done }))
  const view = render(<ChannelView />)
  act(() => receive({ ...state, revision: 5, activeProject: { id: 'B', name: 'project-b' } }))
  await act(async () => hydrate(state))
  act(() => receive({ ...state, revision: 5 })); act(() => receive({ ...state, revision: 4 }))
  expect(screen.getAllByText('project-b')).toHaveLength(2)
  view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce()
})

it('reports command and hydration failures without leaking exception text', async () => {
  vi.mocked(window.codeAwareness.disconnect).mockRejectedValue(new Error('secret JWT'))
  render(<ChannelView />)
  fireEvent.click(await screen.findByRole('button', { name: 'Desativar acesso remoto' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(document.body.textContent).not.toContain('secret JWT')
  cleanup()
  vi.mocked(window.codeAwareness.getChannelState).mockRejectedValue(new Error('private path'))
  render(<ChannelView />)
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(document.body.textContent).not.toContain('private path')
})

it('opens local System Health with Code Navigation labels, traps focus and closes with Escape', async () => {
  render(<ChannelView />)
  await screen.findByText('Pronto para acesso remoto')
  const trigger = screen.getByRole('button', { name: 'Abrir diagnóstico' })
  trigger.focus(); fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog', { name: 'System Health — Code Navigation' })
  await within(dialog).findByText('Code Navigation Execution')
  expect(document.body.textContent).not.toContain('CodeScope')
  expect(window.codeAwareness.getSystemHealthState).toHaveBeenCalledOnce()
  const close = within(dialog).getByRole('button', { name: 'Fechar' })
  close.focus(); fireEvent.keyDown(document, { key: 'Tab' })
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Fechar diagnóstico' }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('keeps a four-stage operational path and surfaces installation attention in remote access', async () => {
  state.availability = 'SETUP_REQUIRED'; state.installationConfigured = false
  render(<ChannelView />)
  const path = await screen.findByRole('region', { name: 'Caminho operacional' })
  expect(within(path).getAllByRole('term').map(term => term.textContent)).toEqual(['Acesso remoto · ChatGPT', 'Relay', 'MCP', 'Projeto atendido'])
  expect(within(path).getByText('Configuração necessária')).toBeTruthy()
  expect(within(path).getByText('Instalação requer atenção')).toBeTruthy()
})

it('keeps activity runtime-scoped without illustrated history, charts or invented row actions', async () => {
  render(<ChannelView />)
  await screen.findByText('Pronto para acesso remoto')
  expect(screen.getByText('Nesta execução')).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/Last 24 hours|últimas 24 horas|tendência|período anterior|CodeScope/i)
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Desativar acesso remoto', 'Abrir diagnóstico'])
})
