/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Registrar o handler IPC devtools:toggle para comunicação segura com o renderer.
2. Delegar a lógica de toggle para o DevToolsManager.

Mapa de Relacionamentos do Script

1. DevToolsManager
   - Tipo: Dependência Direta
   - Relação: Chama DevToolsManager.toggle() para abrir/fechar DevTools.
   - Criticidade: Alta

2. preload.ts
   - Tipo: Dependência Inversa
   - Relação: O método toggleDevTools no preload invoca o canal devtools:toggle.
   - Criticidade: Alta

Invariantes do Script

1. O handler deve sempre retornar { success: true } após execução bem-sucedida.
2. Nunca lançar erros não tratados para o caller.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { ipcMain, BrowserWindow } from 'electron'
import { DevToolsManager } from '../core/devtools-manager'

export function registerDevToolsHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('devtools:toggle', () => {
    // Guarda de segurança contra acesso a janela destruída
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { success: false }
    }
    DevToolsManager.toggle(mainWindow)
    return { success: true }
  })
}
