/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Expor APIs seguras e limitadas do processo principal para o renderer usando contextBridge.
2. Garantir isolamento de contexto impedindo o acesso direto a módulos do Node.js pela interface.
3. Mapear os canais IPC do fluxo de monitoramento Git, de arquivos modificados e de importância para o renderer.
4. Expor listeners e APIs para permitir a sincronização em tempo real de importância entre abas.

Mapa de Relacionamentos do Script

1. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece as definições de tipo compartilhadas expostas às APIs do preload.
   - Criticidade: Alta

2. git-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Registra os handlers correspondentes aos métodos invocados pelo preload.
   - Criticidade: Alta

3. file-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Registra os handlers correspondentes a salvamento, seleção e propagação de arquivos expostos por este preload.
   - Criticidade: Alta

Invariantes do Script

1. O isolamento de contexto deve ser sempre mantido.
2. Módulos Node.js nunca devem ser expostos diretamente ao renderer.
3. Todos os métodos expostos pelo contextBridge devem fazer uso estrito de IPC seguro.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { AppSettings, CheckpointData, CheckpointDiffFile, CheckpointSummary, CodefetchResult, DiffFileStatus, FileImportance, ImportanceLevel, ImportanceSource, ProjectInfo, RestoreValidation } from '../shared/types'

