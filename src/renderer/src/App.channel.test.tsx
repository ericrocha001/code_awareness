// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChannelState } from '../../shared/types/channel-state-types'
import { App } from './App'

vi.mock('./hooks/useTheme', () => ({ useTheme: () => {} }))
vi.mock('./hooks/useProjectPreferences', () => ({ useProjectPreferences: () => ({ preferences: { sidebarOpen: true }, updateSidebarOpen: vi.fn() }) }))
vi.mock('./components/WorkOrchestrationView/useOrchestrationAttention', () => ({ useOrchestrationAttention: () => ({ unseen: 0 }) }))
vi.mock('./components/WorkOrchestrationView/WorkOrchestrationTab', () => ({ WorkOrchestrationTab: () => null }))
vi.mock('./components/HomeView/HomeView', () => ({ HomeView: () => <h1>Home</h1> }))
vi.mock('./components/GlobalSidebar/GlobalSidebar', () => ({ GlobalSidebar: ({ setActiveTab }: any) => <nav>{['home', 'channel'].map(tab => <button key={tab} onClick={() => setActiveTab(tab)}>{tab}</button>)}</nav> }))
afterEach(cleanup)

it('mounts Channel on demand once and retains its accessible view, selection and directed result across navigation', async () => {
  const initial = { revision: 1, availability: 'DISABLED', remoteAccessEnabled: false, transport: 'relay', connectionStatus: 'STOPPED', mcpStatus: 'STOPPED', activeProject: null,
    installationConfigured: false, lastError: null, functionalHealth: { status: 'UNKNOWN' }, activity: { activeRequests: 0, peakConcurrentRequests: 0, totalRequests: 0, succeededRequests: 0, failedRequests: 0, timedOutRequests: 0,
      latency: { completedRequests: 0, totalDurationMs: 0, lastDurationMs: null, maxDurationMs: null }, byTool: {}, byCapability: {} } } as ChannelState
  let hydrate!: (state: ChannelState) => void
  const subscriptions = new Set<unknown>()
  const api = { snapshot: vi.fn(async () => ({ revision: 1, restoration: 'READY', installations: [] })), onChanged: vi.fn(() => () => {}), detect: vi.fn(), preview: vi.fn(), apply: vi.fn(), verify: vi.fn(async (id: string) => ({ id, name: 'VS Code', path: 'profile/config.json', detected: true, configuration: 'ABSENT', launcherPresent: true, bootstrap: 'NOT_CHECKED', clientUse: 'NOT_CONFIRMED' })) }
  window.codeAwareness = {
    loadSettings: async () => ({}), getPendingDeepLink: async () => null, onDeepLink: () => () => {},
    getActiveProject: async () => ({ revision: 0, project: null }), onActiveProjectChanged: () => () => {},
    localMcpClients: api,
    getChannelState: vi.fn(() => new Promise(resolve => { hydrate = resolve })),
    onChannelChanged: vi.fn(callback => { subscriptions.add(callback); return () => subscriptions.delete(callback) }),
    connect: vi.fn(), disconnect: vi.fn()
  } as unknown as Window['codeAwareness']
  render(<App />)
  expect(document.querySelector('.channel-view')).toBeNull()
  expect(window.codeAwareness.getChannelState).not.toHaveBeenCalled()
  expect(window.codeAwareness.onChannelChanged).not.toHaveBeenCalled()
  expect(api.detect).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'channel' }))
  const instance = document.querySelector('.channel-view')
  expect(screen.getAllByRole('article')).toHaveLength(3)
  expect(screen.getAllByText('Restaurando configuração…').length).toBeGreaterThanOrEqual(3)
  const cline = within(screen.getByRole('article', { name: 'Cline' }))
  const selector = cline.getByRole('combobox') as HTMLSelectElement
  fireEvent.change(selector, { target: { value: 'cline-vscode' } })
  fireEvent.click(cline.getByRole('button', { name: 'Verificar' }))
  expect(await cline.findByText('Disponível para instalação')).toBeTruthy()
  expect(api.verify).toHaveBeenCalledWith('cline-vscode')
  await act(async () => hydrate(initial))
  expect(subscriptions.size).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'home' }))
  const panel = document.querySelector('.channel-tab') as HTMLElement
  expect(panel.hidden).toBe(true)
  expect(panel.hasAttribute('inert')).toBe(true)
  expect(screen.queryByRole('heading', { name: 'Code Awareness Channel' })).toBeNull()
  expect(screen.queryAllByRole('article')).toHaveLength(0)
  expect(subscriptions.size).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'channel' }))
  expect(document.querySelector('.channel-view')).toBe(instance)
  expect(screen.getByRole('combobox', { name: 'Destino Cline' })).toBe(selector)
  expect(selector.value).toBe('cline-vscode')
  expect(cline.getByText('Disponível para instalação')).toBeTruthy()
  expect(screen.queryByText('Carregando estado operacional…')).toBeNull()
  expect(panel.hidden).toBe(false)
  expect(panel.hasAttribute('inert')).toBe(false)
  expect(subscriptions.size).toBe(1)
  await act(async () => hydrate({ ...initial, revision: 2, activeProject: { id: 'B', name: 'project-b' }, availability: 'READY', remoteAccessEnabled: true, connectionStatus: 'CONNECTED', mcpStatus: 'RUNNING' }))
  expect(screen.getAllByText('project-b')).toHaveLength(2)
  expect(screen.getByText('Pronto para acesso remoto')).toBeTruthy()
  expect(window.codeAwareness.getChannelState).toHaveBeenCalledTimes(2)
  expect(api.detect).not.toHaveBeenCalled()
  expect(api.preview).not.toHaveBeenCalled()
  expect(api.apply).not.toHaveBeenCalled()
  expect(window.codeAwareness.connect).not.toHaveBeenCalled()
  expect(window.codeAwareness.disconnect).not.toHaveBeenCalled()
})
