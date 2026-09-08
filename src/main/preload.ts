/*
-T ---
*/

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { ActionLog, AppSettings, Campaign, CampaignStatus, CheckpointData, CheckpointDetails, CheckpointDiffFile, CheckpointSummary, CodefetchResult, CompressionSettingsPayload, DashSettings, DiffFileStatus, OrphanFile, OutputFormat, ProjectInfo, RestoreExecuteOptions, RestoreExecuteResult, RestorePreviewResult, Tag } from '../shared/types'
import type { RepoDiscoveryRequest, RepoDiscoveryResult } from '../shared/types/repo-discovery-types'

contextBridge.exposeInMainWorld('codeAwareness', {
  saveMarkdown: (markdown: string, repoName: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-markdown', markdown, repoName)
  },
  saveXml: (xml: string, repoName: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-xml', xml, repoName)
  },
  saveToDownloads: (markdown: string, baseFileName: string, outputFormat?: OutputFormat): Promise<{ success: boolean; filePath?: string; error?: string }> => {
    return ipcRenderer.invoke('save-to-downloads', markdown, baseFileName, outputFormat)
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
  generateCompressionMarkdown: (repoPath: string, selectedFiles: string[], settings?: CompressionSettingsPayload): Promise<string> => {
    return ipcRenderer.invoke('git:generate-compression-markdown', repoPath, selectedFiles, settings)
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

  // Gerencia arquivos ignorados no diff
  addIgnoredFile: (repoPath: string, relativePath: string): Promise<AppSettings | null> => {
    return ipcRenderer.invoke('git:add-ignored-file', repoPath, relativePath)
  },
  removeIgnoredFile: (repoPath: string, relativePath: string): Promise<AppSettings | null> => {
    return ipcRenderer.invoke('git:remove-ignored-file', repoPath, relativePath)
  },
  reconcileIgnoredFiles: (repoPath: string, currentModifiedFiles: string[]): Promise<AppSettings | null> => {
    return ipcRenderer.invoke('git:reconcile-ignored-files', repoPath, currentModifiedFiles)
  },
  
  checkCodeSourceInstallation: (): Promise<boolean> => {
    return ipcRenderer.invoke('code-source:check-installation')
  },
  generateCodeSourceWithProfile: (
    repoPath: string,
    selectedFiles: string[],
    format?: 'markdown' | 'xml',
    profile?: unknown,
    generationId?: number,
    sessionKey?: string
  ): Promise<{
    success: boolean
    content?: string
    tokenCount?: number
    error?: string
    generationId?: number
  }> => {
    return ipcRenderer.invoke(
      'code-source:generate-with-profile',
      repoPath,
      selectedFiles,
      format,
      profile,
      generationId !== undefined && sessionKey !== undefined
        ? { generationId, sessionKey }
        : undefined
    )
  },


  revealInExplorer: (repoPath: string, relativePath: string): Promise<boolean> => {
    return ipcRenderer.invoke('git:reveal-in-explorer', repoPath, relativePath)
  },

  onThemeChanged: (callback: (isDarkMode: boolean) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isDarkMode: boolean): void => callback(isDarkMode)
    ipcRenderer.on('theme-changed', handler)
    return () => ipcRenderer.removeListener('theme-changed', handler)
  },


  // ─── Checkpoints ──────────────────────────────────────────────────────

  createCheckpoint: (
    repoPath: string,
    name: string,
    details?: CheckpointDetails
  ): Promise<{ success: boolean; data?: CheckpointData; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:create', repoPath, name, details)
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

  generateCheckpointDiff: (
    repoPath: string,
    fromCheckpointId: string,
    toCheckpointId: string
  ): Promise<{ success: boolean; data?: string; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:generate-diff', repoPath, fromCheckpointId, toCheckpointId)
  },

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

  updateCheckpointDetails: (
    repoPath: string,
    checkpointId: string,
    details: CheckpointDetails
  ): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:update-details', repoPath, checkpointId, details)
  },

  setCheckpointCampaigns: (
    repoPath: string,
    checkpointId: string,
    campaignIds: string[]
  ): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('checkpoint:set-campaigns', repoPath, checkpointId, campaignIds)
  },

  // ─── Restauração ──────────────────────────────────────────────────────

  restorePreview: (
    repoPath: string,
    checkpointId: string
  ): Promise<{ success: boolean; data?: RestorePreviewResult; error?: string }> => {
    return ipcRenderer.invoke('restore:preview', repoPath, checkpointId)
  },

  restoreExecute: (
    repoPath: string,
    checkpointId: string,
    options: RestoreExecuteOptions
  ): Promise<{ success: boolean; data?: RestoreExecuteResult; error?: string; partial?: boolean }> => {
    return ipcRenderer.invoke('restore:execute', repoPath, checkpointId, options)
  },

  restoreMarkManual: (
    repoPath: string,
    checkpointId: string
  ): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('restore:mark-manual', repoPath, checkpointId)
  },

  restoreUnmark: (
    repoPath: string,
    checkpointId: string
  ): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('restore:unmark', repoPath, checkpointId)
  },

  // ─── Tags Manuais ──────────────────────────────────────────────────────

  getTags: (repoPath: string): Promise<{ success: boolean; data?: Tag[]; error?: string }> => {
    return ipcRenderer.invoke('tags:get', repoPath)
  },
  upsertTag: (
    repoPath: string,
    tag: Tag
  ): Promise<{ success: boolean; data?: Tag; error?: string }> => {
    return ipcRenderer.invoke('tags:upsert', repoPath, tag)
  },
  deleteTag: (repoPath: string, tagId: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('tags:delete', repoPath, tagId)
  },

  // ─── Associação Arquivo ↔ Tag ──────────────────────────────────────────

  getFileTags: (repoPath: string): Promise<{ success: boolean; data?: Record<string, string[]>; error?: string }> => {
    return ipcRenderer.invoke('tag:getFileTags', repoPath)
  },

  setFileTag: (repoPath: string, relativePath: string, tagId: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('tag:setFileTag', repoPath, relativePath, tagId)
  },

  removeFileTag: (repoPath: string, relativePath: string, tagId: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('tag:removeFileTag', repoPath, relativePath, tagId)
  },

  toggleDevTools: (): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('devtools:toggle'),

  // ─── Banco de Dados (Code Checkpoints) ──────────────────────────────────────
  initializeDatabase: (repoPath: string) =>
    ipcRenderer.invoke('database:initialize', repoPath),
  insertAction: (action: Omit<ActionLog, 'id'>) =>
    ipcRenderer.invoke('database:insert-action', action),
  getActions: (repoPath: string, limit?: number) =>
    ipcRenderer.invoke('database:get-actions', repoPath, limit),
  getActionsByDateRange: (repoPath: string, startDate: number, endDate: number) =>
    ipcRenderer.invoke('database:get-actions-by-date-range', repoPath, startDate, endDate),

  // ─── Deep Link ──────────────────────────────────────────────────────────
  getPendingDeepLink: (): Promise<string | null> => {
    return ipcRenderer.invoke('deeplink:get-pending')
  },
  onDeepLink: (callback: (url: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string): void => callback(url)
    ipcRenderer.on('deeplink:received', handler)
    return () => ipcRenderer.removeListener('deeplink:received', handler)
  },

  // ─── Code Campaign ──────────────────────────────────────────────────────
  createCampaign: (
    repoPath: string,
    data: { name: string; description?: string }
  ): Promise<{ success: boolean; data?: Campaign; error?: string }> => {
    return ipcRenderer.invoke('campaign:create', repoPath, data)
  },

  listCampaigns: (
    repoPath: string
  ): Promise<{ success: boolean; data?: Campaign[]; error?: string }> => {
    return ipcRenderer.invoke('campaign:list', repoPath)
  },

  getCampaign: (
    repoPath: string,
    campaignId: string
  ): Promise<{ success: boolean; data?: Campaign | null; error?: string }> => {
    return ipcRenderer.invoke('campaign:get', repoPath, campaignId)
  },

  updateCampaign: (
    repoPath: string,
    campaignId: string,
    patch: { name?: string; description?: string; status?: CampaignStatus }
  ): Promise<{ success: boolean; data?: Campaign; error?: string }> => {
    return ipcRenderer.invoke('campaign:update', repoPath, campaignId, patch)
  },

  // ─── Code Map ─────────────────────────────────────────────────────────────
  openRepository: (repoPath: string) => ipcRenderer.invoke('code-map:open-repository', repoPath),
  closeRepository: (repoPath: string) => ipcRenderer.invoke('code-map:close-repository', repoPath),
  indexRepository: (repoPath: string) => ipcRenderer.invoke('code-map:index-repository', repoPath),
  synchronizeModified: (repoPath: string) => ipcRenderer.invoke('code-map:synchronize-modified', repoPath),
  getRepository: (repoPath: string) => ipcRenderer.invoke('code-map:get-repository', repoPath),
  getFiles: (repoPath: string) => ipcRenderer.invoke('code-map:get-files', repoPath),
  getElements: (repoPath: string) => ipcRenderer.invoke('code-map:get-elements', repoPath),
  getRelationships: (repoPath: string) => ipcRenderer.invoke('code-map:get-relationships', repoPath),
  getSyncStatus: (repoPath: string) => ipcRenderer.invoke('code-map:get-sync-status', repoPath),
  getModifiedFilesCount: (repoPath: string) => ipcRenderer.invoke('code-map:get-modified-files-count', repoPath),
  getElementSnippet: (repoPath: string, elementId: string) =>
    ipcRenderer.invoke('code-map:get-element-snippet', repoPath, elementId),
  getFileContent: (repoPath: string, relativePath: string) =>
    ipcRenderer.invoke('code-map:get-file-content', repoPath, relativePath),
  openInVSCode: (repoPath: string, elementId: string) =>
    ipcRenderer.invoke('code-map:open-in-vscode', repoPath, elementId),
  verifyIntegrity: (repoPath: string, options?: { autoRepair?: boolean; deep?: boolean; selectedIssues?: string[]; issues?: import('../shared/types').IntegrityIssue[] }) =>
    ipcRenderer.invoke('code-map:verify-integrity', repoPath, options) as Promise<{
      success: boolean
      data?: import('../../shared/types').IntegrityCheckResult
      error?: string
    }>,
  generateScope: (repoPath: string, anchorFileId: string) =>
    ipcRenderer.invoke('code-map:generate-scope', repoPath, anchorFileId),
  generateCompressedScope: (repoPath: string, anchorFileId: string) =>
    ipcRenderer.invoke('code-map:generate-compressed-scope', repoPath, anchorFileId),
  onCodeMapFileModified: (callback: (data: { repoPath: string; relativePath: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { repoPath: string; relativePath: string }): void => callback(data)
    ipcRenderer.on('code-map:file-modified', handler)
    return () => ipcRenderer.removeListener('code-map:file-modified', handler)
  },
  onCodeMapFileConfirmed: (callback: (data: { repoPath: string; relativePath: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { repoPath: string; relativePath: string }): void => callback(data)
    ipcRenderer.on('code-map:file-confirmed', handler)
    return () => ipcRenderer.removeListener('code-map:file-confirmed', handler)
  },
  onCodeMapFileIndexed: (callback: (data: { repoPath: string; relativePath: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { repoPath: string; relativePath: string }): void => callback(data)
    ipcRenderer.on('code-map:file-indexed', handler)
    return () => ipcRenderer.removeListener('code-map:file-indexed', handler)
  },

  // ─── Code Dash ─────────────────────────────────────────────────────────────
  dashParseAndResolve: (
    input: string,
    repoPath: string
  ): Promise<{
    success: boolean
    data?: unknown
    error?: string
  }> => {
    return ipcRenderer.invoke('dash:parse-and-resolve', input, repoPath)
  },
  dashDiscover: (
    request: RepoDiscoveryRequest,
    repoPath: string
  ): Promise<{ success: boolean; data?: RepoDiscoveryResult; error?: string }> => {
    return ipcRenderer.invoke('dash:discover', request, repoPath)
  },
  dashGenerate: (
    input: string,
    repoPath: string,
    settings?: DashSettings
  ): Promise<{
    success: boolean
    data?: unknown
    error?: string
  }> => {
    return ipcRenderer.invoke('dash:generate', input, repoPath, settings)
  },
  dashOneClickXml: (
    repoPath: string,
    options?: {
      removeComments?: boolean
      removeEmptyLines?: boolean
      truncateBase64?: boolean
      persistedSettings?: DashSettings
    }
  ): Promise<{
    success: boolean
    xml?: string
    tokenCount?: number
    error?: string
    timings?: {
      listFilesMs: number
      generateMs: number
      totalMs: number
    }
    metadata?: {
      fileCount: number
    }
  }> => {
    return ipcRenderer.invoke('dash:one-click-xml', repoPath, options, options?.persistedSettings)
  }
})
