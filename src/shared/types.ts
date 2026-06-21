// Responsabilidades do Script
//
// 1. Definir os tipos compartilhados entre o processo principal e o renderer do Electron.
// 2. Declarar as interfaces de domínio do fluxo de monitoramento Git e de arquivos modificados.

export interface AppSettings {
  obsidianVaultPath: string | null
  rootFolders: string[]
  individualProjects: string[]
  hiddenProjects: string[]
}

export interface ProjectInfo {
  path: string
  name: string
  isGit: boolean
}

export interface CodefetchResult {
  success: boolean
  markdown?: string
  error?: string
}

export interface DiffFileStatus {
  relativePath: string
  name: string
  changeType: 'modified' | 'added' | 'deleted'
}

export type WatcherState = 'active' | 'inactive' | 'error'
