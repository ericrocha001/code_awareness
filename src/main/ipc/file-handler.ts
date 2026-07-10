/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Registrar handlers IPC relacionados a operações com arquivos (Markdown, XML e Downloads).
2. Prover caixa de diálogo para seleção de pastas e arquivos no sistema operacional.
3. Propagar arquivos para múltiplos repositórios destino através do serviço DocumentPropagator.
4. Expor API IPC para converter markdown em DOCX via DocxExporter e salvar na pasta Downloads.

Mapa de Relacionamentos do Script

1. document-propagator.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e consome o serviço para propagar documentos nos destinos configurados.
   - Criticidade: Alta

2. document-chunker.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e consome o chunker para dividir markdown grande em partes antes de salvar.
   - Criticidade: Alta

3. docx-exporter.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e consome o exporter para converter markdown em DOCX.
   - Criticidade: Alta

Invariantes do Script

1. Todos os handlers IPC devem interceptar erros de sistema e retorná-los de forma amigável ao renderer.
2. A seleção de diretórios e arquivos deve usar caixas de diálogo nativas da janela ativa para evitar perda de foco.
3. O handler `export-to-notebooklm` deve sanitizar nomes de arquivo antes de passar para o DocxExporter.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { writeFileSync } from 'fs'
import { basename, join } from 'path'
import { DocumentPropagator } from '../core/document-propagator'
import { DocumentChunker } from '../core/document-chunker'
import { DocxExporter } from '../core/docx-exporter'

const documentPropagator = new DocumentPropagator()
const documentChunker = new DocumentChunker()
const docxExporter = new DocxExporter()

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

  ipcMain.handle('export-to-notebooklm', async (_event, markdown: string, fileName: string) => {
    try {
      if (!markdown || markdown.length === 0) {
        return { success: false, error: 'Nenhum conteúdo para exportar' }
      }
      if (!fileName || fileName.length === 0) {
        return { success: false, error: 'Nome do arquivo não pode ser vazio' }
      }

      const sanitized = fileName.replace(/[<>:"/\\|?*]/g, '_')
      const filePaths = await docxExporter.exportToDocx(markdown, sanitized)

      return { success: true, fileCount: filePaths.length, filePaths }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: message }
    }
  })
}
