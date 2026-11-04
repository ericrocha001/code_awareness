import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { CodexArchiveBridge } from '../session-context/codex-archive-bridge'

export function registerCodexArchiveHandlers(getBridge: () => CodexArchiveBridge | undefined, getWindow: () => BrowserWindow | null, trustedUrl: string): void {
  const bind = (name: string, callback: (window: BrowserWindow, bridge: CodexArchiveBridge | undefined) => unknown) => {
    ipcMain.handle('codex-archive:' + name, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const window = getWindow(), url = event.senderFrame?.url
      if (args.length || !window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || !url || new URL(url).href.split('#')[0] !== new URL(trustedUrl).href.split('#')[0]) throw new Error('UNAUTHORIZED')
      return callback(window, getBridge())
    })
  }
  bind('inspect', (_window, bridge) => bridge?.inspect() ?? { state: 'NOT_CONFIGURED' })
  bind('disable', (_window, bridge) => bridge?.disable() ?? { state: 'NOT_CONFIGURED' })
  bind('enable', async (window, bridge) => {
    if (!bridge) return { state: 'NOT_CONFIGURED' }
    const executable = await dialog.showOpenDialog(window, { title: 'Selecione o executável Codex autorizado', properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'Executável Codex', extensions: ['exe'] }] } : {}) })
    if (executable.canceled || executable.filePaths.length !== 1) return bridge.inspect()
    const profile = await dialog.showOpenDialog(window, { title: 'Selecione o perfil Codex autorizado', properties: ['openDirectory'] })
    if (profile.canceled || profile.filePaths.length !== 1) return bridge.inspect()
    if (bridge !== getBridge() || window.isDestroyed()) throw new Error('PROJECT_CONTEXT_CHANGED')
    return bridge.enable({ executable: executable.filePaths[0], directory: profile.filePaths[0] })
  })
}
