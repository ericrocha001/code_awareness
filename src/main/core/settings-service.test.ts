/*
-T ---
*/

import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import { SettingsService } from './settings-service'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/userdata')
  }
}))

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn()
}))

describe('SettingsService', () => {
  it('defaults remote access off and reloads only persisted remote intent', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const service = new SettingsService()
    expect(service.loadSettings()).toMatchObject({ remoteAccessEnabled: false, transportKind: 'ngrok' })
    for (const enabled of [true, false]) {
      service.saveSettings({ ...service.loadSettings(), remoteAccessEnabled: enabled, transportKind: 'relay' })
      const saved = vi.mocked(fs.writeFileSync).mock.calls.at(-1)![1] as string
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(saved)
      expect(new SettingsService().loadSettings()).toMatchObject({ remoteAccessEnabled: enabled, transportKind: 'relay' })
      expect(saved).not.toMatch(/CONNECTED|ConnectionId|nextReconnectAt|credential|token/)
    }
  })
  it('persists only the configured connection domain and reloads the same identity', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const settings = new SettingsService().loadSettings()
    settings.ngrokDomain = 'stable.ngrok.app'
    new SettingsService().saveSettings(settings)
    const saved = vi.mocked(fs.writeFileSync).mock.calls.at(-1)![1] as string
    expect(JSON.parse(saved).ngrokDomain).toBe('stable.ngrok.app')
    expect(saved).not.toMatch(/authtoken|CONNECTED|localEndpoint|connectedAt/)
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(saved)
    expect(new SettingsService().loadSettings().ngrokDomain).toBe('stable.ngrok.app')
  })
})