contextBridge.exposeInMainWorld('codeAwareness', {
  saveMarkdown: (markdown: string, repoName: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-markdown', markdown, repoName)
  },
  saveXml: (xml: string, repoName: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-xml', xml, repoName)
  },
  saveToDownloads: (markdown: string, fileName: string): Promise<{ success: boolean; filePath?: string; error?: string }> => {
    return ipcRenderer.invoke('save-to-downloads', markdown, fileName)
  },
  exportToNotebookLM: (markdown: string, fileName: string): Promise<{ success: boolean; fileCount: number; filePaths?: string[]; error?: string }> => {
    return ipcRenderer.invoke('export-to-notebooklm', markdown, fileName)
  },
  exportToDocx: (markdown: string, fileName: string): Promise<{ success: boolean; fileCount: number; filePaths?: string[]; error?: string }> => {
    return ipcRenderer.invoke('export-to-docx', markdown, fileName)
  },
  loadSettings: (): Promise<AppSettings> => {
    return ipcRenderer.invoke('load-settings')
  },
  saveSettings: (settings: AppSettings): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('save-settings', settings)
  },
  selectFolder: (): Promise<{ path: string; name: string } | null> => {
    return ipcRenderer.invoke('select-folder')
  },
  selectDocumentForPropagation: (): Promise<{ path: string; name: string } | null> => {
    return ipcRenderer.invoke('select-document-for-propagation')
  },
  propagateDocument: (
    sourceFilePath: string,
    destinationRepoPaths: string[]
  ): Promise<{ success: number; failed: number; errors: string[] }> => {
    return ipcRenderer.invoke('propagate-document', sourceFilePath, destinationRepoPaths)
  },
  getPathForFile: (file: File): string => {
    return webUtils.getPathForFile(file)
  },
  checkRepository: (dirPath: string): Promise<boolean> => {
    return ipcRenderer.invoke('git:check-repository', dirPath)
  },
  getModifiedFiles: (dirPath: string): Promise<DiffFileStatus[]> => {
    return ipcRenderer.invoke('git:get-modified-files', dirPath)
  },
  startWatcher: (dirPath: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('watcher:start', dirPath)
  },
  stopWatcher: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('watcher:stop')
  },
  onFileChanged: (callback: (filePath: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, filePath: string): void => callback(filePath)
    ipcRenderer.on('watcher:file-changed', handler)
    return () => ipcRenderer.removeListener('watcher:file-changed', handler)
  },
  generateSemanticDiff: (repoPath: string, selectedFiles?: string[]): Promise<string> => {
    return ipcRenderer.invoke('git:generate-semantic-diff', repoPath, selectedFiles)
  },
  getAllFiles: (dirPath: string): Promise<DiffFileStatus[]> => {
    return ipcRenderer.invoke('git:get-all-files', dirPath)
  },
  generateCompressionMarkdown: (repoPath: string, selectedFiles: string[]): Promise<string> => {
    return ipcRenderer.invoke('git:generate-compression-markdown', repoPath, selectedFiles)
  },
  addRootFolder: (): Promise<ProjectInfo[]> => {
    return ipcRenderer.invoke('workspace:add-root-folder')
  },
  addIndividualProject: (): Promise<ProjectInfo[]> => {
    return ipcRenderer.invoke('workspace:add-individual-project')
  },
  getProjectsList: (): Promise<ProjectInfo[]> => {
    return ipcRenderer.invoke('workspace:get-projects-list')
  },
  hideProject: (projectPath: string): Promise<ProjectInfo[]> => {
    return ipcRenderer.invoke('workspace:hide-project', projectPath)
  },

  // Gerencia arquivos ignorados no diff (temporary / persistent)
  addIgnoredFile: (repoPath: string, relativePath: string, type: 'temporary' | 'persistent'): Promise<AppSettings | null> => {
    return ipcRenderer.invoke('git:add-ignored-file', repoPath, relativePath, type)
  },
  removeIgnoredFile: (repoPath: string, relativePath: string, type: 'temporary' | 'persistent'): Promise<AppSettings | null> => {
    return ipcRenderer.invoke('git:remove-ignored-file', repoPath, relativePath, type)
  },
  reconcileIgnoredFiles: (repoPath: string, currentModifiedFiles: string[]): Promise<AppSettings | null> => {
    return ipcRenderer.invoke('git:reconcile-ignored-files', repoPath, currentModifiedFiles)
  },
  
  checkCodeSourceInstallation: (): Promise<boolean> => {
    return ipcRenderer.invoke('code-source:check-installation')
  },
  generateCodeSource: (
    repoPath: string,
    options?: { selectedFiles?: string[]; format?: 'markdown' | 'xml' }
  ): Promise<CodefetchResult & { tokenCount?: number }> => {
    return ipcRenderer.invoke('code-source:generate', repoPath, options)
  },

  // ─── Importância Arquitetural ─────────────────────────────────────────

  classifyImportance: (
    repoPath: string,
    repoName: string,
    files: { relativePath: string }[]
  ): Promise<{ success: boolean; data?: Record<string, FileImportance>; error?: string }> => {
    return ipcRenderer.invoke('importance:classify', repoPath, repoName, files)
  },

  setImportanceOverride: (
    repoPath: string,
    repoName: string,
    relativePath: string,
    level: ImportanceLevel
  ): Promise<{ success: boolean; data?: Record<string, FileImportance>; error?: string }> => {
    return ipcRenderer.invoke('importance:set-override', repoPath, repoName, relativePath, level)
  },

  revealInExplorer: (repoPath: string, relativePath: string): Promise<boolean> => {
    return ipcRenderer.invoke('git:reveal-in-explorer', repoPath, relativePath)
  },

  onImportanceUpdated: (
    callback: (data: {
      repoPath: string
      relativePath: string
      level: ImportanceLevel
      source: ImportanceSource
    }) => void
  ): Electron.IpcRenderer => {
    return ipcRenderer.on('importance:updated', (_event, data) => {
      callback(data)
    })
  },

  removeImportanceUpdatedListener: () => {
    ipcRenderer.removeAllListeners('importance:updated')
  },

  // ─── Checkpoints ──────────────────────────────────────────────────────

  createCheckpoint: (
    repoPath: string,
    name: string,
    strategy: 'all' | 'critical-high'
  ): Promise<{ success: boolean; data?: CheckpointData; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:create', repoPath, name, strategy)
  },

  listCheckpoints: (
    repoPath: string
  ): Promise<{ success: boolean; data?: CheckpointSummary[]; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:list', repoPath)
  },

  loadCheckpoint: (
    repoPath: string,
    checkpointId: string
  ): Promise<{ success: boolean; data?: CheckpointData; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:load', repoPath, checkpointId)
  },

  deleteCheckpoint: (
    repoPath: string,
    checkpointId: string
  ): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:delete', repoPath, checkpointId)
  },

  deleteAllCheckpoints: (
    repoPath: string
  ): Promise<{ success: boolean; deletedCount: number; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:delete-all', repoPath)
  },

  generateCheckpointDiff: (
    repoPath: string,
    fromCheckpointId: string,
    toCheckpointId: string
  ): Promise<{ success: boolean; data?: string; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:generate-diff', repoPath, fromCheckpointId, toCheckpointId)
  },

  validateRestore: (
    repoPath: string,
    checkpointId: string
  ): Promise<{ success: boolean; data?: RestoreValidation; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:validate-restore', repoPath, checkpointId)
  },

  restoreCheckpoint: (
    repoPath: string,
    checkpointId: string
  ): Promise<{ success: boolean; data?: { restored: number; failed: number; errors: string[] }; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:restore', repoPath, checkpointId)
  },

  // APIs de detecção de commits removidas — limpeza agora é manual via botão 'Limpar Tudo' na UI

  renameCheckpoint: (
    repoPath: string,
    checkpointId: string,
    newName: string
  ): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:rename', repoPath, checkpointId, newName)
  },

  getCheckpointChangedFiles: (
    repoPath: string,
    fromCheckpointId: string,
    toCheckpointId: string
  ): Promise<{ success: boolean; data?: CheckpointDiffFile[]; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:get-changed-files', repoPath, fromCheckpointId, toCheckpointId)
  },

})