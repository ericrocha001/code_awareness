/*
-T ---
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
  fileViewColumnWidths?: Partial<
    Record<'toggle' | 'identity' | 'path' | 'tags' | 'tokens' | 'actions', number>
  >
}

export interface AppSettings {
  ngrokDomain?: string
  remoteAccessEnabled?: boolean
  transportKind?: 'relay' | 'ngrok'
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
  // Compression Profile persistido (opcional — ausente usa defaults)
  compressionSettings?: CompressionSettings
  // Code Source persistido (opcional — ausente usa defaults)
  sourceSettings?: SourceSettings
  // Configurações do Code Dash persistidas (opcional — ausente usa defaults)
  dashSettings?: DashSettings
}

// ─── Projetos e Diff ────────────────────────────────────────────────────────

export interface ProjectInfo {
  path: string
  name: string
  isGit: boolean
}

export * from './types/repository-catalog-types'
export * from './types/github-types'

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
  actionType: 'checkpoint_created' | 'checkpoint_restored' | 'checkpoint_deleted' | 'checkpoint_renamed' | 'all_checkpoints_deleted' | 'checkpoint_marked_restored' | 'checkpoint_cleanup' | 'checkpoint_unmarked' | 'restore_rollback'
  timestamp: number
  checkpointId?: string
  checkpointName?: string
  details?: string
  repoPath: string
  operationId?: string
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

export interface RestoreFileChange {
  relativePath: string
  status: 'modified' | 'created' | 'unchanged' | 'blocked'
  addedLines: number | null
  removedLines: number | null
  reason?: string
}

export interface RestorePlan {
  targetCheckpointId: string
  targetCheckpointName: string
  repoPath: string
  filesToWrite: string[]
  orphanFiles: OrphanFile[]
  currentRestorePoint: { id: string; name: string } | null
  canRestore: string[]
  cannotRestore: Array<{ path: string; reason: string }>
  fileChanges: RestoreFileChange[]
  stateHash: string
  createdAt: number
}

export interface RestorePreviewResult {
  plan: RestorePlan
}

export interface RestoreExecuteOptions {
  createSafety: boolean
  cleanupFiles: string[]
  plan?: RestorePlan
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
  rollbackAttempted?: boolean
  rollbackSuccess?: boolean
  markFailed?: boolean
  planStale?: boolean
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

// ─── Code Map / Repository Model ──────────────────────────────────────────

export type CodeMapFileStatus = 'indexed' | 'modified'

export type CodeMapElementKind = 'class' | 'function' | 'method' | 'interface' | 'enum' | 'typeAlias' | 'variable' | 'constant' | 'import' | 'export' | 'property' | 'parameter' | 'enumMember' | 'cssRule' | 'cssAtRule' | 'cssCustomProperty' | 'document' | 'section'

export type CodeMapElementVisibility = 'public' | 'private' | 'protected' | null

/**
 * Granularidade semântica do elemento.
 * - 'structural': unidades atômicas recuperáveis (classes, funções, métodos, etc.)
 * - 'member': membros de classe (propriedades, campos) - Sprint 3
 * - 'syntax': elementos de navegação/relação (imports, exports) - não recuperáveis
 */
export type CodeMapGranularity = 'structural' | 'member' | 'syntax'

/** @deprecated Use 'CodeMapGranularity' em vez deste tipo */
export type CodeMapRetrievalKind = 'A' | 'B' | 'C' | null

export type CodeMapRelationshipType = 'contains' | 'extends' | 'implements' | 'imports' | 'exports'

export interface CodeMapPosition {
  line: number // 1-indexed
  column: number // 0-indexed
  byte: number // offset em bytes a partir do início do arquivo
}

export interface CodeMapElementLocation {
  start: CodeMapPosition
  end: CodeMapPosition
}

export interface CodeMapElement {
  id: string
  repositoryId: string
  fileId: string
  kind: CodeMapElementKind
  name: string
  parentElementId: string | null
  location: CodeMapElementLocation
  sizeLines: number
  sizeBytes: number
  visibility: CodeMapElementVisibility
  modifiers: string[]
  returnType: string | null
  baseClass: string | null
  hasDocumentation: boolean
  parameterCount: number
  declarationSignature?: string | null
  /** @deprecated Use 'granularity' e 'retrievable' em vez deste campo */
  retrievalKind?: CodeMapRetrievalKind
  /** Granularidade semântica do elemento */
  granularity: CodeMapGranularity
  /** Se true, o elemento pode ser recuperado exatamente via getElementExactSource */
  retrievable: boolean
}

export interface CodeMapFile {
  id: string
  repositoryId: string
  contextReference?: string | null
  relativePath: string
  language: string
  extension: string
  lines: number
  sizeBytes: number
  mtime: number
  contentHash?: string | null
  tokenCount?: number | null
  tokenizerId?: string | null
  tokenizerEncoding?: string | null
  tokenizedContentHash?: string | null
  status: CodeMapFileStatus
}

export interface CodeMapRepository {
  id: string
  path: string
  name: string
  modelVersion: number
  lastIndexedAt: string | null
}

