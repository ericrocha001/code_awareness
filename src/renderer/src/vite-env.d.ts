/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Declarar a interface global do objeto codeAwareness no escopo do objeto Window do browser.
2. Prover suporte a tipos adicionais do ambiente do Vite para o processo renderer.
3. Tipar as APIs de deep link (getPendingDeepLink e onDeepLink) expostas pelo preload.

Mapa de Relacionamentos do Script

1. preload.ts
   - Tipo: Contrato / Interface
   - Relação: Define a tipagem do objeto codeAwareness injetado por preload.ts.
   - Criticidade: Alta

Invariantes do Script

1. Os métodos declarados em Window.codeAwareness devem corresponder exatamente à interface exposta em preload.ts.

--- FIM ARQUITETURA DO SCRIPT ---
*/

/// <reference types="vite/client" />

import { ActionLog, AppSettings, Campaign, CampaignStatus, CheckpointData, CheckpointDetails, CheckpointDiffFile, CheckpointSummary, CodefetchResult, DiffFileStatus, OrphanFile, ProjectInfo, RestoreExecuteOptions, RestoreExecuteResult, RestorePreviewResult, Tag } from '../../shared/types'

declare global {
  interface Window {
    codeAwareness: {
      saveMarkdown: (markdown: string, repoName: string) => Promise<{ success: boolean; error?: string }>
      saveXml: (xml: string, repoName: string) => Promise<{ success: boolean; error?: string }>
      saveToDownloads: (markdown: string, fileName: string) => Promise<{ success: boolean; filePath?: string; error?: string }>
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
      generateCompressionMarkdown: (repoPath: string, selectedFiles: string[]) => Promise<string>
      addRootFolder: () => Promise<ProjectInfo[]>
      addIndividualProject: () => Promise<ProjectInfo[]>
      getProjectsList: () => Promise<ProjectInfo[]>
      hideProject: (projectPath: string) => Promise<ProjectInfo[]>
      addIgnoredFile: (repoPath: string, relativePath: string) => Promise<AppSettings | null>
      removeIgnoredFile: (repoPath: string, relativePath: string) => Promise<AppSettings | null>
      reconcileIgnoredFiles: (repoPath: string, currentModifiedFiles: string[]) => Promise<AppSettings | null>
      checkCodeSourceInstallation: () => Promise<boolean>
      generateCodeSource: (
        repoPath: string,
        options?: { selectedFiles?: string[]; format?: 'markdown' | 'xml' }
      ) => Promise<CodefetchResult & { tokenCount?: number }>


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

    }
  }
}