// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexArchiveSettings } from './CodexArchiveSettings'
import type { CodexArchiveReadiness } from '../../../../shared/types/codex-archive-types'

afterEach(cleanup)
it('inspects readiness without connecting, requires explicit action and reflects loss of authorization', async () => {
  let changed!: (value: CodexArchiveReadiness) => void
  const unsubscribe = vi.fn(), enable = vi.fn(async () => ({ state: 'READY', version: '0.155.0' })), disable = vi.fn(async () => ({ state: 'NOT_CONFIGURED' }))
  window.codeAwareness = { codexArchive: { inspect: async () => ({ state: 'NOT_CONFIGURED' }), enable, disable, onChanged: (callback: typeof changed) => { changed = callback; return unsubscribe } } } as any
  const view = render(<CodexArchiveSettings />)
  const connect = await screen.findByRole('button', { name: 'Conectar ao Codex…' })
  await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false))
  expect(enable).not.toHaveBeenCalled()
  fireEvent.click(connect)
  const disconnect = await screen.findByRole('button', { name: 'Desconectar' })
  expect(screen.getByRole('status').textContent).toContain('Codex 0.155.0')
  fireEvent.click(disconnect)
  await screen.findByRole('button', { name: 'Conectar ao Codex…' })
  expect(disable).toHaveBeenCalledOnce()
  changed({ state: 'ACCOUNT_IDENTITY_UNAVAILABLE' })
  await screen.findByText('Não foi possível confirmar a conta')
  view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce()
})
