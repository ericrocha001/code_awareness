// Responsabilidades do Script
//
// 1. Inicializar o ciclo de vida e a janela principal do aplicativo Electron.
// 2. Registrar todos os manipuladores de IPC (Inter-Process Communication).
// 3. Normalizar as variáveis de ambiente PATH para compatibilidade com CLI.

import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'path'
import { registerCodefetchHandlers } from './ipc/codefetch-handler'
import { registerFileHandlers } from './ipc/file-handler'
import { registerSettingsHandlers } from './ipc/settings-handler'
import { registerGitHandlers } from './ipc/git-handler'
import { registerWorkspaceHandlers } from './ipc/workspace-handler'
import { SettingsService } from './core/settings-service'
import { WorkspaceService } from './core/workspace-service'
import { sanitizeEnvironment } from './utils/env-sanitizer'
import { WatcherService } from './core/watcher-service'

// Handlers globais de crash para evitar quedas silenciosas
process.on('uncaughtException', (error) => {
  console.error('[CrashHandler] uncaughtException:', error.message)
  if (error.stack) console.error('[CrashHandler] Stack:', error.stack)
})

process.on('unhandledRejection', (reason) => {
  console.error('[CrashHandler] unhandledRejection:', reason)
})

let mainWindow: BrowserWindow | null = null
const watcherService = new WatcherService()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  Menu.setApplicationMenu(null)

  // Redirecionar links externos para o navegador padrão
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Normalizar ambiente PATH antes de qualquer operação
sanitizeEnvironment()

app.whenReady().then(() => {
  const settingsService = new SettingsService()
  const workspaceService = new WorkspaceService()

  // Registrar todos os handlers IPC dinâmicos e estáticos de forma única no ciclo de vida
  registerCodefetchHandlers()
  registerFileHandlers()
  registerSettingsHandlers()
  registerGitHandlers(watcherService)
  registerWorkspaceHandlers(settingsService, workspaceService)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  watcherService.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})