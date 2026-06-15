// Responsabilidades do Script
//
// 1. Definir os tipos compartilhados entre o processo principal e o renderer do Electron.

export interface AppSettings {
  obsidianVaultPath: string | null
}

export interface CodefetchResult {
  success: boolean
  markdown?: string
  error?: string
}
