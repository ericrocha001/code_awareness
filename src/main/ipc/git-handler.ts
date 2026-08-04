/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Registrar os handlers IPC para verificação de repositório Git e listagem de arquivos modificados.
2. Registrar os handlers IPC para controle do ciclo de vida do WatcherService.
3. Emitir eventos push ao renderer via webContents.send quando arquivos forem detectados pelo watcher.
4. Registrar o handler IPC que dispara a geração do Semantic Diff via DiffService.
5. Registrar handlers IPC para gerenciamento de arquivos ignorados no diff.
6. Validar array vazio no handler git:generate-compression-markdown antes de delegar ao CompressionService.
7. Reconciliar ignores removendo entradas cujo arquivo não existe mais no disco.

Mapa de Relacionamentos do Script

1. git-service.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e consome GitService para operações Git.
   - Criticidade: Alta

2. watcher-service.ts
   - Tipo: Dependência Direta
   - Relação: Registra eventos de alteração de arquivo do WatcherService.
   - Criticidade: Alta

3. diff-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome DiffService para gerar diffs semânticos.
   - Criticidade: Alta

4. settings-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome SettingsService para ler/gravar configurações globais.
   - Criticidade: Alta

Invariantes do Script

1. Handlers IPC nunca devem lançar exceções não tratadas para o renderer; erros devem ser capturados e retornados de forma estruturada.
2. Caminhos de repositório recebidos devem sempre ser validados antes de qualquer operação no disco.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { ipcMain, shell, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { GitService } from '../core/git-service'
import { WatcherService } from '../core/watcher-service'
import { DiffService } from '../core/diff-service'
import { SettingsService } from '../core/settings-service'
import { CompressionService } from '../core/compression-service'
import { CodeSourceService } from '../core/code-source-service'
import { RepomixAdapter } from '../core/repomix-adapter'

const gitService = new GitService()
const diffService = new DiffService()
const compressionService = new CompressionService()
const codeSourceService = new CodeSourceService()
const repomixAdapter = new RepomixAdapter()
// Valida se o path recebido via IPC é uma string não vazia
function isValidPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function registerGitHandlers(watcherService: WatcherService, settingsService: SettingsService): void {
  ipcMain.handle('git:check-repository', async (_event, dirPath: string) => {
    if (!isValidPath(dirPath)) return false
    return gitService.isGitRepository(dirPath)
  })

  ipcMain.handle('git:get-modified-files', async (_event, dirPath: string) => {
    if (!isValidPath(dirPath)) return []
    return gitService.getModifiedFiles(dirPath)
  })

  ipcMain.handle('watcher:start', async (event, dirPath: string) => {
    if (!isValidPath(dirPath)) return { success: false }
    const webContents = event.sender
    const repoPath = dirPath

    // Callback de detecção de commits removido — limpeza agora é manual via botão 'Limpar Tudo' na UI

    watcherService.start(dirPath, (filePath) => {
      if (!webContents.isDestroyed()) {
        webContents.send('watcher:file-changed', filePath)
      }
    })
    return { success: true }
  })

  ipcMain.handle('watcher:stop', async () => {
    watcherService.stop()
    return { success: true }
  })

  ipcMain.handle('git:generate-semantic-diff', async (_event, repoPath: string, selectedFiles?: string[]) => {
    if (!isValidPath(repoPath)) return ''
    return diffService.generateSemanticDiff(repoPath, selectedFiles)
  })

  ipcMain.handle('git:get-all-files', async (_event, dirPath: string) => {
    if (!isValidPath(dirPath)) return []
    return gitService.getAllFiles(dirPath)
  })

  ipcMain.handle('git:generate-compression-markdown', async (_event, repoPath: string, selectedFiles: string[]) => {
    if (!isValidPath(repoPath) || !Array.isArray(selectedFiles) || selectedFiles.length === 0) return ''
    return compressionService.generateCompressionMarkdown(repoPath, selectedFiles)
  })

  ipcMain.handle('code-source:generate', async (_event, repoPath: string, options?: {
    selectedFiles?: string[]
    format?: 'markdown' | 'xml'
  }) => {
    if (!isValidPath(repoPath)) return { success: false, error: 'Invalid path' }
    return codeSourceService.generateCodeSource(repoPath, options)
  })

  ipcMain.handle('code-source:check-installation', async () => {
    return repomixAdapter.checkInstallation()
  })

  // Adiciona um arquivo/padrão à lista de ignorados para o repositório informado
  ipcMain.handle('git:add-ignored-file', async (_event, repoPath: string, relativePath: string) => {
    if (!isValidPath(repoPath) || !isValidPath(relativePath)) return null
    const settings = settingsService.loadSettings()
    if (!settings.ignoredDiffFiles[repoPath]) {
      settings.ignoredDiffFiles[repoPath] = []
    }
    const list = settings.ignoredDiffFiles[repoPath]
    if (!list.includes(relativePath)) {
      list.push(relativePath)
    }
    settingsService.saveSettings(settings)
    return settings
  })

  // Remove um arquivo/padrão da lista de ignorados para o repositório informado
  ipcMain.handle('git:remove-ignored-file', async (_event, repoPath: string, relativePath: string) => {
    if (!isValidPath(repoPath) || !isValidPath(relativePath)) return null
    const settings = settingsService.loadSettings()
    const repoIgnores = settings.ignoredDiffFiles[repoPath]
    if (repoIgnores) {
      settings.ignoredDiffFiles[repoPath] = repoIgnores.filter(p => p !== relativePath)
    }
    settingsService.saveSettings(settings)
    return settings
  })



  // Reconciliador: remove da lista de ignorados apenas padrões/arquivos que representam arquivos
  // deletados fisicamente do disco, evitando entradas fantasma.
  ipcMain.handle('git:reconcile-ignored-files', async (_event, repoPath: string, _currentModifiedFiles: string[]) => {
    if (!isValidPath(repoPath)) return null
    const settings = settingsService.loadSettings()
    const repoIgnores = settings.ignoredDiffFiles[repoPath]
    if (repoIgnores) {
      settings.ignoredDiffFiles[repoPath] = repoIgnores.filter(p => {
        // Se for um padrão (ex: *.css), mantém.
        if (p.includes('*')) return true
        // Caso contrário, valida existência no disco.
        return existsSync(join(repoPath, p))
      })
    }
    settingsService.saveSettings(settings)
    return settings
  })

  // Revela um arquivo no Explorer/Finder nativo do sistema operacional
  ipcMain.handle('git:reveal-in-explorer', async (_event, repoPath: string, relativePath: string) => {
    if (!isValidPath(repoPath) || !isValidPath(relativePath)) return false
    const fullPath = join(repoPath, relativePath)
    if (existsSync(fullPath)) {
      shell.showItemInFolder(fullPath)
      return true
    }
    return false
  })
}
