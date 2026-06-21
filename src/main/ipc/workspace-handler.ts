// Responsabilidades do Script
//
// 1. Interceptar chamadas IPC do render process relacionadas a projetos e pastas raízes.
// 2. Acionar as caixas de diálogo nativas do sistema para seleção de pastas.
// 3. Orquestrar a persistência nas configurações e acionar o WorkspaceService para devolver a lista atualizada.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { SettingsService } from '../core/settings-service'
import { WorkspaceService } from '../core/workspace-service'

export function registerWorkspaceHandlers(
  settingsService: SettingsService,
  workspaceService: WorkspaceService
) {
  ipcMain.handle('workspace:add-root-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const result = await dialog.showOpenDialog(win, {
      title: 'Adicionar Pasta Raiz (Múltiplos Projetos)',
      properties: ['openDirectory']
    })

    if (!result.canceled && result.filePaths.length > 0) {
      const folderPath = result.filePaths[0]
      const settings = settingsService.loadSettings()
      
      if (!settings.rootFolders.includes(folderPath)) {
        settings.rootFolders.push(folderPath)
        settingsService.saveSettings(settings)
      }
      
      return await workspaceService.getProjectsList(settings)
    }

    return await workspaceService.getProjectsList(settingsService.loadSettings())
  })

  ipcMain.handle('workspace:add-individual-project', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const result = await dialog.showOpenDialog(win, {
      title: 'Adicionar Projeto Único',
      properties: ['openDirectory']
    })

    if (!result.canceled && result.filePaths.length > 0) {
      const projectPath = result.filePaths[0]
      const settings = settingsService.loadSettings()
      
      if (!settings.individualProjects.includes(projectPath)) {
        settings.individualProjects.push(projectPath)
        settingsService.saveSettings(settings)
      }
      
      return await workspaceService.getProjectsList(settings)
    }

    return await workspaceService.getProjectsList(settingsService.loadSettings())
  })

  ipcMain.handle('workspace:get-projects-list', async () => {
    const settings = settingsService.loadSettings()
    return await workspaceService.getProjectsList(settings)
  })

  ipcMain.handle('workspace:hide-project', async (_event, projectPath: string) => {
    const settings = settingsService.loadSettings()
    if (!settings.hiddenProjects.includes(projectPath)) {
      settings.hiddenProjects.push(projectPath)
      settingsService.saveSettings(settings)
    }
    return await workspaceService.getProjectsList(settings)
  })
}
