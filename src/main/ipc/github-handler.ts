import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { GitHubCreateRepositoryInput, GitHubOperationResult, GitHubPublishRepositoryInput } from '../../shared/types/github-types'
import type { GitHubIntegrationService } from '../github/github-integration-service'
import { toGitHubIntegrationError } from '../github/github-errors'

export function registerGitHubHandlers(service: GitHubIntegrationService): void {
  const chooseDirectory = async (event: Electron.IpcMainInvokeEvent, title: string): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const result = await dialog.showOpenDialog(window, { title, properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  }

  ipcMain.handle('github:get-status', () => service.getStatus())
  ipcMain.handle('github:connect', () => service.connect())
  ipcMain.handle('github:cancel-connect', () => service.cancelConnect())
  ipcMain.handle('github:open-authorization', () => service.openAuthorization())
  ipcMain.handle('github:open-installation', () => service.openInstallation())
  ipcMain.handle('github:open-manage-access', () => service.openManageAccess())
  ipcMain.handle('github:disconnect', () => service.disconnect())
  ipcMain.handle('github:refresh', async (): Promise<GitHubOperationResult> => {
    try { return { success: true, repositories: await service.refresh() } }
    catch (error) {
      const translated = toGitHubIntegrationError(error)
      return { success: false, error: { code: translated.code, message: translated.message } }
    }
  })
  ipcMain.handle('github:clone-repository', async (event, repositoryId: string) => {
    const parentPath = await chooseDirectory(event, 'Choose a parent directory for the clone')
    return parentPath ? service.cloneRepository(repositoryId, parentPath) : cancelled()
  })
  ipcMain.handle('github:create-repository', async (event, input: GitHubCreateRepositoryInput) => {
    const localParentPath = input.localParentPath ?? await chooseDirectory(event, 'Choose a parent directory for the new repository')
    return localParentPath ? service.createRepository({ ...input, localParentPath }) : cancelled()
  })
  ipcMain.handle('github:publish-repository', (_event, input: GitHubPublishRepositoryInput) => service.publishRepository(input))
}

function cancelled(): GitHubOperationResult {
  return { success: false, error: { code: 'AUTHORIZATION_CANCELLED', message: 'Operation cancelled.' } }
}
