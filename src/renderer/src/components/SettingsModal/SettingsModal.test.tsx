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

it('persists autoEnrollNewProjects and activates user-profile Codex hooks explicitly', async () => {
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) { this.setAttribute('open', '') })
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) { this.removeAttribute('open') })
  let stored = {
    hiddenNavigationItems: [],
    projectPreferences: {},
    gitManagement: { automaticFetch: true },
    codexCapture: { autoEnrollNewProjects: false }
  }
  const save = vi.fn(async settings => { stored = settings; return { success: true } })
  const baseStatus = {
    scope: 'USER' as const,
    codexHome: 'C:\\Users\\test\\.codex',
    configPath: 'C:\\Users\\test\\.codex\\hooks.json',
    profileEnabled: false,
    autoEnrollNewProjects: false,
    installation: { state: 'NOT_INSTALLED' as const, reasonCode: 'NOT_INSTALLED', installed: 0, total: 7, enabled: false },
    clients: [{ path: 'C:\\Codex\\codex.exe', origin: 'DESKTOP' as const, version: '0.169.0-alpha.11.1', qualified: true, reasonCode: 'QUALIFIED' }],
    enrolledRepositoryIds: [],
    trust: 'NOT_INSPECTED' as const
  }
  const install = vi.fn(async () => ({
    state: 'CONFIGURED',
    trust: 'REVIEW_REQUIRED' as const,
    status: { ...baseStatus, profileEnabled: true, autoEnrollNewProjects: true, installation: { ...baseStatus.installation, state: 'CONFIGURED' as const, installed: 7, enabled: true }, enrolledRepositoryIds: ['repo-1'] }
  }))
  window.codeAwareness = {
    loadSettings: vi.fn(async () => stored),
    saveSettings: save,
    codexUserHooks: {
      status: vi.fn(async () => baseStatus),
      install,
      disable: vi.fn(),
      enrollRepository: vi.fn(),
      revokeRepository: vi.fn()
    }
  } as any

  render(<SettingsModal hidden={[]} ready saving={false} error={null} onSetVisible={() => {}} onRestore={() => {}} onClose={() => {}} />)
  const toggle = await screen.findByRole('switch', { name: 'Inscrever novos repositórios automaticamente' })
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  fireEvent.click(toggle)
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(stored).toMatchObject({ codexCapture: { autoEnrollNewProjects: true } })

  const activate = await screen.findByRole('button', { name: 'Ativar no perfil do usuário' })
  fireEvent.click(activate)
  await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
  expect(install).toHaveBeenCalledWith(expect.objectContaining({
    codexHome: 'C:\\Users\\test\\.codex',
    clientPath: 'C:\\Codex\\codex.exe',
    autoEnrollNewProjects: true,
    enrollActiveRepositories: true,
    cutoverLegacy: true
  }))
})

it('persists antigravityCapture.autoEnrollNewProjects and activates Antigravity user-profile hooks', async () => {
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) { this.setAttribute('open', '') })
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) { this.removeAttribute('open') })
  let stored = {
    hiddenNavigationItems: [],
    projectPreferences: {},
    gitManagement: { automaticFetch: true },
    antigravityCapture: { autoEnrollNewProjects: false }
  }
  const save = vi.fn(async settings => { stored = settings; return { success: true } })
  const baseStatus = {
    scope: 'USER' as const,
    configHome: 'C:\\Users\\test\\.gemini\\config',
    configPath: 'C:\\Users\\test\\.gemini\\config\\hooks.json',
    profileEnabled: false,
    autoEnrollNewProjects: false,
    installation: { state: 'MISSING' as const, reasonCode: 'NATIVE_CONFIG_MISSING', installed: 0, expected: 6, enabled: false },
    clients: [{ path: 'C:\\Users\\test\\AppData\\Local\\agy\\bin\\agy.exe', origin: 'CLI' as const, surface: 'CLI' as const, version: '1.5.10', qualified: true, reasonCode: 'QUALIFIED' }],
    enrolledRepositoryIds: [],
    trust: 'CLIENT_TRUST_UNSUPPORTED' as const
  }
  const install = vi.fn(async () => ({
    state: 'CONFIGURED',
    trust: 'REVIEW_REQUIRED' as const,
    status: { ...baseStatus, profileEnabled: true, autoEnrollNewProjects: true, installation: { ...baseStatus.installation, state: 'CONFIGURED' as const, installed: 6, enabled: true }, enrolledRepositoryIds: ['repo-ag'] }
  }))
  window.codeAwareness = {
    loadSettings: vi.fn(async () => stored),
    saveSettings: save,
    antigravityUserHooks: {
      status: vi.fn(async () => baseStatus),
      install,
      disable: vi.fn(),
      enrollRepository: vi.fn(),
      revokeRepository: vi.fn()
    }
  } as any

  render(<SettingsModal hidden={[]} ready saving={false} error={null} onSetVisible={() => {}} onRestore={() => {}} onClose={() => {}} />)
  const toggle = await screen.findByRole('switch', { name: 'Inscrever novos repositórios automaticamente no Antigravity' })
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  fireEvent.click(toggle)
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(stored).toMatchObject({ antigravityCapture: { autoEnrollNewProjects: true } })

  const activate = await screen.findByRole('button', { name: 'Ativar Antigravity no perfil do usuário' })
  fireEvent.click(activate)
  await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
  expect(install).toHaveBeenCalledWith(expect.objectContaining({
    configHome: 'C:\\Users\\test\\.gemini\\config',
    clientPath: 'C:\\Users\\test\\AppData\\Local\\agy\\bin\\agy.exe',
    autoEnrollNewProjects: true,
    enrollActiveRepositories: true,
    cutoverLegacy: true
  }))
  expect((await screen.findAllByText(/CLIENT_TRUST_UNSUPPORTED/)).length).toBeGreaterThanOrEqual(1)
})
