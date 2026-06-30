/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir os tipos compartilhados entre o processo principal e o renderer do Electron.
2. Declarar tipos do sistema de classificação de importância arquitetural de arquivos.
3. Declarar os tipos do sistema de checkpoints para persistência de snapshots de código.
4. Declarar os tipos do sistema de diff de checkpoints (CheckpointHunk, CheckpointDiffFile).

Mapa de Relacionamentos do Script

1. settings-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome os tipos AppSettings, RepoImportanceData e FileImportance para persistir classificações.
   - Criticidade: Alta

2. importance-fingerprint.ts
   - Tipo: Dependência Direta
   - Relação: Consome o tipo RepoImportanceData para estrutura de dados do fingerprint.
   - Criticidade: Alta

3. checkpoint-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome os tipos CheckpointData, CheckpointFileEntry e CheckpointSummary para persistir checkpoints.
   - Criticidade: Alta

Invariantes do Script

1. Novos campos opcionais em AppSettings nunca devem quebrar a leitura de settings.json existentes.
2. Todos os tipos de importância devem ser exportados para uso em outros módulos.
3. Todos os tipos de checkpoint devem ser exportados para uso em preload.ts e vite-env.d.ts.

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

// ─── Checkpoints ────────────────────────────────────────────────────────────

export interface CheckpointFileEntry {
  content: string
  hash: string
  size: number
}

export interface CheckpointData {
  id: string
  name: string
  createdAt: string
  snapshotStrategy: 'all' | 'critical-high'
  files: Record<string, CheckpointFileEntry>
}

export interface CheckpointSummary {
  id: string
  name: string
  createdAt: string
  fileCount: number
}

// ─── Checkpoint Diff ──────────────────────────────────────────────────────

export interface CheckpointHunk {
  oldStart: number    // Linha inicial no conteúdo antigo (1-indexed)
  oldLines: number    // Quantidade de linhas no conteúdo antigo
  newStart: number    // Linha inicial no conteúdo novo (1-indexed)
  newLines: number    // Quantidade de linhas no conteúdo novo
  removedLines: string[]  // Linhas removidas (sem quebra de linha no final)
  addedLines: string[]    // Linhas adicionadas (sem quebra de linha no final)
}

export interface CheckpointDiffFile {
  relativePath: string
  changeType: 'modified' | 'added' | 'deleted'
  hunks: CheckpointHunk[]
  oldContent?: string  // Presente apenas para 'deleted'
  newContent?: string  // Presente apenas para 'added'
  importance?: 'critical' | 'high' | 'medium' | 'low'  // Nível de importância arquitetural
  mtime?: number  // Timestamp de modificação para ordenação
}
