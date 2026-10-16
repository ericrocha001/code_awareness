// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNavigationVisibility } from './useNavigationVisibility'
import { useProjectPreferences } from './useProjectPreferences'
import { updateSettings } from '../utils/update-settings'
import type { AppSettings } from '../../../shared/types'

afterEach(cleanup)
function setup() {
  let stored = { rootFolders: ['/root'], tags: { '/a': [{ id: 'tag', name: 'Tag', color: 'red' }] }, projectPreferences: { '/a': { sidebarOpen: true, fileViewColumnWidths: { path: 250 } } }, hiddenNavigationItems: [] } as unknown as AppSettings
  const save = vi.fn(async (settings: AppSettings) => { stored = structuredClone(settings); return { success: true } })
  window.codeAwareness = { loadSettings: vi.fn(async () => structuredClone(stored)), saveSettings: save } as any
  return { save, stored: () => stored }
}

it('serializes rapid changes with other settings and reloads global choices on remount', async () => {
  const storage = setup()
  const hook = renderHook(() => useNavigationVisibility())
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const persist = storage.save.getMockImplementation()!
  storage.save.mockImplementationOnce(async settings => { await blocked; return persist(settings) })
  act(() => { hook.result.current.setVisible('academy', false); hook.result.current.setVisible('channel', false) })
  const other = updateSettings(settings => ({ ...settings, ngrokDomain: 'example.test' }))
  await waitFor(() => expect(storage.save).toHaveBeenCalledTimes(1))
  await act(async () => { release(); await other })
  expect(storage.stored().hiddenNavigationItems).toEqual(['channel', 'academy'])
  expect(storage.stored()).toMatchObject({ rootFolders: ['/root'], ngrokDomain: 'example.test', projectPreferences: { '/a': { fileViewColumnWidths: { path: 250 } } } })
  hook.unmount()
  const remount = renderHook(() => useNavigationVisibility())
  await waitFor(() => expect(remount.result.current.hidden).toEqual(['channel', 'academy']))
  act(() => remount.result.current.restoreDefaults())
  await waitFor(() => expect(storage.stored().hiddenNavigationItems).toEqual([]))
})

it('preserves visibility when project preferences are saved and when the project changes', async () => {
  const storage = setup()
  const navigation = renderHook(() => useNavigationVisibility())
  const project = renderHook(({ path }) => useProjectPreferences(path), { initialProps: { path: '/a' } })
  await waitFor(() => expect(navigation.result.current.ready).toBe(true))
  await waitFor(() => expect(project.result.current.preferences.fileViewColumnWidths).toEqual({ path: 250 }))
  await act(async () => {
    navigation.result.current.setVisible('campaigns', false)
    await project.result.current.updateSidebarOpen(false)
  })
  expect(storage.stored()).toMatchObject({ hiddenNavigationItems: ['campaigns'], projectPreferences: { '/a': { sidebarOpen: false, fileViewColumnWidths: { path: 250 } } } })
  project.rerender({ path: '/b' })
  expect(navigation.result.current.hidden).toEqual(['campaigns'])
})

it.each(['reject', 'unsuccessful'])('rolls back failed writes (%s), reports error and permits recovery', async failure => {
  const storage = setup()
  const hook = renderHook(() => useNavigationVisibility())
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  act(() => hook.result.current.setVisible('academy', false))
  await waitFor(() => expect(hook.result.current.saving).toBe(false))
  if (failure === 'reject') storage.save.mockRejectedValueOnce(new Error('disk full'))
  else storage.save.mockResolvedValueOnce({ success: false })
  act(() => hook.result.current.setVisible('channel', false))
  await waitFor(() => expect(hook.result.current.error).toContain('Não foi possível salvar'))
  expect(hook.result.current.hidden).toEqual(['academy'])
  expect(storage.stored().hiddenNavigationItems).toEqual(['academy'])
  act(() => hook.result.current.setVisible('channel', false))
  await waitFor(() => expect(storage.stored().hiddenNavigationItems).toEqual(['channel', 'academy']))
})

it('does not allow writes after a failed initial read', async () => {
  const storage = setup()
  vi.mocked(window.codeAwareness.loadSettings).mockRejectedValue(new Error('read failed'))
  const hook = renderHook(() => useNavigationVisibility())
  await waitFor(() => expect(hook.result.current.error).toContain('carregar'))
  act(() => hook.result.current.setVisible('academy', false))
  expect(hook.result.current.ready).toBe(false)
  expect(storage.save).not.toHaveBeenCalled()
})
