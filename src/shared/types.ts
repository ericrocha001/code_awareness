/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir os tipos compartilhados entre o processo principal e o renderer do Electron.
2. Declarar tipos do sistema de classificação de importância arquitetural de arquivos.

Mapa de Relacionamentos do Script

1. settings-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome os tipos AppSettings, RepoImportanceData e FileImportance para persistir classificações.
   - Criticidade: Alta

2. importance-fingerprint.ts
   - Tipo: Dependência Direta
   - Relação: Consome o tipo RepoImportanceData para estrutura de dados do fingerprint.
   - Criticidade: Alta

Invariantes do Script

1. Novos campos opcionais em AppSettings nunca devem quebrar a leitura de settings.json existentes.
2. Todos os tipos de importância devem ser exportados para uso em outros módulos.

--- FIM ARQUITETURA DO SCRIPT ---
*/

// ─── Configurações do App ───────────────────────────────────────────────────

export interface AppSettings {
  rootFolders: string[]
  individualProjects: string[]
  hiddenProjects: string[]
  // Chave = repoPath, valor = listas de arquivos ignorados no diff
  ignoredDiffFiles: Record<string, { temporary: string[]; persistent: string[] }>
  // Chave = fingerprint do repositório, valor = dados de classificação
  fileImportance: Record<string, RepoImportanceData>
}

// ─── Importância Arquitetural ───────────────────────────────────────────────

export type ImportanceLevel = 'critical' | 'high' | 'medium' | 'low'

export type ImportanceSource = 'heuristic' | 'manual'

export interface FileImportance {
  level: ImportanceLevel
  source: ImportanceSource
  mtime: number
  score?: number
  tokenEstimate?: number // Estimativa de tokens (≈ 1 token = 4 chars)
}

export interface RepoImportanceData {
  repoName: string
  lastKnownPath: string
  files: Record<string, FileImportance>
}

// ─── Projetos e Diff ────────────────────────────────────────────────────────

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
  changeType: 'modified' | 'added' | 'deleted' | 'tracked'
  mtime: number
  size: number
}