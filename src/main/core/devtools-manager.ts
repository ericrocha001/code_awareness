/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerenciar a abertura e fechamento das DevTools do Electron.
2. Registrar atalho global F12 para toggle das DevTools.
3. Isolar toda a lógica de DevTools em um serviço dedicado (SRP).

Mapa de Relacionamentos do Script

1. devtools-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Consome DevToolsManager.toggle() via handler IPC.
   - Criticidade: Alta

2. main.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e registra o atalho global.
   - Criticidade: Alta

Invariantes do Script

1. O método toggle nunca deve ser chamado antes da janela ser criada.
2. O atalho F12 deve ser registrado apenas uma vez no ciclo de vida.
3. Nunca lançar erros não tratados para o caller.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { BrowserWindow, globalShortcut } from 'electron'

export class DevToolsManager {
  static toggle(mainWindow: BrowserWindow): void {
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools()
    } else {
      mainWindow.webContents.openDevTools({ mode: 'right' })
    }
  }

  static registerShortcuts(mainWindow: BrowserWindow): void {
    // Atalho F12 — compatibilidade com navegadores
    globalShortcut.register('F12', () => {
      // Guarda de segurança contra acesso a janela destruída
      if (mainWindow && !mainWindow.isDestroyed()) {
        this.toggle(mainWindow)
      }
    })
    // Atalho Ctrl+Shift+I — atalho padrão do Electron/Chrome DevTools
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        this.toggle(mainWindow)
      }
    })
  }

  static unregisterShortcuts(): void {
    globalShortcut.unregister('F12')
    globalShortcut.unregister('CommandOrControl+Shift+I')
  }
}