/**
 * Kind de endpoint de uma relação.
 * - 'element': o ID refere-se a um elemento estrutural (CodeMapElement).
 * - 'file': o ID refere-se a um arquivo (CodeMapFile).
 *
 * Tabela de endpoints por tipo (contrato congelado):
 * - contains / extends / implements / exports → element → element
 * - imports TS/JS → element → file
 * - imports CSS → file → file
 */
export type CodeMapEndpointKind = 'element' | 'file'

export interface CodeMapRelationship {
  id: string
  repositoryId: string
  sourceId: string
  targetId: string
  type: CodeMapRelationshipType
  /** Kind do endpoint source — 'element' ou 'file' */
  sourceKind: CodeMapEndpointKind
  /** Kind do endpoint target — 'element' ou 'file' */
  targetKind: CodeMapEndpointKind
}

export interface CodeMapSyncStatus {
  totalFiles: number
  indexedFiles: number
  modifiedFiles: number
  totalElements: number
  lastSyncAt: string | null
}


// ─── Integrity Check ──────────────────────────────────────────────────────
export interface IntegrityCheckResult {
  /** Status geral: 'healthy' (sem inconsistências), 'inconsistent' (há problemas), 'unknown' (erro na verificação) */
  status: 'healthy' | 'inconsistent' | 'unknown'
  
  /** Arquivos verificados */
  filesChecked: number
  
  /** Hashes verificados (arquivos com contentHash não-nulo) */
  hashesChecked: number
  
  /** Hashes divergentes (disco ≠ índice) */
  hashesMismatched: number
  
  /** Arquivos ausentes no disco mas presentes no índice */
  filesMissing: number
  
  /** Arquivos inesperados no disco mas ausentes no índice */
  filesUnexpected: number
  
  /** Elementos órfãos (elementos sem arquivo pai válido) */
  orphanElements: number
  
  /** Relacionamentos inválidos (source ou target inexistente) */
  invalidRelationships: number
  
  /** Inconsistências de banco (duplicatas, violações de FK) */
  databaseInconsistencies: number
  
  /** Detalhes das inconsistências encontradas (limitado a 100 para não sobrecarregar) */
  details: IntegrityIssue[]
  
  /** Duração total da verificação em milissegundos */
  durationMs: number

  /** Número de arquivos com status modified obsoleto curados para indexed na Fase 0 */
  staleHealed?: number

  /** Se foi executada reparação, resultado da revalidação */
  repairResult?: IntegrityRepairResult
}

export interface IntegrityIssue {
  id?: string
  type: 'hash_mismatch' | 'file_missing' | 'file_unexpected' | 'orphan_element' | 'invalid_relationship' | 'database_inconsistency'
  severity: 'error' | 'warning'
  description: string
  /** Caminho relativo ou ID do elemento/relacionamento afetado */
  target: string
}

// ─── Integrity Check UI ────────────────────────────────────────────────────

export interface IntegrityCheckOptions {
  /** Se true, executa reparação automática após a descoberta. */
  autoRepair?: boolean
  /** Issues já descobertas pelo frontend — quando fornecidas (e válidas), o backend pula a fase de descoberta. */
  issues?: IntegrityIssue[]
  /** IDs de issues para reparação cirúrgica (defesa em profundidade no backend). */
  selectedIssues?: string[]
  /** Se false, pula a varredura do disco para arquivos inesperados. */
  scanForUnexpectedFiles?: boolean
  /** Se true, auditoria profunda/autoritativa: hasheia todo arquivo indexado, ignorando o atalho mtime/size. */
  deep?: boolean
  /** Correlation ID opcional de uma operação já iniciada. */
  correlationId?: string
}

export interface IntegrityIssueUI extends IntegrityIssue {
  selected: boolean
}

export interface IntegrityCheckModalState {
  isOpen: boolean
  issues: IntegrityIssueUI[]
  isRepairing: boolean
}

export interface IntegrityRepairResult {
  /** Status da reparação: 'success' (todas corrigidas), 'partial' (algumas corrigidas), 'failed' (nenhuma corrigida) */
  status: 'success' | 'partial' | 'failed'
  
  /** Inconsistências corrigidas */
  issuesFixed: number
  
  /** Inconsistências que não puderam ser corrigidas */
  issuesRemaining: number
  
  /** Detalhes das correções aplicadas */
  repairs: IntegrityRepair[]
  
  /** Duração da reparação em milissegundos */
  durationMs: number
  
  /** Resultado da revalidação pós-reparação */
  revalidation: Pick<IntegrityCheckResult, 'status' | 'filesChecked' | 'hashesMismatched' | 'orphanElements' | 'invalidRelationships'>
}

export interface IntegrityRepair {
  type: 'reindex_file' | 'delete_orphan_element' | 'delete_invalid_relationship' | 'index_unexpected_file'
  description: string
  target: string
  success: boolean
  error?: string
}

// ─── Integrity Check Report ────────────────────────────────────────────────

export interface IntegrityReportInput {
  projectName: string
  repoPath: string
  checkResult: IntegrityCheckResult
  repairResult?: IntegrityRepairResult
  generatedAt: string
}

