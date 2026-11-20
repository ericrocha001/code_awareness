// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevelopmentMenu } from './DevelopmentMenu'

beforeEach(() => {
  window.codeAwareness = {
    toggleDevTools: vi.fn(),
    getDevSyncStatus: vi.fn(async () => ({
      available: true,
      branch: 'feat/dev-sync',
      head: 'abc12345678',
      supervisorConnected: true
    })),
    requestDevSync: vi.fn(async () => ({
      operationId: 'op-test',
      status: 'SCHEDULED' as const,
      head: 'new-head-123',
      message: 'DevSync agendado'
    }))
  } as unknown as Window['codeAwareness']
})

afterEach(cleanup)

describe('DevelopmentMenu', () => {
  it('renders DevTools button as fallback when devSync is not available', async () => {
    window.codeAwareness.getDevSyncStatus = vi.fn(async () => ({
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

  it('renders Development menu button when devSync is available', async () => {
    render(<DevelopmentMenu isSidebarOpen={true} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Menu Development' })).toBeTruthy()
    })
  })

  it('opens menu, shows branch and options, and triggers DevTools', async () => {
    render(<DevelopmentMenu isSidebarOpen={true} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Menu Development' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Menu Development' }))

    await waitFor(() => {
      expect(screen.getByText('Desenvolvimento')).toBeTruthy()
      expect(screen.getByText('feat/dev-sync')).toBeTruthy()
      expect(screen.getByText('DevSync')).toBeTruthy()
      expect(screen.getByText('Chromium DevTools')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('Chromium DevTools'))
    expect(window.codeAwareness.toggleDevTools).toHaveBeenCalled()
  })

  it('triggers requestDevSync on click and updates feedback', async () => {
    render(<DevelopmentMenu isSidebarOpen={true} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Menu Development' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Menu Development' }))
    await waitFor(() => {
      expect(screen.getByText('DevSync')).toBeTruthy()
    })
    const devSyncBtn = screen.getByText('DevSync').closest('button')!
    fireEvent.click(devSyncBtn)

    await waitFor(() => {
      expect(window.codeAwareness.requestDevSync).toHaveBeenCalled()
      expect(screen.getByText('Reiniciando runtime...')).toBeTruthy()
    })
  })

  it('displays discreet success banner when previous sync completed', async () => {
    window.codeAwareness.getDevSyncStatus = vi.fn(async () => ({
      available: true,
      branch: 'main',
      head: '1234567890',
      supervisorConnected: true,
      lastResult: {
        operationId: 'op-done',
        status: 'COMPLETED' as const,
        head: '1234567890',
        message: 'DevSync concluído'
      }
    }))

    render(<DevelopmentMenu isSidebarOpen={true} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Menu Development' })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Menu Development' }))
    await waitFor(() => {
      expect(screen.getByText(/DevSync concluído/i)).toBeTruthy()
      expect(screen.getByText(/Atualizar ações/i)).toBeTruthy()
    })
  })

  it('displays error message and toggleable details when DevSync fails', async () => {
    window.codeAwareness.requestDevSync = vi.fn(async () => ({
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
      expect(screen.getByText('DevSync')).toBeTruthy()
    })
    const devSyncBtn = screen.getByText('DevSync').closest('button')!
    fireEvent.click(devSyncBtn)

    await waitFor(() => {
      expect(screen.getByText('Checkout possui arquivos modificados.')).toBeTruthy()
      expect(screen.getByText('Detalhes técnicos')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('Detalhes técnicos'))
    expect(screen.getByText(/"count": 3/)).toBeTruthy()
  })
})
