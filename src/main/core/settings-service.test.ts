/*
-T ---
*/

import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import { app } from 'electron'
import { SettingsService } from './settings-service'
import { DEFAULT_DASH_SETTINGS } from '../../shared/utils/dash-settings'

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

describe('SettingsService — dashSettings', () => {
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
  let service: SettingsService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new SettingsService()
  })

  it('quando o arquivo de configuração não existe, retorna DEFAULT_DASH_SETTINGS', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const settings = service.loadSettings()

    expect(settings.dashSettings).toEqual(DEFAULT_DASH_SETTINGS)
  })

  it('quando dashSettings está ausente no JSON, preenche com DEFAULT_DASH_SETTINGS', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ rootFolders: ['/repo'] })
    )

    const settings = service.loadSettings()

    expect(settings.dashSettings).toEqual(DEFAULT_DASH_SETTINGS)
  })

  it('quando dashSettings é válido no JSON, carrega e normaliza corretamente', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        dashSettings: {
          removeComments: true,
          removeEmptyLines: true,
          truncateBase64: false
        }
      })
    )

    const settings = service.loadSettings()

    expect(settings.dashSettings).toEqual({
      removeComments: true,
      removeEmptyLines: true,
      truncateBase64: false
    })
  })

  it('quando dashSettings está corrompido no JSON, normaliza defensivamente', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        dashSettings: {
          removeComments: 'invalid',
          extraField: 123
        }
      })
    )

    const settings = service.loadSettings()

    expect(settings.dashSettings).toEqual(DEFAULT_DASH_SETTINGS)
  })
})
