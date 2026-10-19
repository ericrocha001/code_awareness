// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { App } from './App'
vi.mock('./hooks/useTheme', () => ({ useTheme: () => {} }))
vi.mock('./hooks/useProjectPreferences', () => ({ useProjectPreferences: () => ({ preferences: { sidebarOpen: true }, updateSidebarOpen: vi.fn() }) }))
vi.mock('./components/GlobalSidebar/GlobalSidebar', () => ({ GlobalSidebar: ({ setActiveTab }: any) => <nav>{['home', 'work-orchestration', 'git-management', 'codebase', 'channel'].map(tab => <button key={tab} onClick={() => setActiveTab(tab)}>{tab}</button>)}</nav> }))
vi.mock('./components/HomeView/HomeView', () => ({ HomeView: () => <div data-testid="home-view" /> }))
vi.mock('./components/GitManagementView/GitManagementView', () => ({ GitManagementView: () => <div data-testid="git-view" /> }))
vi.mock('./components/CodeSourceView/CodeSourceView', () => ({ CodeSourceView: () => <div data-testid="source-view" /> }))
vi.mock('./components/ChannelView/ChannelView', () => ({ ChannelView: () => <div data-testid="channel-view" /> }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('keeps exactly one visible panel and one retained Orchestration view while switching Shell tabs', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  window.codeAwareness = {
    loadSettings: async () => ({}),
    getPendingDeepLink: async () => null, onDeepLink: () => () => {}, onActiveProjectChanged: () => () => {},
    getActiveProject: async () => ({ project: { id: 'a', name: 'A', path: '/a' }, revision: 1 }),
    getBranchOrchestration: vi.fn(async ({ operation }) => ({ success: true, context: { projectId: 'a', revision: 1 }, data: operation.action === 'INVENTORY' ? { kind: 'INVENTORY', inventory: { repositoryId: 'repo', worktrees: [], unassignedWorktrees: [], branches: [], coverage: 'COMPLETE', observedAt: '2026-10-13T00:00:00Z', revision: 'r' } } : { kind: 'PULL_REQUESTS', inventoryRevision: 'r', pullRequests: { repositoryId: 'repo', catalog: { coverage: 'UNAVAILABLE', items: [] }, relations: [], received: [], orphaned: [] } } }))
  } as any
  render(<React.StrictMode><App /></React.StrictMode>)
  expect(screen.queryByTestId('channel-view')).toBeNull()
  fireEvent.click(screen.getByText('work-orchestration'))
  await screen.findByText('Inventário completo · 0 branches · 0 Worktrees')
  for (let i = 0; i < 3; i++) for (const tab of ['git-management', 'work-orchestration', 'codebase', 'channel', 'home']) {
    fireEvent.click(screen.getByText(tab))
    expect(document.querySelectorAll('.wo-view')).toHaveLength(1)
    expect(document.querySelectorAll('.wo-tab')).toHaveLength(1)
    expect((document.querySelector('.wo-tab') as HTMLElement).hidden).toBe(tab !== 'work-orchestration')
    for (const [name, target] of [['git-view', 'git-management'], ['source-view', 'codebase'], ['home-view', 'home']])
      expect(screen.queryAllByTestId(name)).toHaveLength(tab === target ? 1 : 0)
    const channel = document.querySelector('.channel-tab') as HTMLElement
    expect(channel.hidden).toBe(tab !== 'channel')
    expect(channel.hasAttribute('inert')).toBe(tab !== 'channel')
    expect(screen.queryAllByTestId('channel-view')).toHaveLength(channel.childElementCount ? 1 : 0)
  }
  expect(errors.mock.calls.some(args => String(args[0]).includes('same key'))).toBe(false)
  expect(window.codeAwareness.getBranchOrchestration).toHaveBeenCalled()
})
