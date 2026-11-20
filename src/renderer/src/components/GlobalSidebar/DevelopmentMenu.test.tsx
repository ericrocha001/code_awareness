// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevelopmentMenu } from './DevelopmentMenu'

beforeEach(() => {
  window.codeAwareness = {
    toggleDevTools: vi.fn(),
    getDevUpdateStatus: vi.fn(async () => ({
      available: true,
      branch: 'feat/dev-update',
      head: 'abc12345678',
      supervisorConnected: true
    })),
    requestDevUpdate: vi.fn(async () => ({
      operationId: 'op-test',
      status: 'SCHEDULED' as const,
      head: 'new-head-123',
      message: 'DevUpdate agendado'
    }))
  } as unknown as Window['codeAwareness']
})

afterEach(cleanup)

describe('DevelopmentMenu', () => {
  it('renders DevTools button as fallback when DevUpdate is not available', async () => {
    window.codeAwareness.getDevUpdateStatus = vi.fn(async () => ({
      available: false,
      reason: 'production mode',
      supervisorConnected: false
    }))

    render(<DevelopmentMenu isSidebarOpen={true} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Abrir DevTools' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Abrir DevTools' }))
    expect(window.codeAwareness.toggleDevTools).toHaveBeenCalled()
  })

  it('renders Development menu button with DevUpdate title when DevUpdate is available', async () => {
    render(<DevelopmentMenu isSidebarOpen={true} />)
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Menu Development' })
      expect(btn).toBeTruthy()
      expect(btn.getAttribute('title')).toBe('Development (DevUpdate e Ferramentas)')
    })
  })

  it('opens menu, shows branch, exact Restart to Update label, and triggers DevTools', async () => {
    render(<DevelopmentMenu isSidebarOpen={true} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Menu Development' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Menu Development' }))

    await waitFor(() => {
      expect(screen.getByText('Desenvolvimento')).toBeTruthy()
      expect(screen.getByText('feat/dev-update')).toBeTruthy()
      expect(screen.getByText('Restart to Update')).toBeTruthy()
      expect(screen.getByText(/fetch e fast-forward/i)).toBeTruthy()
      expect(screen.getByText('Chromium DevTools')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('Chromium DevTools'))
    expect(window.codeAwareness.toggleDevTools).toHaveBeenCalled()
  })

  it('triggers requestDevUpdate on click and updates feedback', async () => {
    render(<DevelopmentMenu isSidebarOpen={true} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Menu Development' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Menu Development' }))
    await waitFor(() => {
      expect(screen.getByText('Restart to Update')).toBeTruthy()
    })
    const devUpdateBtn = screen.getByText('Restart to Update').closest('button')!
    fireEvent.click(devUpdateBtn)

    await waitFor(() => {
      expect(window.codeAwareness.requestDevUpdate).toHaveBeenCalled()
      expect(screen.getByText('Reiniciando runtime...')).toBeTruthy()
    })
  })

  it('displays discreet success banner when previous DevUpdate completed', async () => {
    window.codeAwareness.getDevUpdateStatus = vi.fn(async () => ({
      available: true,
      branch: 'main',
      head: '1234567890',
      supervisorConnected: true,
      lastResult: {
        operationId: 'op-done',
        status: 'COMPLETED' as const,
        head: '1234567890',
        message: 'DevUpdate concluído'
      }
    }))

    render(<DevelopmentMenu isSidebarOpen={true} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Menu Development' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Menu Development' }))
    await waitFor(() => {
      expect(screen.getByText(/DevUpdate concluído/i)).toBeTruthy()
      expect(screen.getByText(/Atualizar ações/i)).toBeTruthy()
    })
  })

  it('displays error message and toggleable details when DevUpdate fails', async () => {
    window.codeAwareness.requestDevUpdate = vi.fn(async () => ({
      operationId: 'op-fail',
      status: 'DIRTY_WORKTREE' as const,
      message: 'Checkout possui arquivos modificados.',
      details: { count: 3 }
    }))

    render(<DevelopmentMenu isSidebarOpen={true} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Menu Development' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Menu Development' }))
    await waitFor(() => {
      expect(screen.getByText('Restart to Update')).toBeTruthy()
    })
    const devUpdateBtn = screen.getByText('Restart to Update').closest('button')!
    fireEvent.click(devUpdateBtn)

    await waitFor(() => {
      expect(screen.getByText('Checkout possui arquivos modificados.')).toBeTruthy()
      expect(screen.getByText('Detalhes técnicos')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('Detalhes técnicos'))
    expect(screen.getByText(/"count": 3/)).toBeTruthy()
  })

  it('renders correctly under light theme with proper container role and structure', async () => {
    document.body.setAttribute('data-theme', 'light')
    render(<DevelopmentMenu isSidebarOpen={true} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Menu Development' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Menu Development' }))
    await waitFor(() => {
      const menu = screen.getByRole('menu', { name: 'Opções de Desenvolvimento' })
      expect(menu).toBeTruthy()
      expect(menu.classList.contains('dev-menu-container')).toBe(true)
    })
    document.body.removeAttribute('data-theme')
  })
})
