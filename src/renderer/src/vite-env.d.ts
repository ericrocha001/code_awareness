/*
-T ---
*/

/// <reference types="vite/client" />

import { ActionLog, AppSettings, Campaign, CampaignStatus, CheckpointData, CheckpointDetails, CheckpointDiffFile, CheckpointSummary, CodefetchResult, CompressionSettingsPayload, DashSettings, DiffFileStatus, OrphanFile, OutputFormat, ProjectInfo, RestoreExecuteOptions, RestoreExecuteResult, RestorePreviewResult, Tag, DashResolutionReport, DashExecutionResult } from '../../shared/types'

declare global {
  interface Window {
    codeAwareness: {
      saveMarkdown: (markdown: string, repoName: string) => Promise<{ success: boolean; error?: string }>
      saveXml: (xml: string, repoName: string) => Promise<{ success: boolean; error?: string }>
      saveToDownloads: (markdown: string, baseFileName: string, outputFormat?: OutputFormat) => Promise<{ success: boolean; filePath?: string; error?: string }>
      exportToNotebookLM: (markdown: string, fileName: string) => Promise<{ success: boolean; fileCount: number; filePaths?: string[]; error?: string }>
      exportToDocx: (markdown: string, fileName: string) => Promise<{ success: boolean; fileCount: number; filePaths?: string[]; error?: string }>
      loadSettings: () => Promise<AppSettings>
      saveSettings: (settings: AppSettings) => Promise<{ success: boolean }>
      selectFolder: () => Promise<{ path: string; name: string } | null>
      selectDocumentForPropagation: () => Promise<{ path: string; name: string } | null>
      propagateDocument: (
        sourceFilePath: string,
        destinationRepoPaths: string[]
      ) => Promise<{ success: number; failed: number; errors: string[] }>
      getPathForFile: (file: File) => string
      checkRepository: (dirPath: string) => Promise<boolean>
      getModifiedFiles: (dirPath: string) => Promise<DiffFileStatus[]>
      startWatcher: (dirPath: string) => Promise<{ success: boolean }>
      stopWatcher: () => Promise<{ success: boolean }>
      onFileChanged: (callback: (filePath: string) => void) => () => void
      generateSemanticDiff: (repoPath: string, selectedFiles?: string[]) => Promise<string>
      getAllFiles: (dirPath: string) => Promise<DiffFileStatus[]>
      generateCompressionMarkdown: (repoPath: string, selectedFiles: string[], settings?: CompressionSettingsPayload) => Promise<string>
      addRootFolder: () => Promise<ProjectInfo[]>
      addIndividualProject: () => Promise<ProjectInfo[]>
      getProjectsList: () => Promise<ProjectInfo[]>
      hideProject: (projectPath: string) => Promise<ProjectInfo[]>
      addIgnoredFile: (repoPath: string, relativePath: string) => Promise<AppSettings | null>
      removeIgnoredFile: (repoPath: string, relativePath: string) => Promise<AppSettings | null>
      reconcileIgnoredFiles: (repoPath: string, currentModifiedFiles: string[]) => Promise<AppSettings | null>
      checkCodeSourceInstallation: () => Promise<boolean>
      generateCodeSourceWithProfile: (
        repoPath: string,
        selectedFiles: string[],
        format?: 'markdown' | 'xml',
        profile?: unknown,
        generationId?: number,
        sessionKey?: string
      ) => Promise<{
        success: boolean
        content?: string
        tokenCount?: number
        error?: string
        generationId?: number
      }>


      revealInExplorer: (repoPath: string, relativePath: string) => Promise<boolean>

      onThemeChanged: (callback: (isDarkMode: boolean) => void) => () => void



      // ─── Checkpoints ─────────────────────────────────────────────────
      createCheckpoint: (
        repoPath: string,
        name: string,
        details?: CheckpointDetails
      ) => Promise<{ success: boolean; data?: CheckpointData; error?: string }>

      listCheckpoints: (
        repoPath: string
      ) => Promise<{ success: boolean; data?: CheckpointSummary[]; error?: string }>

      loadCheckpoint: (
        repoPath: string,
        checkpointId: string
      ) => Promise<{ success: boolean; data?: CheckpointData; error?: string }>

      deleteCheckpoint: (
        repoPath: string,
        checkpointId: string
      ) => Promise<{ success: boolean; error?: string }>

      generateCheckpointDiff: (
        repoPath: string,
        fromCheckpointId: string,
        toCheckpointId: string
      ) => Promise<{ success: boolean; data?: string; error?: string }>

      renameCheckpoint: (
        repoPath: string,
        checkpointId: string,
        newName: string
      ) => Promise<{ success: boolean; error?: string }>

      getCheckpointChangedFiles: (
        repoPath: string,
        fromCheckpointId: string,
        toCheckpointId: string
      ) => Promise<{ success: boolean; data?: CheckpointDiffFile[]; error?: string }>

      updateCheckpointDetails: (
        repoPath: string,
        checkpointId: string,
        details: CheckpointDetails
      ) => Promise<{ success: boolean; error?: string }>

      setCheckpointCampaigns: (
        repoPath: string,
        checkpointId: string,
        campaignIds: string[]
      ) => Promise<{ success: boolean; error?: string }>

      // ─── Restauração ──────────────────────────────────────────────────

      restorePreview: (
        repoPath: string,
        checkpointId: string
      ) => Promise<{ success: boolean; data?: RestorePreviewResult; error?: string }>

      restoreExecute: (
        repoPath: string,
        checkpointId: string,
        options: RestoreExecuteOptions
      ) => Promise<{ success: boolean; data?: RestoreExecuteResult; error?: string; partial?: boolean }>

      restoreMarkManual: (
        repoPath: string,
        checkpointId: string
      ) => Promise<{ success: boolean; error?: string }>

      restoreUnmark: (
        repoPath: string,
        checkpointId: string
      ) => Promise<{ success: boolean; error?: string }>

      // ─── Tags Manuais ──────────────────────────────────────────────────

      getTags: (repoPath: string) => Promise<{ success: boolean; data?: Tag[]; error?: string }>

      upsertTag: (
        repoPath: string,
        tag: Tag
      ) => Promise<{ success: boolean; data?: Tag; error?: string }>

      deleteTag: (repoPath: string, tagId: string) => Promise<{ success: boolean; error?: string }>

      // ─── Associação Arquivo ↔ Tag ──────────────────────────────────────────

      getFileTags: (repoPath: string) => Promise<{ success: boolean; data?: Record<string, string[]>; error?: string }>

      setFileTag: (repoPath: string, relativePath: string, tagId: string) => Promise<{ success: boolean; error?: string }>

      removeFileTag: (repoPath: string, relativePath: string, tagId: string) => Promise<{ success: boolean; error?: string }>

      toggleDevTools: () => Promise<{ success: boolean }>

      // ─── Banco de Dados (Code Checkpoints) ───────────────────────────
      initializeDatabase: (repoPath: string) => Promise<{ success: boolean; error?: string }>
      insertAction: (action: Omit<ActionLog, 'id'>) => Promise<{ success: boolean; error?: string }>
      getActions: (repoPath: string, limit?: number) => Promise<{ success: boolean; data?: ActionLog[]; error?: string }>
      getActionsByDateRange: (repoPath: string, startDate: number, endDate: number) => Promise<{ success: boolean; data?: ActionLog[]; error?: string }>

      // ─── Code Campaign ──────────────────────────────────────────────────────
      createCampaign: (
        repoPath: string,
        data: { name: string; description?: string }
      ) => Promise<{ success: boolean; data?: Campaign; error?: string }>

      listCampaigns: (
        repoPath: string
      ) => Promise<{ success: boolean; data?: Campaign[]; error?: string }>

      getCampaign: (
        repoPath: string,
        campaignId: string
      ) => Promise<{ success: boolean; data?: Campaign | null; error?: string }>

      updateCampaign: (
        repoPath: string,
        campaignId: string,
        patch: { name?: string; description?: string; status?: CampaignStatus }
      ) => Promise<{ success: boolean; data?: Campaign; error?: string }>

      // ─── Deep Link ──────────────────────────────────────────────────────
      getPendingDeepLink: () => Promise<string | null>
      onDeepLink: (callback: (url: string) => void) => () => void

      // ─── Code Map ─────────────────────────────────────────────────────────────
      openRepository: (repoPath: string) => Promise<{ success: boolean; error?: string }>
      closeRepository: (repoPath: string) => Promise<{ success: boolean; error?: string }>
      indexRepository: (repoPath: string) => Promise<{ success: boolean; data?: { filesIndexed: number; elementsExtracted: number }; error?: string }>
      synchronizeModified: (repoPath: string) => Promise<{ success: boolean; data?: { filesUpdated: number; errors: string[] }; error?: string }>
      getRepository: (repoPath: string) => Promise<{ success: boolean; data?: import('../../shared/types').CodeMapRepository | null; error?: string }>
      getFiles: (repoPath: string) => Promise<{ success: boolean; data?: import('../../shared/types').CodeMapFile[]; error?: string }>
      getElements: (repoPath: string) => Promise<{ success: boolean; data?: import('../../shared/types').CodeMapElement[]; error?: string }>
      getRelationships: (repoPath: string) => Promise<{ success: boolean; data?: import('../../shared/types').CodeMapRelationship[]; error?: string }>
      getSyncStatus: (repoPath: string) => Promise<{ success: boolean; data?: import('../../shared/types').CodeMapSyncStatus; error?: string }>
      getModifiedFilesCount: (repoPath: string) => Promise<{ success: boolean; data?: number; error?: string }>
      getElementSnippet: (repoPath: string, elementId: string) => Promise<{
        success: boolean
        data?: {
          content: string
          startLine: number
          startColumn: number
          endLine: number
          truncated: boolean
          relativePath: string
        } | null
        error?: string
      }>
      getFileContent: (repoPath: string, relativePath: string) => Promise<{
        success: boolean
        data?: {
          content: string
          relativePath: string
          truncated: boolean
          lines: number
          sizeBytes: number
        } | null
        error?: string
      }>
      openInVSCode: (repoPath: string, elementId: string) => Promise<{
        success: boolean
        usedFallback?: boolean
        error?: string
      }>
      verifyIntegrity: (repoPath: string, options?: { autoRepair?: boolean; selectedIssues?: string[]; issues?: import('../../shared/types').IntegrityIssue[] }) => Promise<{
        success: boolean
        data?: import('../../shared/types').IntegrityCheckResult
        error?: string
      }>
      generateScope: (repoPath: string, anchorFileId: string) => Promise<{
        success: boolean
        markdown?: string
        fileName?: string
        error?: string
      }>
      generateCompressedScope: (repoPath: string, anchorFileId: string) => Promise<{
        success: boolean
        markdown?: string
        fileName?: string
        error?: string
      }>
      onCodeMapFileModified: (callback: (data: { repoPath: string; relativePath: string }) => void) => () => void
      onCodeMapFileConfirmed: (callback: (data: { repoPath: string; relativePath: string }) => void) => () => void
      onCodeMapFileIndexed: (callback: (data: { repoPath: string; relativePath: string }) => void) => () => void

      // ─── Code Dash ───────────────────────────────────────────────────
      dashParseAndResolve: (
        input: string,
        repoPath: string
      ) => Promise<{
        success: boolean
        data?: DashResolutionReport
        error?: string
      }>

      dashDiscover: (
        request: import('../../shared/types/repo-discovery-types').RepoDiscoveryRequest,
        repoPath: string
      ) => Promise<{
        success: boolean
        data?: import('../../shared/types/repo-discovery-types').RepoDiscoveryResult
        error?: string
      }>

      dashGenerate: (
        input: string,
        repoPath: string,
        settings?: DashSettings
      ) => Promise<{
        success: boolean
        data?: DashExecutionResult
        error?: string
      }>

      dashOneClickXml: (
        repoPath: string,
        options?: {
          removeComments?: boolean
          removeEmptyLines?: boolean
          truncateBase64?: boolean
          persistedSettings?: DashSettings
        }
      ) => Promise<{
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
      }>
    }
  }
}