// ─── Compression Profile ─────────────────────────────────────────────────────

/** Formato de entrega da CLI do Repomix (mecanismo de transporte do resultado). */
export type OutputFormat = 'plain' | 'markdown' | 'xml' | 'json'

/**
 * Perfil efetivo de compressão. Representa a TRANSFORMAÇÃO do conteúdo.
 * `--compress` não é um campo — é sempre aplicado pelo builder.
 * `profileHash` é derivado deste objeto (sem outputFormat).
 */
export interface CompressionProfile {
  // Compression
  removeComments: boolean
  removeEmptyLines: boolean
  truncateBase64: boolean
  // Representation
  showLineNumbers: boolean
  parsableStyle: boolean
  outputFilePathStyle: 'target-relative' | 'cwd-relative'
  // Structure
  includeFileSummary: boolean
  includeDirectoryStructure: boolean
  includeEmptyDirectories: boolean
  includeFullDirectoryStructure: boolean
  // Metadata
  version: number
}

/** Unidade semântica persistida em settings.json: perfil + formato de transporte. */
export interface CompressionSettings {
  profile: CompressionProfile
  outputFormat: OutputFormat
  /** Enriquecimento opcional aplicado na montagem final do documento (fora do cache por arquivo). */
  enrichment?: ContextEnrichment
}

/**
 * Payload transitável via IPC para a geração de compressão. Diferente de CompressionSettings
 * (persistência), todos os campos são opcionais: o renderer pode enviar configurações parciais
 * ou omitir o campo inteiro, fazendo o serviço usar seus defaults (retrocompatibilidade).
 */
export interface CompressionSettingsPayload {
  profile?: CompressionProfile
  outputFormat?: OutputFormat
  enrichment?: ContextEnrichment
}

/**
 * Context Enrichment — enriquecimento aplicado pelo CompressionService na
 * montagem final do Markdown, NUNCA via Repomix e NUNCA afetando o cache por
 * arquivo. Todos os campos são opcionais; ausente = documento sem enriquecimento.
 */
export interface ContextEnrichment {
  /** Texto do header inserido no início do documento. Máximo 16384 caracteres (16KB). */
  headerText?: string
  /** Caminho relativo ao repositório do arquivo de instruções (nunca absoluto). */
  instructionFilePath?: string
  /** Se true, inclui diffs do working tree na montagem final. */
  includeDiffs?: boolean
  /** Se true, inclui logs do Git na montagem final. */
  includeLogs?: boolean
  /** Número máximo de commits nos logs (≥1 e ≤100, default 10). */
  includeLogsCount?: number
}

// ─── Code Source ─────────────────────────────────────────────────────────────

/**
 * Formato de entrega do Code Source. Contrato próprio, semanticamente separado
 * de OutputFormat (Code Compression): o Code Source suporta apenas Markdown e XML.
 */
export type SourceOutputFormat = 'markdown' | 'xml'

/**
 * Perfil do Code Source — contrato próprio, independente de CompressionProfile.
 * Representa as opções passadas à CLI do Repomix; NUNCA inclui compressão estrutural.
 */
export interface SourceProfile {
  // Limpeza
  removeComments: boolean
  removeEmptyLines: boolean
  truncateBase64: boolean
  // Apresentação
  showLineNumbers: boolean
  parsableStyle: boolean
  // Estrutura
  includeFileSummary: boolean
  includeDirectoryStructure: boolean
  includeEmptyDirectories: boolean
  includeFullDirectoryStructure: boolean
  // Metadata
  version: number
}

/** Unidade semântica persistida em settings.json para o Code Source: perfil + formato. */
export interface SourceSettings {
  profile: SourceProfile
  outputFormat: SourceOutputFormat
}

/**
 * Payload transitável via IPC para o Code Source. Todos os campos são opcionais:
 * o renderer pode enviar configurações parciais ou omitir o campo inteiro,
 * fazendo o serviço usar seus defaults (retrocompatibilidade).
 */
export interface SourceSettingsPayload {
  profile?: SourceProfile
  outputFormat?: SourceOutputFormat
}

/** Documento gerado pelo Code Source, encapsulando conteúdo, tokens e id da geração. */
export interface GeneratedDocument {
  content: string
  tokenCount: number
  generationId: number
}

/**
 * Requisição de geração identificada pelo Renderer, com sessionKey para coordenação
 * de auto-cancelamento e generationId para proteção contra race conditions.
 */
export interface SourceGenerationRequest {
  repoPath: string
  selectedFiles: string[]
  format?: SourceOutputFormat
  profile?: SourceProfile
  generationId: number
  sessionKey: string
}

// ─── Code Dash ───────────────────────────────────────────────────────────────

/**
 * Configurações de economia do Code Dash, persistidas em settings.json.
 * Aplicadas como merge global nos providers Source e Compression, sobrescrevendo
 * apenas os três campos econômicos do profile efetivo de cada item.
 */
export interface DashSettings {
  removeComments: boolean
  removeEmptyLines: boolean
  truncateBase64: boolean
}

export * from './types/dash-types'

