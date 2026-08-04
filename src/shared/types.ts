/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir os tipos compartilhados entre o processo principal e o renderer do Electron.
2. Declarar os tipos do sistema de checkpoints para persistência de snapshots de código.
3. Declarar os tipos do sistema de diff de checkpoints (CheckpointHunk, CheckpointDiffFile).

Mapa de Relacionamentos do Script

1. settings-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome o tipo AppSettings para persistir configurações.
   - Criticidade: Alta

2. checkpoint-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome os tipos CheckpointData, CheckpointFileEntry e CheckpointSummary para persistir checkpoints.
   - Criticidade: Alta

Invariantes do Script

1. Novos campos opcionais em AppSettings nunca devem quebrar a leitura de settings.json existentes.
2. Todos os tipos de checkpoint devem ser exportados para uso em preload.ts e vite-env.d.ts.

--- FIM ARQUITETURA DO SCRIPT ---
*/

// ─── Tags Manuais ───────────────────────────────────────────────────────────

export interface Tag {
  id: string
  name: string
  color: string
}

// ─── Configurações do App ───────────────────────────────────────────────────

export interface ProjectPreferences {
  sidebarOpen: boolean
}

export interface AppSettings {
  rootFolders: string[]
  individualProjects: string[]
  hiddenProjects: string[]
  // Chave = repoPath, valor = lista de arquivos/padrões ignorados
  ignoredDiffFiles: Record<string, string[]>
  // Chave = repoPath, valor = lista de tags do projeto
  tags: Record<string, Tag[]>
  // Chave = repoPath, valor = mapa de relativePath para array de tagIds
  fileTags: Record<string, Record<string, string[]>>
  // Chave = repoPath, valor = preferências de UI por projeto
  projectPreferences: Record<string, ProjectPreferences>
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

export interface CheckpointDetails {
  instructions?: string
  agentSummary?: string
}

export type CheckpointStatus = 'active' | 'restored' | 'reverted'

export interface CheckpointData {
  id: string
  name: string
  createdAt: string
  files: Record<string, CheckpointFileEntry>
  instructions?: string
  agentSummary?: string
  restoredAt?: string | null
}

export interface CheckpointSummary {
  id: string
  name: string
  createdAt: string
  fileCount: number
  restoredAt: string | null
  instructions?: string
  agentSummary?: string
  hasContent: boolean
  campaignIds?: string[]
}

export interface CheckpointCatalogRecord {
  id: string
  name: string
  createdAt: string
  instructions: string | null
  agentSummary: string | null
  restoredAt: string | null
  fileCount: number
  hasContent: boolean
  repoPath: string
}

// ─── Banco de Dados (Code Checkpoints) ──────────────────────────────────────

export interface ActionLog {
  id: string
  actionType: 'checkpoint_created' | 'checkpoint_restored' | 'checkpoint_deleted' | 'checkpoint_renamed' | 'all_checkpoints_deleted' | 'checkpoint_marked_restored' | 'checkpoint_cleanup' | 'checkpoint_unmarked'
  timestamp: number
  checkpointId?: string
  checkpointName?: string
  details?: string
  repoPath: string
}

export interface SprintData {
  id: string
  name: string
  objective: string
  instructions: string
  createdAt: number
  updatedAt: number
  status: 'planned' | 'in_progress' | 'completed' | 'archived'
  repoPath: string
}

// ─── Restauração ──────────────────────────────────────────────────────────

export interface OrphanFile {
  relativePath: string
  originCheckpointId: string
  originCheckpointName: string
}

export interface RestorePreviewResult {
  canRestore: string[]
  cannotRestore: Array<{ path: string; reason: string }>
  orphanFiles: OrphanFile[]
  currentRestorePoint: { id: string; name: string } | null
}

export interface RestoreExecuteOptions {
  createSafety: boolean
  cleanupFiles: string[]
}

export interface CleanupResult {
  removed: number
  errors: string[]
}

export interface RestoreExecuteResult {
  restored: number
  failed: number
  errors: string[]
  partial: boolean
  safetyBackupId?: string
  cleanup?: CleanupResult
}

// ─── Code Campaign ────────────────────────────────────────────────────────────

export type CampaignStatus = 'active' | 'completed'

export interface Campaign {
  id: string
  slug: string
  name: string
  description: string
  status: CampaignStatus
  createdAt: string
  updatedAt: string
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
  mtime?: number  // Timestamp de modificação para ordenação
}
