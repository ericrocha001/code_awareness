// Responsabilidades do Script
//
// 1. Declarar a interface global do objeto codeAwareness no escopo do objeto Window do browser.
// 2. Prover suporte a tipos adicionais do ambiente do Vite para o processo renderer.

/// <reference types="vite/client" />

import { AppSettings, CodefetchResult, DiffFileStatus, ProjectInfo } from '../../shared/types'

declare global {
  interface Window {
    codeAwareness: {
      checkCodefetch: () => Promise<boolean>
      runCodefetch: (repoPath: string) => Promise<CodefetchResult>
      saveMarkdown: (markdown: string, repoName: string) => Promise<{ success: boolean; error?: string }>
      saveToObsidian: (
        markdown: string,
        repoName: string,
        vaultPath: string
      ) => Promise<{ success: boolean; error?: string }>
      loadSettings: () => Promise<AppSettings>
      saveSettings: (settings: AppSettings) => Promise<{ success: boolean }>
      selectVaultFolder: () => Promise<string | null>
      selectFolder: () => Promise<{ path: string; name: string } | null>
      getPathForFile: (file: File) => string
      checkRepository: (dirPath: string) => Promise<boolean>
      getModifiedFiles: (dirPath: string) => Promise<DiffFileStatus[]>
      startWatcher: (dirPath: string) => Promise<{ success: boolean }>
      stopWatcher: () => Promise<{ success: boolean }>
      onFileChanged: (callback: (filePath: string) => void) => () => void
      generateSemanticDiff: (repoPath: string, selectedFiles?: string[]) => Promise<string>
      getAllTrackedFiles: (dirPath: string) => Promise<DiffFileStatus[]>
      generateCompressionMarkdown: (repoPath: string, selectedFiles: string[]) => Promise<string>
      addRootFolder: () => Promise<ProjectInfo[]>
      addIndividualProject: () => Promise<ProjectInfo[]>
      getProjectsList: () => Promise<ProjectInfo[]>
      hideProject: (projectPath: string) => Promise<ProjectInfo[]>
      addIgnoredFile: (repoPath: string, relativePath: string, type: 'temporary' | 'persistent') => Promise<AppSettings | null>
      removeIgnoredFile: (repoPath: string, relativePath: string, type: 'temporary' | 'persistent') => Promise<AppSettings | null>
      reconcileIgnoredFiles: (repoPath: string, currentModifiedFiles: string[]) => Promise<AppSettings | null>
    }
  }
}
