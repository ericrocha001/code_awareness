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
