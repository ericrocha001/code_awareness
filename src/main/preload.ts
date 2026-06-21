// Responsabilidades do Script
//
// 1. Expor APIs seguras e limitadas do processo principal para o renderer usando contextBridge.
// 2. Garantir isolamento de contexto impedindo o acesso direto a módulos do Node.js pela interface.
// 3. Mapear os canais IPC do fluxo de monitoramento Git e de arquivos modificados para o renderer.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { AppSettings, CodefetchResult, DiffFileStatus, ProjectInfo } from '../shared/types'

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
  },
  selectFolder: (): Promise<{ path: string; name: string } | null> => {
    return ipcRenderer.invoke('select-folder')
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
  generateSemanticDiff: (repoPath: string): Promise<string> => {
    return ipcRenderer.invoke('git:generate-semantic-diff', repoPath)
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
  }
})
