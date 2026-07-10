/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Declarar a interface global do objeto codeAwareness no escopo do objeto Window do browser.
2. Prover suporte a tipos adicionais do ambiente do Vite para o processo renderer.

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

import { AppSettings, CheckpointData, CheckpointDiffFile, CheckpointSummary, CodefetchResult, DiffFileStatus, FileImportance, ImportanceLevel, ProjectInfo, RestoreValidation } from '../../shared/types'

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
      addIgnoredFile: (repoPath: string, relativePath: string, type: 'temporary' | 'persistent') => Promise<AppSettings | null>
      removeIgnoredFile: (repoPath: string, relativePath: string, type: 'temporary' | 'persistent') => Promise<AppSettings | null>
      reconcileIgnoredFiles: (repoPath: string, currentModifiedFiles: string[]) => Promise<AppSettings | null>
      checkCodeSourceInstallation: () => Promise<boolean>
      generateCodeSource: (
        repoPath: string,
        options?: { selectedFiles?: string[]; format?: 'markdown' | 'xml' }
      ) => Promise<CodefetchResult & { tokenCount?: number }>

      // ─── Importância Arquitetural ─────────────────────────────────
      classifyImportance: (
        repoPath: string,
        repoName: string,
        files: { relativePath: string }[]
      ) => Promise<{ success: boolean; data?: Record<string, FileImportance>; error?: string }>

      setImportanceOverride: (
        repoPath: string,
        repoName: string,
        relativePath: string,
        level: ImportanceLevel
      ) => Promise<{ success: boolean; data?: Record<string, FileImportance>; error?: string }>

      revealInExplorer: (repoPath: string, relativePath: string) => Promise<boolean>

      onImportanceUpdated: (
        callback: (data: {
          repoPath: string
          relativePath: string
          level: string
          source: string
        }) => void
      ) => Electron.IpcRenderer

      removeImportanceUpdatedListener: () => void

      // ─── Checkpoints ─────────────────────────────────────────────────
      createCheckpoint: (
        repoPath: string,
        name: string,
        strategy: 'all' | 'critical-high'
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

      deleteAllCheckpoints: (
        repoPath: string
      ) => Promise<{ success: boolean; deletedCount: number; error?: string }>

      generateCheckpointDiff: (
        repoPath: string,
        fromCheckpointId: string,
        toCheckpointId: string
      ) => Promise<{ success: boolean; data?: string; error?: string }>

      validateRestore: (
        repoPath: string,
        checkpointId: string
      ) => Promise<{ success: boolean; data?: RestoreValidation; error?: string }>

      restoreCheckpoint: (
        repoPath: string,
        checkpointId: string
      ) => Promise<{ success: boolean; data?: { restored: number; failed: number; errors: string[] }; error?: string }>

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

    }
  }
}