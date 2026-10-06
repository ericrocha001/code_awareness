// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CodeMapHealth } from './CodeMapHealth'

const props = () => ({
  state: 'healthy' as const, indexedAt: '2026-10-05T12:00:00Z', lastSyncAt: null, modifiedCount: 0,
  integrityState: 'unknown' as const, integrityIssueCount: 0, isVerifying: false, isRebuilding: false,
  onVerifyIntegrity: vi.fn(), onShowIntegrityIssues: vi.fn(), onRebuild: vi.fn()
})
afterEach(cleanup)

it('opens a quiet snapshot with unknown integrity and closes before verifying', () => {
  const callbacks = props()
  render(<CodeMapHealth {...callbacks} />)
  const trigger = screen.getByRole('button', { name: 'Code Map Health: Healthy' })
  fireEvent.click(trigger)
  expect(screen.getByText('Não verificada')).toBeTruthy()
  expect(screen.getByText('Sincronização automática').parentElement?.textContent).toContain('Ativa')
  expect(screen.queryByText(/Sync changes/i)).toBeNull()
  fireEvent.click(trigger)
  expect(screen.queryByRole('region', { name: 'Saúde do CodeMap' })).toBeNull()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: /Verificar integridade/ }))
  expect(callbacks.onVerifyIntegrity).toHaveBeenCalledOnce()
  expect(screen.queryByRole('region', { name: 'Saúde do CodeMap' })).toBeNull()
})

it('keeps pending static and uses a spinner only for a real integrity or rebuild operation', () => {
  const view = render(<CodeMapHealth {...props()} state="pending" modifiedCount={3} />)
  fireEvent.click(screen.getByRole('button', { name: 'Code Map Health: Pending' }))
  expect(screen.getByText('3 alterações pendentes')).toBeTruthy()
  expect(document.querySelector('.cmv-spin')).toBeNull()
  view.rerender(<CodeMapHealth {...props()} state="updating" isVerifying />)
  expect(screen.getByRole('button', { name: 'Code Map Health: Working' }).querySelector('.cmv-spin')).toBeTruthy()
  expect(screen.getByText('Verificando integridade...', { selector: '.cmh-header span' })).toBeTruthy()
  view.rerender(<CodeMapHealth {...props()} state="updating" isRebuilding />)
  expect(screen.getByText('Reconstruindo índice...')).toBeTruthy()
  view.rerender(<CodeMapHealth {...props()} />)
  expect(document.querySelector('.cmv-spin')).toBeNull()
})

it('shows contextual issues and closes before review', () => {
  const callbacks = props()
  render(<CodeMapHealth {...callbacks} state="issue" integrityState="issue" integrityIssueCount={2} />)
  fireEvent.click(screen.getByRole('button', { name: 'Code Map Health: Issue' }))
  expect(screen.getByText('Problemas de integridade encontrados')).toBeTruthy()
  expect(screen.getByText('2 problema(s)')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Revisar inconsistências/ }))
  expect(callbacks.onShowIntegrityIssues).toHaveBeenCalledOnce()
  expect(screen.queryByRole('region', { name: 'Saúde do CodeMap' })).toBeNull()
})

it('requires rebuild confirmation, supports cancel and Escape, and confirms exactly once', () => {
  const callbacks = props()
  render(<CodeMapHealth {...callbacks} />)
  const openConfirmation = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Code Map Health: Healthy' }))
    const advanced = screen.getByText('Avançado').closest('details')!
    fireEvent.click(screen.getByText('Avançado'))
    expect(advanced.open).toBe(true)
    fireEvent.click(screen.getByText('Avançado'))
    expect(advanced.open).toBe(false)
    fireEvent.click(screen.getByText('Avançado'))
    fireEvent.click(screen.getByRole('button', { name: /Reconstruir índice/ }))
    expect(screen.queryByRole('region', { name: 'Saúde do CodeMap' })).toBeNull()
    return screen.getByRole('dialog', { name: 'Reconstruir o índice do CodeMap?' })
  }
  fireEvent.click(within(openConfirmation()).getByRole('button', { name: 'Cancelar' }))
  expect(callbacks.onRebuild).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Code Map Health: Healthy' }))
  openConfirmation()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(callbacks.onRebuild).not.toHaveBeenCalled()
  const dialog = openConfirmation()
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancelar' }))
  fireEvent.keyDown(document, { key: 'Tab' })
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Reconstruir índice' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reconstruir índice' }))
  expect(callbacks.onRebuild).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
})
