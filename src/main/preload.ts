// Responsabilidades do Script
//
// 1. Expor APIs seguras e limitadas do processo principal para o renderer usando contextBridge.
// 2. Garantir isolamento de contexto impedindo o acesso direto a módulos do Node.js pela interface.

import { contextBridge, ipcRenderer } from 'electron'
import { AppSettings, CodefetchResult } from '../shared/types'

contextBridge.exposeInMainWorld('codeAwareness', {
  checkCodefetch: (): Promise<boolean> => {
    return ipcRenderer.invoke('check-codefetch')
  },
  runCodefetch: (repoPath: string): Promise<CodefetchResult> => {
    return ipcRenderer.invoke('run-codefetch', repoPath)
  },
  saveMarkdown: (markdown: string, repoName: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-markdown', markdown, repoName)
  },
  saveToObsidian: (
    markdown: string,
    repoName: string,
    vaultPath: string
  ): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-to-obsidian', markdown, repoName, vaultPath)
  },
  loadSettings: (): Promise<AppSettings> => {
    return ipcRenderer.invoke('load-settings')
  },
  saveSettings: (settings: AppSettings): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('save-settings', settings)
  },
  selectVaultFolder: (): Promise<string | null> => {
    return ipcRenderer.invoke('select-vault-folder')
  }
})
