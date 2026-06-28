import { ipcMain } from 'electron'
import { SettingsService } from '../core/settings-service'

export function registerSettingsHandlers(settingsService: SettingsService): void {
  ipcMain.handle('load-settings', async () => {
    return settingsService.loadSettings()
  })

  ipcMain.handle('save-settings', async (_event, settings) => {
    settingsService.saveSettings(settings)
    return { success: true }
  })
}
