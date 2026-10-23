import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsService } from './settings-service'

const profile = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({ app: { getPath: () => profile.path } }))
afterEach(() => { if (profile.path) rmSync(profile.path, { recursive: true, force: true }) })

it('round-trips global visibility through a real settings.json and new service instances', () => {
  profile.path = mkdtempSync(join(tmpdir(), 'ca-visibility-'))
  const file = join(profile.path, 'settings.json')
  writeFileSync(file, JSON.stringify({ rootFolders: ['/root'], projectPreferences: { '/a': { sidebarOpen: false, fileViewColumnWidths: { path: 280 } } }, tags: { '/a': [{ id: 't', name: 'Tag', color: 'red' }] } }))
  const old = new SettingsService().loadSettings()
  expect(old.hiddenNavigationItems).toBeUndefined()
  new SettingsService().saveSettings({ ...old, hiddenNavigationItems: ['academy', 'campaigns'] })
  expect(JSON.parse(readFileSync(file, 'utf8')).hiddenNavigationItems).toEqual(['academy', 'campaigns'])
  const reopened = new SettingsService().loadSettings()
  expect(reopened).toMatchObject({ ...old, hiddenNavigationItems: ['academy', 'campaigns'] })
  new SettingsService().saveSettings({ ...reopened, remoteAccessEnabled: true })
  expect(new SettingsService().loadSettings().hiddenNavigationItems).toEqual(['academy', 'campaigns'])
})

it('remembers logical selection across service recreation without overwriting newer preferences', () => {
  profile.path = mkdtempSync(join(tmpdir(), 'ca-last-repository-'))
  const service = new SettingsService(), stale = service.loadSettings()
  service.saveSettings({ ...stale, hiddenNavigationItems: ['academy'], remoteAccessEnabled: false })
  service.rememberActiveRepository('repository-A')
  expect(new SettingsService().loadSettings()).toMatchObject({ lastActiveRepositoryId: 'repository-A', hiddenNavigationItems: ['academy'] })
  service.rememberActiveRepository('repository-B')
  service.saveSettings({ ...stale, remoteAccessEnabled: true })
  expect(new SettingsService().loadSettings()).toMatchObject({ lastActiveRepositoryId: 'repository-B', remoteAccessEnabled: true })
  service.saveSettings({ ...service.loadSettings(), lastActiveRepositoryId: 'renderer-cannot-replace-selection' })
  expect(service.loadSettings().lastActiveRepositoryId).toBe('repository-B')
  const changed = vi.fn(); service.onChanged(changed)
  service.rememberActiveRepository('repository-B')
  expect(changed).not.toHaveBeenCalled()
})

it.each([null, 123, [], {}, '', ' ', '../checkout', 'C:\\checkout', 'a'.repeat(129)])('ignores invalid stored repository preference: %j', value => {
  profile.path = mkdtempSync(join(tmpdir(), 'ca-last-invalid-'))
  writeFileSync(join(profile.path, 'settings.json'), JSON.stringify({ lastActiveRepositoryId: value, hiddenNavigationItems: ['academy'] }))
  expect(new SettingsService().loadSettings()).toMatchObject({ lastActiveRepositoryId: undefined, hiddenNavigationItems: ['academy'] })
})

it('keeps canonical last selection separate from settings read or saved in a private instance profile', () => {
  const host = mkdtempSync(join(tmpdir(), 'ca-host-preference-'))
  try {
    profile.path = host
    new SettingsService().rememberActiveRepository('repository-A')
    const canonical = readFileSync(join(host, 'settings.json'), 'utf8')
    profile.path = mkdtempSync(join(tmpdir(), 'ca-private-preference-'))
    const privateSettings = new SettingsService()
    expect(privateSettings.loadSettings().lastActiveRepositoryId).toBeUndefined()
    privateSettings.saveSettings({ ...privateSettings.loadSettings(), hiddenNavigationItems: ['academy'] })
    expect(readFileSync(join(host, 'settings.json'), 'utf8')).toBe(canonical)
  } finally { rmSync(host, { recursive: true }) }
})
