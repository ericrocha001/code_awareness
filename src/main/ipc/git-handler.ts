/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Registrar os handlers IPC para verificação de repositório Git e listagem de arquivos modificados.
2. Registrar os handlers IPC para controle do ciclo de vida do WatcherService.
3. Emitir eventos push ao renderer via webContents.send quando arquivos forem detectados pelo watcher.
4. Registrar o handler IPC que dispara a geração do Semantic Diff via DiffService.
5. Registrar handlers IPC para gerenciamento de arquivos ignorados (temporary/persistent) no diff.
6. Validar array vazio no handler git:generate-compression-markdown antes de delegar ao CompressionService.
7. Reconciliar ignores temporários usando fs.existsSync.
8. Registrar os handlers IPC de importância arquitetural (classify e set-override).
9. Emitir evento IPC importance:updated quando uma classificação de importância for sobrescrita manualmente.

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

5. importance-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome importanceService para classificar arquivos e gerenciar overrides.
   - Criticidade: Alta

Invariantes do Script

1. Handlers IPC nunca devem lançar exceções não tratadas para o renderer; erros devem ser capturados e retornados de forma estruturada.
2. Caminhos de repositório recebidos devem sempre ser validados antes de qualquer operação no disco.
3. A sobrescrita manual de importância deve notificar todos os renderers ativos via evento IPC importance:updated.

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
import { importanceService } from '../core/importance-service'
import { ImportanceLevel } from '../../shared/types'

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

  ipcMain.handle('git:get-all-tracked-files', async (_event, dirPath: string) => {
    if (!isValidPath(dirPath)) return []
    return gitService.getAllTrackedFiles(dirPath)
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

  // Adiciona um arquivo à lista de ignorados (temporary ou persistent) para o repositório informado
  ipcMain.handle('git:add-ignored-file', async (_event, repoPath: string, relativePath: string, type: 'temporary' | 'persistent') => {
    if (!isValidPath(repoPath) || !isValidPath(relativePath)) return null
    const settings = settingsService.loadSettings()
    if (!settings.ignoredDiffFiles[repoPath]) {
      settings.ignoredDiffFiles[repoPath] = { temporary: [], persistent: [] }
    }
    const list = settings.ignoredDiffFiles[repoPath][type]
    if (!list.includes(relativePath)) {
      list.push(relativePath)
    }
    settingsService.saveSettings(settings)
    return settings
  })

  // Remove um arquivo da lista de ignorados (temporary ou persistent) para o repositório informado
  ipcMain.handle('git:remove-ignored-file', async (_event, repoPath: string, relativePath: string, type: 'temporary' | 'persistent') => {
    if (!isValidPath(repoPath) || !isValidPath(relativePath)) return null
    const settings = settingsService.loadSettings()
    const repoIgnores = settings.ignoredDiffFiles[repoPath]
    if (repoIgnores) {
      repoIgnores[type] = repoIgnores[type].filter(p => p !== relativePath)
    }
    settingsService.saveSettings(settings)
    return settings
  })

  // ─── Handlers IPC de Importância Arquitetural ──────────────────────────────

  /**
   * Classifica todos os arquivos de um repositório usando as 4 camadas de heurísticas,
   * preservando e mesclando com classificações já persistidas (overrides manuais).
   */
  ipcMain.handle('importance:classify', async (_event, repoPath: string, repoName: string, files: { relativePath: string }[]) => {
    try {
      // 1. Carrega classificações persistidas (inclui overrides manuais)
      const persisted = await importanceService.loadPersistedImportance(repoPath, repoName)
      
      // 2. Classifica apenas arquivos que não estão no cache persistido
      const filesToClassify = files.filter(f => !persisted?.[f.relativePath])
      const newClassifications = filesToClassify.length > 0
        ? await importanceService.classifyAllFiles(repoPath, filesToClassify)
        : {}
      
      // 3. Mescla persistidos + novos
      const merged = {
        ...persisted,
        ...newClassifications
      }
      
      // 4. Salva tudo de volta
      await importanceService.savePersistedImportance(repoPath, repoName, merged)
      
      return { success: true, data: merged }
    } catch (error: any) {
      console.error('[IPC] Erro ao classificar importância:', error)
      return { success: false, error: error.message }
    }
  })

  /**
   * Permite ao usuário sobrescrever manualmente a classificação de um arquivo específico.
   * Invalida o cache em memória para forçar o recarregamento correto.
   */
  ipcMain.handle('importance:set-override', async (_event, repoPath: string, repoName: string, relativePath: string, level: ImportanceLevel) => {
    try {
      const classifications = await importanceService.loadPersistedImportance(repoPath, repoName)

      if (!classifications) {
        return { success: false, error: 'Classificações não encontradas para este repositório' }
      }

      const fileImportance = classifications[relativePath]
      if (!fileImportance) {
        return { success: false, error: `Arquivo "${relativePath}" não encontrado nas classificações` }
      }

      // Atualiza o nível e marca a origem como manual (override do usuário)
      fileImportance.level = level
      fileImportance.source = 'manual'

      await importanceService.savePersistedImportance(repoPath, repoName, classifications)

      // Invalida cache em memória para forçar recarregamento da próxima vez
      importanceService.invalidateCache(repoPath, relativePath)

      // Emitir evento para todos os renderers notificando que a importância foi atualizada
      const allWindows = BrowserWindow.getAllWindows()
      allWindows.forEach((win) => {
        win.webContents.send('importance:updated', {
          repoPath,
          relativePath,
          level,
          source: 'manual'
        })
      })

      return { success: true, data: classifications }
    } catch (error: any) {
      console.error('[IPC] Erro ao sobrescrever importância:', error)
      return { success: false, error: error.message }
    }
  })

  // Reconciliador: remove da lista temporary apenas arquivos que foram deletados fisicamente do disco.
  // Usa fs.existsSync para verificar a existência real do arquivo, preservando ignores da aba Compression
  // (que lista arquivos "tracked", não apenas "modified").
  ipcMain.handle('git:reconcile-ignored-files', async (_event, repoPath: string, _currentModifiedFiles: string[]) => {
    if (!isValidPath(repoPath)) return null
    const settings = settingsService.loadSettings()
    const repoIgnores = settings.ignoredDiffFiles[repoPath]
    if (repoIgnores) {
      repoIgnores.temporary = repoIgnores.temporary.filter(p => existsSync(join(repoPath, p)))
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
