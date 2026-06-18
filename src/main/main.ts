// Responsabilidades do Script
//
// 1. Inicializar o ciclo de vida do aplicativo Electron.
// 2. Criar e configurar a janela principal do navegador (BrowserWindow) com segurança (contextIsolation, sandbox, etc).
// 3. Carregar a interface do usuário correspondente (desenvolvimento vs produção).
// 4. Registrar todos os manipuladores de IPC (Inter-Process Communication) do aplicativo.
// 5. Normalizar o ambiente PATH no Windows para detectar comandos externos como codefetch.

import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerCodefetchHandlers } from './ipc/codefetch-handler'
import { registerFileHandlers } from './ipc/file-handler'
import { registerSettingsHandlers } from './ipc/settings-handler'
import { sanitizeEnvironment } from './utils/env-sanitizer'

let mainWindow: BrowserWindow | null = null

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

  // Registrar handlers passando a janela onde for necessário (ex: dialogs)
  registerCodefetchHandlers()
  registerFileHandlers(mainWindow)
  registerSettingsHandlers(mainWindow)

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
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
