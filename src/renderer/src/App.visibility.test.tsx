// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from './App'
import { NAV_ITEMS } from './config/navigation'
import { buildCampaignReference } from './utils/campaign-reference'
vi.mock('./hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }))
vi.mock('./hooks/useProjectPreferences', () => ({ useProjectPreferences: () => ({ preferences: { sidebarOpen: true }, updateSidebarOpen: vi.fn() }) }))
vi.mock('./components/WorkOrchestrationView/useOrchestrationAttention', () => ({ useOrchestrationAttention: () => ({ unseen: 0 }) }))
vi.mock('./components/WorkOrchestrationView/WorkOrchestrationTab', () => ({ WorkOrchestrationTab: () => <div data-testid="background-service" /> }))
vi.mock('./components/GlobalSidebar/GlobalSidebarProject', () => ({ GlobalSidebarProject: () => null }))
vi.mock('./components/HomeView/HomeView', () => ({ HomeView: () => <div data-testid="home-view" /> }))
vi.mock('./components/ChannelView/ChannelView', () => ({ ChannelView: () => <div data-testid="channel-view" /> }))
vi.mock('./components/CodeCampaignView/CodeCampaignView', () => ({ CodeCampaignView: ({ resolvedCampaignId }: any) => <div data-testid="campaign-view">{resolvedCampaignId}</div> }))

let stored: any, deepLink: (url: string) => void, projectChanged: (state: any) => void
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  stored = { hiddenNavigationItems: [], projectPreferences: {} }
  window.codeAwareness = {
    loadSettings: async () => structuredClone(stored), saveSettings: async (settings: any) => { stored = structuredClone(settings); return { success: true } },
    getPendingDeepLink: async () => null, onDeepLink: (callback: typeof deepLink) => { deepLink = callback; return () => {} },
    getActiveProject: async () => ({ revision: 0, project: null }),
    onActiveProjectChanged: (callback: typeof projectChanged) => { projectChanged = callback; return () => {} },
    listCampaigns: async () => ({ success: true, data: [{ id: 'c1' }] })
  } as any
})
afterEach(cleanup)
const nav = () => within(screen.getByRole('navigation', { name: 'Navegação principal' }))
async function settings() {
  fireEvent.click(screen.getByRole('button', { name: 'Configurações' }))
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Mostrar Channel' }).getAttribute('aria-disabled')).toBe('false'))
}

it('opens without project, controls all optional entries, preserves Home and restores defaults', async () => {
  render(<App />)
  await settings()
  expect(screen.getAllByRole('switch')).toHaveLength(12)
  for (const item of NAV_ITEMS.filter(item => item.id !== 'home')) fireEvent.click(screen.getByRole('switch', { name: `Mostrar ${item.label}` }))
  expect(nav().queryByRole('button', { name: 'Channel' })).toBeNull()
  expect(nav().getByRole('button', { name: 'Home' })).toBeTruthy()
  expect(nav().getByRole('button', { name: 'Configurações' })).toBeTruthy()
  await waitFor(() => expect(stored.hiddenNavigationItems).toHaveLength(12))
  expect(screen.getByTestId('background-service')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Restaurar padrão' }))
  await waitFor(() => expect(stored.hiddenNavigationItems).toEqual([]))
  expect(nav().getByRole('button', { name: 'Channel' })).toBeTruthy()
})

it('falls back only when the active destination is hidden by the user', async () => {
  render(<App />)
  fireEvent.click(nav().getByRole('button', { name: 'Channel' }))
  await settings()
  fireEvent.keyDown(screen.getByRole('switch', { name: 'Mostrar Academy' }), { key: ' ' })
  expect(screen.getByTestId('channel-view')).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('switch', { name: 'Mostrar Channel' }), { key: 'Enter' })
  expect(screen.getByTestId('home-view')).toBeTruthy()
  await waitFor(() => expect(stored.hiddenNavigationItems).toEqual(['channel', 'academy']))
  fireEvent.click(screen.getByRole('button', { name: 'Fechar configurações' }))
  await settings()
  expect(screen.getByRole('switch', { name: 'Mostrar Channel' }).getAttribute('aria-checked')).toBe('false')
})

it('keeps hidden campaigns reachable via deep link across projects and subsequent visibility changes', async () => {
  stored.hiddenNavigationItems = ['campaigns']
  render(<App />)
  await settings()
  expect(nav().queryByRole('button', { name: 'Code Campaign' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Fechar configurações' }))
  await act(async () => { projectChanged({ revision: 1, project: { id: 'a', path: '/a', name: 'A' } }); deepLink(buildCampaignReference('/a', 'c1')) })
  expect(await screen.findByTestId('campaign-view')).toBeTruthy()
  await settings()
  fireEvent.click(screen.getByRole('switch', { name: 'Mostrar Academy' }))
  expect(screen.getByTestId('campaign-view')).toBeTruthy()
  await act(async () => { projectChanged({ revision: 2, project: { id: 'b', path: '/b', name: 'B' } }) })
  expect(screen.getByRole('switch', { name: 'Mostrar Code Campaign' }).getAttribute('aria-checked')).toBe('false')
  await waitFor(() => expect(stored.hiddenNavigationItems).toEqual(['academy', 'campaigns']))
})
