// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GlobalSidebar } from './GlobalSidebar'

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, media: '', onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })
  window.codeAwareness = {
    listRepositories: vi.fn(async () => [{ id: 'repository-1', name: 'code_awareness', source: 'LOCAL', provider: null, remote: null, localCheckout: { path: 'C:/repo', availability: 'AVAILABLE' }, git: null, visibility: null, identityKey: 'local:C:/repo', createdAt: '', updatedAt: '' }]),
    toggleDevTools: vi.fn()
  } as unknown as Window['codeAwareness']
})

afterEach(cleanup)

it('preserves navigation, project switcher and footer controls while open', async () => {
  const setActiveTab = vi.fn()
  const onSelectRepository = vi.fn()
  const onOpenTags = vi.fn()
  const onOpenIgnored = vi.fn()
  render(<GlobalSidebar isSidebarOpen setIsSidebarOpen={vi.fn()} activeTab="academy" setActiveTab={setActiveTab} activeProject={{ path: 'C:/repo', name: 'code_awareness' }} onSelectRepository={onSelectRepository} onOpenTags={onOpenTags} onOpenIgnored={onOpenIgnored} />)

  expect(screen.getByText('Code Awareness')).toBeTruthy()
  expect(screen.getByText('code_awareness')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Academy' }).getAttribute('aria-current')).toBe('page')
  fireEvent.click(screen.getByRole('button', { name: 'Home' }))
  expect(setActiveTab).toHaveBeenCalledWith('home')
  fireEvent.click(screen.getByRole('button', { name: 'Gerenciar tags' }))
  fireEvent.click(screen.getByRole('button', { name: 'Arquivos ignorados' }))
  expect(onOpenTags).toHaveBeenCalled()
  expect(onOpenIgnored).toHaveBeenCalled()
  await waitFor(() => expect(window.codeAwareness.listRepositories).toHaveBeenCalled())
})

it('collapses without removing navigation or footer capabilities', () => {
  const setIsSidebarOpen = vi.fn()
  render(<GlobalSidebar isSidebarOpen={false} setIsSidebarOpen={setIsSidebarOpen} activeTab="home" setActiveTab={vi.fn()} activeProject={null} onSelectRepository={vi.fn()} onOpenTags={vi.fn()} onOpenIgnored={vi.fn()} />)

  expect(screen.getByRole('navigation', { name: 'Navegação principal' }).className).toContain('sidebar-closed')
  expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Expandir sidebar' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Abrir DevTools' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Expandir sidebar' }))
  expect(setIsSidebarOpen).toHaveBeenCalledWith(true)
})
