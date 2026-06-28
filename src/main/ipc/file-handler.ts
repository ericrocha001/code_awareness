/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Registrar handlers IPC relacionados a operações com arquivos (Markdown, XML e Downloads).
2. Prover caixa de diálogo para seleção de pastas e arquivos no sistema operacional.
3. Propagar arquivos para múltiplos repositórios destino através do serviço DocumentPropagator.

Mapa de Relacionamentos do Script

1. document-propagator.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e consome o serviço para propagar documentos nos destinos configurados.
   - Criticidade: Alta

Invariantes do Script

1. Todos os handlers IPC devem interceptar erros de sistema e retorná-los de forma amigável ao renderer.
2. A seleção de diretórios e arquivos deve usar caixas de diálogo nativas da janela ativa para evitar perda de foco.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { writeFileSync } from 'fs'
import { basename, join } from 'path'
import { DocumentPropagator } from '../core/document-propagator'

const documentPropagator = new DocumentPropagator()

export function registerFileHandlers(): void {
  ipcMain.handle('save-markdown', async (event, markdown: string, repoName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Save Markdown',
      defaultPath: `${repoName}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })

    if (canceled || !filePath) return { success: false, error: 'Cancelled' }

    try {
      writeFileSync(filePath, markdown, 'utf-8')
      return { success: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: message }
    }
  })

  ipcMain.handle('save-xml', async (event, xml: string, repoName: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Save XML',
      defaultPath: `${repoName}.xml`,
      filters: [{ name: 'XML', extensions: ['xml'] }]
    })

    if (canceled || !filePath) return { success: false, error: 'Cancelled' }

    try {
      writeFileSync(filePath, xml, 'utf-8')
      return { success: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: message }
    }
  })

  ipcMain.handle('save-to-downloads', async (_event, markdown: string, fileName: string) => {
    try {
      const downloadsPath = app.getPath('downloads')
      const filePath = join(downloadsPath, `${fileName}.md`)
      writeFileSync(filePath, markdown, 'utf-8')
      return { success: true, filePath }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: message }
    }
  })

  ipcMain.handle('select-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      title: 'Select Repository Folder',
      properties: ['openDirectory']
    })

    if (canceled || !filePaths.length) return null
    const path = filePaths[0]
    return {
      path,
      name: basename(path)
    }
  })

  ipcMain.handle('select-document-for-propagation', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      title: 'Selecionar Documento para Propagar',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Todos os Arquivos', extensions: ['*'] }
      ]
    })

    if (canceled || !filePaths.length) return null
    return { path: filePaths[0], name: basename(filePaths[0]) }
  })

  ipcMain.handle('propagate-document', async (_event, sourceFilePath: string, destinationRepoPaths: string[]) => {
    if (!sourceFilePath || !Array.isArray(destinationRepoPaths)) {
      return { success: 0, failed: 0, errors: ['Parâmetros inválidos'] }
    }
    return documentPropagator.propagate(sourceFilePath, destinationRepoPaths)
  })
}
