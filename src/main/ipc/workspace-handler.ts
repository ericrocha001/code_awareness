import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { SettingsService } from '../core/settings-service'
import type { RepositoryCatalogService } from '../repository-catalog/repository-catalog-service'
import type { RepositoryRuntimeService } from '../repository-catalog/repository-runtime-service'

export function registerWorkspaceHandlers(
  settingsService: SettingsService,
  repositories: RepositoryCatalogService,
  runtime: RepositoryRuntimeService
): void {
  const chooseDirectory = async (event: Electron.IpcMainInvokeEvent, title: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const result = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  }

  const importRoot = async (event: Electron.IpcMainInvokeEvent) => {
    const rootPath = await chooseDirectory(event, 'Adicionar Pasta Raiz (Múltiplos Repositórios)')
    if (rootPath) {
      const settings = settingsService.loadSettings()
      if (!settings.rootFolders.includes(rootPath)) {
        settings.rootFolders.push(rootPath)
        settingsService.saveSettings(settings)
      }
      await repositories.importRoot(rootPath)
    }
    return repositories.list()
  }

  const importLocal = async (event: Electron.IpcMainInvokeEvent) => {
    const checkoutPath = await chooseDirectory(event, 'Adicionar Repositório Local')
    if (checkoutPath) {
      const settings = settingsService.loadSettings()
      if (!settings.individualProjects.includes(checkoutPath)) {
        settings.individualProjects.push(checkoutPath)
        settingsService.saveSettings(settings)
      }
      await repositories.importLocal(checkoutPath)
    }
    return repositories.list()
  }

  const hide = (repositoryId: string) => {
    const record = repositories.store.get(repositoryId)
    const settings = settingsService.loadSettings()
    const checkoutPath = record.localCheckout?.path
    if (checkoutPath && !settings.hiddenProjects.includes(checkoutPath)) {
      settings.hiddenProjects.push(checkoutPath)
      settingsService.saveSettings(settings)
    }
    repositories.hide(repositoryId)
    return repositories.list()
  }

  ipcMain.handle('repositories:list', () => repositories.list())
  ipcMain.handle('repositories:refresh', () => repositories.refresh(settingsService.loadSettings()))
  ipcMain.handle('repositories:import-root', importRoot)
  ipcMain.handle('repositories:import-local', importLocal)
  ipcMain.handle('repositories:hide', (_event, repositoryId: unknown) => {
    if (typeof repositoryId !== 'string' || !repositoryId) throw new Error('INVALID_REPOSITORY_ID')
    return hide(repositoryId)
  })
  ipcMain.handle('repositories:activate', async (_event, repositoryId: unknown) => {
    if (typeof repositoryId !== 'string' || !repositoryId) return { success: false, error: 'INVALID_REPOSITORY_ID' }
    try {
      return { success: true, data: await runtime.activate(repositoryId) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('workspace:add-root-folder', async (event) => {
    await importRoot(event)
    return repositories.toLegacyProjects()
  })
  ipcMain.handle('workspace:add-individual-project', async (event) => {
    await importLocal(event)
    return repositories.toLegacyProjects()
  })
  ipcMain.handle('workspace:get-projects-list', () => repositories.toLegacyProjects())
  ipcMain.handle('workspace:hide-project', (_event, projectPath: string) => {
    const record = repositories.findByPath(projectPath)
    if (record) hide(record.id)
    return repositories.toLegacyProjects()
  })
}
