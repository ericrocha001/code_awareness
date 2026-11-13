// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsModal } from './SettingsModal'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('persists the automatic fetch opt-out through existing settings without replacing other preferences', async () => {
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) { this.setAttribute('open', '') })
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) { this.removeAttribute('open') })
  let stored = { hiddenNavigationItems: ['academy'], projectPreferences: {}, gitManagement: { automaticFetch: true } }
  const save = vi.fn(async settings => { stored = settings; return { success: true } })
  window.codeAwareness = { loadSettings: vi.fn(async () => stored), saveSettings: save } as any
  render(<SettingsModal hidden={[]} ready saving={false} error={null} onSetVisible={() => {}} onRestore={() => {}} onClose={() => {}} />)
  const toggle = await screen.findByRole('switch', { name: 'Fetch automático condicionado ao remoto' })
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
  fireEvent.click(toggle)
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(stored).toMatchObject({ hiddenNavigationItems: ['academy'], gitManagement: { automaticFetch: false } })
})

it('persists Downloads import confirmation preference (Manual vs Automática) and syncs with Academy', async () => {
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) { this.setAttribute('open', '') })
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) { this.removeAttribute('open') })
  let stored = {
    hiddenNavigationItems: [],
    projectPreferences: {},
    gitManagement: { automaticFetch: true },
    downloads: { importConfirmationMode: 'MANUAL' }
  }
  const save = vi.fn(async settings => { stored = settings; return { success: true } })
  const setAcademyPref = vi.fn(async (mode: 'MANUAL' | 'AUTOMATIC') => ({ mode, updatedAt: '2026-11-13T00:00:00Z' }))
  window.codeAwareness = {
    loadSettings: vi.fn(async () => stored),
    saveSettings: save,
    setAcademyImportConfirmationPreference: setAcademyPref
  } as any

  render(<SettingsModal hidden={[]} ready saving={false} error={null} onSetVisible={() => {}} onRestore={() => {}} onClose={() => {}} />)
  const select = (await screen.findByLabelText('Confirmação de importação')) as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe('MANUAL'))

  fireEvent.change(select, { target: { value: 'AUTOMATIC' } })
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(setAcademyPref).toHaveBeenCalledWith('AUTOMATIC')
  expect(stored).toMatchObject({ downloads: { importConfirmationMode: 'AUTOMATIC' } })
})
