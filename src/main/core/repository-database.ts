/*
-T ---
*/

import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type {
  CodeMapElement,
  CodeMapElementKind,
  CodeMapElementVisibility,
  CodeMapEndpointKind,
  CodeMapFile,
  CodeMapFileStatus,
  CodeMapGranularity,
  CodeMapRelationship,
  CodeMapRelationshipType,
  CodeMapRepository,
  CodeMapSyncStatus
} from '../../shared/types'
import type {
  CodeMapElementRow,
  CodeMapFileRow,
  CodeMapRelationshipRow,
  CodeMapRepositoryRow,
  RepositoryRepository
} from './repository-repository'
import type { SymbolReferenceKind } from './extraction/structure-extraction-port'
import type { PersistedSymbolReference } from './symbol-reference-resolver'

// Cache de conexões abertas: chave = repoPath, valor = instância do banco
interface DatabaseConnection {
  db: BetterSqlite3Database
  repoPath: string
}

const connections = new Map<string, DatabaseConnection>()

const FILE_STATUSES: readonly CodeMapFileStatus[] = ['indexed', 'modified'] as const
const ELEMENT_KINDS: readonly CodeMapElementKind[] = ['class', 'function', 'method', 'interface', 'enum', 'typeAlias', 'variable', 'constant', 'import', 'export', 'property', 'parameter', 'enumMember', 'cssRule', 'cssAtRule', 'cssCustomProperty', 'document', 'section'] as const
const ELEMENT_VISIBILITIES: readonly Exclude<CodeMapElementVisibility, null>[] = ['public', 'private', 'protected'] as const
const RELATIONSHIP_TYPES: readonly CodeMapRelationshipType[] = ['contains', 'extends', 'implements', 'imports', 'exports'] as const
const ENDPOINT_KINDS: readonly CodeMapEndpointKind[] = ['element', 'file'] as const
const SYMBOL_REFERENCE_KINDS: readonly SymbolReferenceKind[] = ['reference', 'call', 'instantiation', 'type'] as const

// ─── Gestão de Conexões ─────────────────────────────────────────────────────

/** Retorna o caminho do arquivo do banco dentro da pasta code_awareness/ do repositório. */
function getDbPath(repoPath: string): string {
  return join(repoPath, 'code_awareness', 'repository_model.db')
}

/** Garante que a pasta code_awareness existe no repositório. */
function ensureDir(repoPath: string): void {
  const dir = join(repoPath, 'code_awareness')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/** Cria o schema completo com CREATE TABLE IF NOT EXISTS (idempotente). */
function ensureSchema(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      model_version INTEGER NOT NULL DEFAULT 1,
      last_indexed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      context_reference TEXT,
      relative_path TEXT NOT NULL,
      language TEXT NOT NULL,
      extension TEXT NOT NULL,
      lines INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      content_hash TEXT,
      token_count INTEGER,
      tokenizer_id TEXT,
      tokenizer_encoding TEXT,
      tokenized_content_hash TEXT,
      status TEXT NOT NULL DEFAULT 'modified',
      FOREIGN KEY (repository_id) REFERENCES repositories(id),
      UNIQUE(repository_id, relative_path)
    );

    CREATE TABLE IF NOT EXISTS elements (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_element_id TEXT,
      start_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      start_byte INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      end_byte INTEGER NOT NULL,
      size_lines INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      visibility TEXT,
      modifiers TEXT NOT NULL DEFAULT '[]',
      return_type TEXT,
      base_class TEXT,
      has_documentation INTEGER NOT NULL DEFAULT 0,
      parameter_count INTEGER NOT NULL DEFAULT 0,
      retrieval_kind TEXT,
      granularity TEXT NOT NULL DEFAULT 'structural',
      retrievable INTEGER NOT NULL DEFAULT 0,
      declaration_signature TEXT,
      FOREIGN KEY (repository_id) REFERENCES repositories(id),
      FOREIGN KEY (file_id) REFERENCES files(id),
      FOREIGN KEY (parent_element_id) REFERENCES elements(id)
    );

    CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL,
      FOREIGN KEY (repository_id) REFERENCES repositories(id)
    );

    CREATE TABLE IF NOT EXISTS repository_settings (
      repository_id TEXT PRIMARY KEY,
      enabled_languages TEXT NOT NULL DEFAULT '["typescript"]',
      ignored_patterns TEXT NOT NULL DEFAULT '[]',
      max_file_size_bytes INTEGER NOT NULL DEFAULT 2097152,
      last_sync_at TEXT,
      gitignore_hash TEXT,
      FOREIGN KEY (repository_id) REFERENCES repositories(id)
    );

    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL DEFAULT 1,
      model_version INTEGER NOT NULL DEFAULT 1,
      parser_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS retired_context_references (
      repository_id TEXT NOT NULL,
      context_reference TEXT NOT NULL,
      retired_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, context_reference)
    );

    CREATE TABLE IF NOT EXISTS context_reference_counters (
      repository_id TEXT PRIMARY KEY,
      next_value INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS element_parameters (
      element_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      FOREIGN KEY (element_id) REFERENCES elements(id),
      PRIMARY KEY (element_id, position)
    );

    CREATE TABLE IF NOT EXISTS element_interfaces (
      element_id TEXT NOT NULL,
      interface_name TEXT NOT NULL,
      FOREIGN KEY (element_id) REFERENCES elements(id),
      PRIMARY KEY (element_id, interface_name)
    );

    CREATE TABLE IF NOT EXISTS element_decorators (
      element_id TEXT NOT NULL,
      decorator_name TEXT NOT NULL,
      FOREIGN KEY (element_id) REFERENCES elements(id),
      PRIMARY KEY (element_id, decorator_name)
    );

    CREATE TABLE IF NOT EXISTS element_type_parameters (
      element_id TEXT NOT NULL,
      name TEXT NOT NULL,
      constraint_text TEXT,
      FOREIGN KEY (element_id) REFERENCES elements(id),
      PRIMARY KEY (element_id, name)
    );

    CREATE TABLE IF NOT EXISTS symbol_references (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      source_file_id TEXT NOT NULL,
      source_element_id TEXT,
      target_element_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      column INTEGER NOT NULL,
      start_byte INTEGER NOT NULL,
      end_byte INTEGER NOT NULL,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
      FOREIGN KEY (source_file_id) REFERENCES files(id) ON DELETE CASCADE,
      FOREIGN KEY (source_element_id) REFERENCES elements(id) ON DELETE CASCADE,
      FOREIGN KEY (target_element_id) REFERENCES elements(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_files_repository_id ON files(repository_id);
    CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
    CREATE INDEX IF NOT EXISTS idx_elements_file_id ON elements(file_id);
    CREATE INDEX IF NOT EXISTS idx_elements_repository_id ON elements(repository_id);
    CREATE INDEX IF NOT EXISTS idx_elements_parent ON elements(parent_element_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_repository_id ON relationships(repository_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);
    CREATE INDEX IF NOT EXISTS idx_symbol_references_target ON symbol_references(target_element_id);
    CREATE INDEX IF NOT EXISTS idx_symbol_references_source_element ON symbol_references(source_element_id);
    CREATE INDEX IF NOT EXISTS idx_symbol_references_source_file ON symbol_references(source_file_id);

    INSERT OR IGNORE INTO schema_versions (id, schema_version, model_version, parser_version, created_at, updated_at)
    VALUES (1, 1, 1, NULL, datetime('now'), datetime('now'));
  `)

  // Migração idempotente: adicionar content_hash apenas se a coluna ainda não existir.
  // PRAGMA table_info é preferível a try/catch pois evita o overhead de tentar ALTER e capturar erro.
  const fileColumns = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>
  const hasContentHash = fileColumns.some(col => col.name === 'content_hash')
  if (!hasContentHash) {
    db.exec('ALTER TABLE files ADD COLUMN content_hash TEXT')
  }
  if (!fileColumns.some((column) => column.name === 'context_reference')) {
    db.exec('ALTER TABLE files ADD COLUMN context_reference TEXT')
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_files_context_reference ON files(repository_id, context_reference) WHERE context_reference IS NOT NULL')
  const tokenColumns: Array<[string, string]> = [
    ['token_count', 'INTEGER'],
    ['tokenizer_id', 'TEXT'],
    ['tokenizer_encoding', 'TEXT'],
    ['tokenized_content_hash', 'TEXT']
  ]
  for (const [name, type] of tokenColumns) {
    if (!fileColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE files ADD COLUMN ${name} ${type}`)
    }
  }

  // Migração idempotente: adicionar retrieval_kind na tabela elements apenas se ainda não existir.
  const elementColumns = db.prepare('PRAGMA table_info(elements)').all() as Array<{ name: string }>
  const hasRetrievalKind = elementColumns.some(col => col.name === 'retrieval_kind')
  if (!hasRetrievalKind) {
    db.exec('ALTER TABLE elements ADD COLUMN retrieval_kind TEXT')
  }

  // Migração idempotente: adicionar granularity e retrievable na tabela elements.
  const hasGranularity = elementColumns.some(col => col.name === 'granularity')
  if (!hasGranularity) {
    db.exec('ALTER TABLE elements ADD COLUMN granularity TEXT NOT NULL DEFAULT \'structural\'')
  }
  const hasRetrievable = elementColumns.some(col => col.name === 'retrievable')
  if (!hasRetrievable) {
    db.exec('ALTER TABLE elements ADD COLUMN retrievable INTEGER NOT NULL DEFAULT 0')
  }

  if (!hasGranularity || !hasRetrievable) {
    db.exec('UPDATE elements SET granularity=\'structural\', retrievable=1 WHERE retrieval_kind=\'A\'')
  }

  const hasDeclarationSignature = elementColumns.some(col => col.name === 'declaration_signature')
  if (!hasDeclarationSignature) {
    db.exec('ALTER TABLE elements ADD COLUMN declaration_signature TEXT')
  }

  // Migração idempotente: adicionar source_kind e target_kind na tabela relationships.
  const relationshipColumns = db.prepare('PRAGMA table_info(relationships)').all() as Array<{ name: string }>
  const hasSourceKind = relationshipColumns.some(col => col.name === 'source_kind')
  if (!hasSourceKind) {
    db.exec('ALTER TABLE relationships ADD COLUMN source_kind TEXT NOT NULL DEFAULT \'element\'')
  }
  const hasTargetKind = relationshipColumns.some(col => col.name === 'target_kind')
  if (!hasTargetKind) {
    db.exec('ALTER TABLE relationships ADD COLUMN target_kind TEXT NOT NULL DEFAULT \'element\'')
  }

  if (!hasSourceKind || !hasTargetKind) {
    db.exec(`UPDATE relationships SET source_kind = CASE
      WHEN source_id IN (SELECT id FROM elements WHERE repository_id = relationships.repository_id) THEN 'element'
      ELSE 'file'
    END`)
    db.exec(`UPDATE relationships SET target_kind = CASE
      WHEN target_id IN (SELECT id FROM elements WHERE repository_id = relationships.repository_id) THEN 'element'
      ELSE 'file'
    END`)
  }
}

/** Retorna uma conexão existente ou cria uma nova com WAL mode e schema garantido. */
function getOrCreateConnection(repoPath: string): BetterSqlite3Database {
  const existing = connections.get(repoPath)
  if (existing) {
    return existing.db
  }

  ensureDir(repoPath)
  const dbPath = getDbPath(repoPath)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  ensureSchema(db)

  const conn: DatabaseConnection = { db, repoPath }
  connections.set(repoPath, conn)
  return db
}

// ─── Mappers: Domain → Row (escrita) ────────────────────────────────────────

/** Converte um repositório do domínio para o formato flat da tabela repositories. */
function domainToRepositoryRow(repo: CodeMapRepository): CodeMapRepositoryRow {
  return {
    id: repo.id,
    path: repo.path,
    name: repo.name,
    model_version: repo.modelVersion,
    last_indexed_at: repo.lastIndexedAt
  }
}

/** Converte um arquivo do domínio para o formato flat da tabela files. */
function domainToFileRow(file: CodeMapFile): CodeMapFileRow {
  return {
    id: file.id,
    repository_id: file.repositoryId,
    context_reference: file.contextReference ?? null,
    relative_path: file.relativePath,
    language: file.language,
    extension: file.extension,
    lines: file.lines,
    size_bytes: file.sizeBytes,
    mtime: file.mtime,
    content_hash: file.contentHash ?? null,
    token_count: file.tokenCount ?? null,
    tokenizer_id: file.tokenizerId ?? null,
    tokenizer_encoding: file.tokenizerEncoding ?? null,
    tokenized_content_hash: file.tokenizedContentHash ?? null,
    status: file.status
  }
}

/** Converte um elemento do domínio para o formato flat da tabela elements (JSON serializado em modifiers). */
function domainToElementRow(element: CodeMapElement): CodeMapElementRow {
  return {
    id: element.id,
    repository_id: element.repositoryId,
    file_id: element.fileId,
    kind: validateEnum(element.kind, ELEMENT_KINDS, 'kind'),
    name: element.name,
    parent_element_id: element.parentElementId,
    start_line: element.location.start.line,
    start_column: element.location.start.column,
    start_byte: element.location.start.byte,
    end_line: element.location.end.line,
    end_column: element.location.end.column,
    end_byte: element.location.end.byte,
    size_lines: element.sizeLines,
    size_bytes: element.sizeBytes,
    visibility: element.visibility,
    modifiers: JSON.stringify(element.modifiers),
    return_type: element.returnType,
    base_class: element.baseClass,
    has_documentation: element.hasDocumentation ? 1 : 0,
    parameter_count: element.parameterCount,
    retrieval_kind: element.retrievalKind ?? null,
    granularity: element.granularity,
    retrievable: element.retrievable ? 1 : 0,
    declaration_signature: element.declarationSignature ?? null
  }
}

/** Converte uma relação do domínio para o formato flat da tabela relationships. */
function domainToRelationshipRow(rel: CodeMapRelationship): CodeMapRelationshipRow {
  return {
    id: rel.id,
    repository_id: rel.repositoryId,
    source_id: rel.sourceId,
    target_id: rel.targetId,
    type: rel.type,
    source_kind: rel.sourceKind,
    target_kind: rel.targetKind
  }
}

function domainToSymbolReferenceRow(reference: PersistedSymbolReference): Record<string, string | number | null> {
  return {
    id: reference.id,
    repository_id: reference.repositoryId,
    source_file_id: reference.sourceFileId,
    source_element_id: reference.sourceElementId,
    target_element_id: reference.targetElementId,
    kind: validateEnum(reference.kind, SYMBOL_REFERENCE_KINDS, 'symbol reference kind'),
    line: reference.location.start.line,
    column: reference.location.start.column,
    start_byte: reference.location.start.byte,
    end_byte: reference.location.end.byte
  }
}

// ─── Mappers: Row → Domain (leitura com validação) ──────────────────────────

/** Valida que um valor string pertence ao conjunto permitido; caso contrário, lança erro descritivo. */
function validateEnum<T extends string>(value: string, allowed: readonly T[], fieldName: string): T {
  const found = allowed.find((v) => v === value)
  if (!found) {
    throw new Error(`Valor inválido para ${fieldName}: "${value}". Valores permitidos: ${allowed.join(', ')}`)
  }
  return found
}

/** Converte uma linha da tabela repositories para o tipo de domínio. */
function rowToRepository(row: any): CodeMapRepository {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    modelVersion: row.model_version,
    lastIndexedAt: row.last_indexed_at ?? null
  }
}

/** Converte uma linha da tabela files para o tipo de domínio, validando o status. */
function rowToFile(row: any): CodeMapFile {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    contextReference: row.context_reference ?? null,
    relativePath: row.relative_path,
    language: row.language,
    extension: row.extension,
    lines: row.lines,
    sizeBytes: row.size_bytes,
    mtime: row.mtime,
    contentHash: row.content_hash ?? null,
    tokenCount: row.token_count ?? null,
    tokenizerId: row.tokenizer_id ?? null,
    tokenizerEncoding: row.tokenizer_encoding ?? null,
    tokenizedContentHash: row.tokenized_content_hash ?? null,
    status: validateEnum(row.status, FILE_STATUSES, 'status')
  }
}

/** Converte uma linha da tabela elements para o tipo de domínio, validando kind e visibility, e desserializando modifiers. */
function rowToElement(row: any): CodeMapElement {
  let modifiers: string[] = []
  try {
    const parsed = JSON.parse(row.modifiers)
    if (Array.isArray(parsed)) {
      modifiers = parsed.filter((m): m is string => typeof m === 'string')
    }
  } catch {
    // BUGFIX: JSON inválido no campo modifiers não deve quebrar a leitura.
    // Usa array vazio e registra warning para não mascarar silenciosamente dados corrompidos.
    console.warn(`[RepositoryDatabase] modifiers JSON inválido no elemento ${row.id}. Usando [].`)
  }

  return {
    id: row.id,
    repositoryId: row.repository_id,
    fileId: row.file_id,
    kind: validateEnum(row.kind, ELEMENT_KINDS, 'kind'),
    name: row.name,
    parentElementId: row.parent_element_id ?? null,
    location: {
      start: {
        line: row.start_line,
        column: row.start_column,
        byte: row.start_byte
      },
      end: {
        line: row.end_line,
        column: row.end_column,
        byte: row.end_byte
      }
    },
    sizeLines: row.size_lines,
    sizeBytes: row.size_bytes,
    visibility: row.visibility === null ? null : validateEnum(row.visibility, ELEMENT_VISIBILITIES, 'visibility'),
    modifiers,
    returnType: row.return_type ?? null,
    baseClass: row.base_class ?? null,
    hasDocumentation: row.has_documentation === 1,
    parameterCount: row.parameter_count,
    retrievalKind: row.retrieval_kind ?? null,
    granularity: (row.granularity as CodeMapGranularity) ?? 'structural',
    retrievable: (row.retrievable ?? 0) === 1 || row.retrievable === true,
    declarationSignature: row.declaration_signature ?? null
  }
}

/** Converte uma linha da tabela relationships para o tipo de domínio, validando o tipo e os endpoint kinds. */
function rowToRelationship(row: any): CodeMapRelationship {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    sourceId: row.source_id,
    targetId: row.target_id,
    type: validateEnum(row.type, RELATIONSHIP_TYPES, 'type'),
    sourceKind: validateEnum(row.source_kind ?? 'element', ENDPOINT_KINDS, 'source_kind'),
    targetKind: validateEnum(row.target_kind ?? 'element', ENDPOINT_KINDS, 'target_kind')
  }
}

function rowToSymbolReference(row: any): PersistedSymbolReference {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    sourceFileId: row.source_file_id,
    sourceElementId: row.source_element_id ?? null,
    targetElementId: row.target_element_id,
    kind: validateEnum(row.kind, SYMBOL_REFERENCE_KINDS, 'symbol reference kind'),
    location: {
      start: { line: row.line, column: row.column, byte: row.start_byte },
      end: { line: row.line, column: row.column, byte: row.end_byte }
    }
  }
}

// ─── Implementação do Contrato ──────────────────────────────────────────────

class RepositoryDatabase implements RepositoryRepository {
  private readonly db: BetterSqlite3Database

  constructor(db: BetterSqlite3Database) {
    this.db = db
  }

  // ─── Repositórios ─────────────────────────────────────────────────────────

  /** Insere ou atualiza (upsert) um repositório. Usa path como chave de unicidade. */
  saveRepository(repository: CodeMapRepository): void {
    const row = domainToRepositoryRow(repository)
    this.db.prepare(`
      INSERT INTO repositories (id, path, name, model_version, last_indexed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        name = excluded.name,
        model_version = excluded.model_version,
        last_indexed_at = excluded.last_indexed_at
    `).run(row.id, row.path, row.name, row.model_version, row.last_indexed_at)
  }

  /** Busca um repositório pelo caminho absoluto. Retorna null se não encontrado. */
  getRepositoryByPath(path: string): CodeMapRepository | null {
    const row = this.db.prepare(`SELECT * FROM repositories WHERE path = ?`).get(path)
    return row ? rowToRepository(row) : null
  }

  /** Atualiza exclusivamente o campo lastIndexedAt de um repositório. */
  updateRepositoryLastIndexedAt(repositoryId: string, timestamp: string): void {
    this.db.prepare(`UPDATE repositories SET last_indexed_at = ? WHERE id = ?`).run(timestamp, repositoryId)
  }

  /**
   * Upsert do carimbo de última sincronização em repository_settings.
   * INSERT OR IGNORE garante a linha existente antes do UPDATE, preservando as demais colunas.
   */
  updateLastSyncAt(repositoryId: string, timestamp: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO repository_settings (repository_id) VALUES (?)`).run(repositoryId)
    this.db.prepare(`UPDATE repository_settings SET last_sync_at = ? WHERE repository_id = ?`).run(timestamp, repositoryId)
  }

  // ─── Arquivos ─────────────────────────────────────────────────────────────

  /** Insere ou atualiza (upsert) um arquivo. Usa (repositoryId, relativePath) como chave de unicidade. */
  saveFile(file: CodeMapFile): void {
    const row = domainToFileRow(file)
    this.db.prepare(`
      INSERT INTO files (id, repository_id, context_reference, relative_path, language, extension, lines, size_bytes, mtime, content_hash, token_count, tokenizer_id, tokenizer_encoding, tokenized_content_hash, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        repository_id = excluded.repository_id,
        context_reference = excluded.context_reference,
        relative_path = excluded.relative_path,
        language = excluded.language,
        extension = excluded.extension,
        lines = excluded.lines,
        size_bytes = excluded.size_bytes,
        mtime = excluded.mtime,
        content_hash = excluded.content_hash,
        token_count = excluded.token_count,
        tokenizer_id = excluded.tokenizer_id,
        tokenizer_encoding = excluded.tokenizer_encoding,
        tokenized_content_hash = excluded.tokenized_content_hash,
        status = excluded.status
    `).run(row.id, row.repository_id, row.context_reference, row.relative_path, row.language, row.extension, row.lines, row.size_bytes, row.mtime, row.content_hash, row.token_count, row.tokenizer_id, row.tokenizer_encoding, row.tokenized_content_hash, row.status)
  }

  allocateContextReference(repositoryId: string): string {
    return this.db.transaction(() => {
      this.ensureContextReferenceCounter(repositoryId)
      const row = this.db.prepare('SELECT next_value FROM context_reference_counters WHERE repository_id = ?').get(repositoryId) as { next_value: number }
      this.db.prepare('UPDATE context_reference_counters SET next_value = ? WHERE repository_id = ?').run(row.next_value + 1, repositoryId)
      return row.next_value.toString(36)
    })()
  }

  backfillContextReferences(repositoryId: string): number {
    return this.db.transaction(() => {
      this.ensureContextReferenceCounter(repositoryId)
      const rows = this.db.prepare('SELECT id FROM files WHERE repository_id = ? AND context_reference IS NULL ORDER BY relative_path').all(repositoryId) as Array<{ id: string }>
      for (const row of rows) {
        const contextReference = this.allocateContextReference(repositoryId)
        this.db.prepare('UPDATE files SET context_reference = ? WHERE id = ?').run(contextReference, row.id)
      }
      return rows.length
    })()
  }

  retireContextReference(repositoryId: string, contextReference: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO retired_context_references (repository_id, context_reference, retired_at)
      VALUES (?, ?, datetime('now'))
    `).run(repositoryId, contextReference)
  }

  moveFile(fileId: string, relativePath: string): void {
    this.db.prepare('UPDATE files SET relative_path = ? WHERE id = ?').run(relativePath, fileId)
  }

  private ensureContextReferenceCounter(repositoryId: string): void {
    const refs = this.db.prepare(`
      SELECT context_reference FROM files WHERE repository_id = ? AND context_reference IS NOT NULL
      UNION ALL
      SELECT context_reference FROM retired_context_references WHERE repository_id = ?
    `).all(repositoryId, repositoryId) as Array<{ context_reference: string }>
    const nextValue = refs.reduce((max, row) => {
      const value = Number.parseInt(row.context_reference, 36)
      return Number.isFinite(value) ? Math.max(max, value + 1) : max
    }, 0)
    this.db.prepare('INSERT OR IGNORE INTO context_reference_counters (repository_id, next_value) VALUES (?, ?)').run(repositoryId, nextValue)
  }

  /** Lista todos os arquivos de um repositório, ordenados por relativePath. */
  getFilesByRepository(repositoryId: string): CodeMapFile[] {
    const rows = this.db.prepare(`SELECT * FROM files WHERE repository_id = ? ORDER BY relative_path`).all(repositoryId)
    return rows.map(rowToFile)
  }

  /** Busca um arquivo pelo caminho relativo dentro do repositório. Retorna null se não encontrado. */
  getFileByPath(repositoryId: string, relativePath: string): CodeMapFile | null {
    const row = this.db.prepare(`SELECT * FROM files WHERE repository_id = ? AND relative_path = ?`).get(repositoryId, relativePath)
    return row ? rowToFile(row) : null
  }

  /** Busca um arquivo pelo ID único. Retorna null se não encontrado. */
  getFileById(fileId: string): CodeMapFile | null {
    const row = this.db.prepare(`SELECT * FROM files WHERE id = ?`).get(fileId)
    return row ? rowToFile(row) : null
  }

  /** Lista apenas os arquivos com status 'modified' de um repositório. */
  getModifiedFilesByRepository(repositoryId: string): CodeMapFile[] {
    const rows = this.db.prepare(`SELECT * FROM files WHERE repository_id = ? AND status = 'modified' ORDER BY relative_path`).all(repositoryId)
    return rows.map(rowToFile)
  }

  /** Atualiza o status de sincronização de um arquivo. */
  updateFileStatus(fileId: string, status: CodeMapFileStatus): void {
    this.db.prepare(`UPDATE files SET status = ? WHERE id = ?`).run(status, fileId)
  }

  /** Remove um arquivo e, em cascata manual, todos os seus elementos, relacionamentos e registros das tabelas auxiliares. */
  deleteFile(fileId: string): void {
    const tx = this.db.transaction(() => {
      const file = this.db.prepare('SELECT repository_id, context_reference FROM files WHERE id = ?').get(fileId) as { repository_id: string; context_reference: string | null } | undefined
      if (file?.context_reference) this.retireContextReference(file.repository_id, file.context_reference)
      // Remove registros das tabelas auxiliares antes dos elementos (integridade referencial manual).
      this.db.prepare(`DELETE FROM element_interfaces WHERE element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId)
      this.db.prepare(`DELETE FROM element_parameters WHERE element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId)
      this.db.prepare(`DELETE FROM element_decorators WHERE element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId)
      this.db.prepare(`DELETE FROM element_type_parameters WHERE element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId)
      this.db.prepare(`DELETE FROM relationships WHERE source_id IN (SELECT id FROM elements WHERE file_id = ?) OR target_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId, fileId)
      // Remove relacionamentos imports onde target_id é o fileId do arquivo deletado
      // (imports usam target_id = file_id, não element_id, então não são cobertos pela query acima)
      this.db.prepare(`DELETE FROM relationships WHERE type = 'imports' AND target_id = ?`).run(fileId)
      this.db.prepare(`DELETE FROM elements WHERE file_id = ?`).run(fileId)
      this.db.prepare(`DELETE FROM files WHERE id = ?`).run(fileId)
    })
    tx()
  }

  /** Remove todos os arquivos de um repositório e, em cascata manual, todos os elementos, relacionamentos e registros das tabelas auxiliares. */
  deleteAllFiles(repositoryId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM element_interfaces WHERE element_id IN (SELECT id FROM elements WHERE repository_id = ?)`).run(repositoryId)
      this.db.prepare(`DELETE FROM element_parameters WHERE element_id IN (SELECT id FROM elements WHERE repository_id = ?)`).run(repositoryId)
      this.db.prepare(`DELETE FROM element_decorators WHERE element_id IN (SELECT id FROM elements WHERE repository_id = ?)`).run(repositoryId)
      this.db.prepare(`DELETE FROM element_type_parameters WHERE element_id IN (SELECT id FROM elements WHERE repository_id = ?)`).run(repositoryId)
      this.db.prepare(`DELETE FROM relationships WHERE repository_id = ?`).run(repositoryId)
      // Nota: a query acima já remove TODOS os relacionamentos do repositório,
      // incluindo imports com target_id = file_id. Nenhuma ação adicional necessária.
      this.db.prepare(`DELETE FROM elements WHERE repository_id = ?`).run(repositoryId)
      this.db.prepare(`DELETE FROM files WHERE repository_id = ?`).run(repositoryId)
    })
    tx()
  }

  // ─── Elementos ────────────────────────────────────────────────────────────

  /** Insere ou atualiza (upsert) um elemento. Usa id como chave de unicidade. */
  saveElement(element: CodeMapElement): void {
    const row = domainToElementRow(element)
    this.db.prepare(`
      INSERT OR REPLACE INTO elements (
        id, repository_id, file_id, kind, name, parent_element_id,
        start_line, start_column, start_byte, end_line, end_column, end_byte,
        size_lines, size_bytes, visibility, modifiers, return_type, base_class,
        has_documentation, parameter_count, retrieval_kind, granularity, retrievable,
        declaration_signature
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.repository_id, row.file_id, row.kind, row.name, row.parent_element_id,
      row.start_line, row.start_column, row.start_byte, row.end_line, row.end_column, row.end_byte,
      row.size_lines, row.size_bytes, row.visibility, row.modifiers, row.return_type, row.base_class,
      row.has_documentation, row.parameter_count, row.retrieval_kind, row.granularity, row.retrievable,
      row.declaration_signature
    )
  }

  /** Insere ou atualiza múltiplos elementos em uma única transação para performance. */
  saveElements(elements: CodeMapElement[]): void {
    const tx = this.db.transaction((items: CodeMapElement[]) => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO elements (
          id, repository_id, file_id, kind, name, parent_element_id,
          start_line, start_column, start_byte, end_line, end_column, end_byte,
          size_lines, size_bytes, visibility, modifiers, return_type, base_class,
          has_documentation, parameter_count, retrieval_kind, granularity, retrievable,
          declaration_signature
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const element of items) {
        const row = domainToElementRow(element)
        stmt.run(
          row.id, row.repository_id, row.file_id, row.kind, row.name, row.parent_element_id,
          row.start_line, row.start_column, row.start_byte, row.end_line, row.end_column, row.end_byte,
          row.size_lines, row.size_bytes, row.visibility, row.modifiers, row.return_type, row.base_class,
          row.has_documentation, row.parameter_count, row.retrieval_kind, row.granularity, row.retrievable,
          row.declaration_signature
        )
      }
    })
    tx(elements)
  }

  /** Lista todos os elementos de um arquivo, ordenados por start_line. */
  getElementsByFile(fileId: string): CodeMapElement[] {
    const rows = this.db.prepare(`SELECT * FROM elements WHERE file_id = ? ORDER BY start_line`).all(fileId)
    return rows.map(rowToElement)
  }

  /** Lista todos os elementos de um repositório, ordenados por start_line. */
  getElementsByRepository(repositoryId: string): CodeMapElement[] {
    const rows = this.db.prepare(`SELECT * FROM elements WHERE repository_id = ? ORDER BY start_line`).all(repositoryId)
    return rows.map(rowToElement)
  }

  /** Remove todos os elementos de um arquivo específico, incluindo registros das tabelas auxiliares e relacionamentos associados. */
  deleteElementsByFile(fileId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM element_parameters WHERE element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId)
      this.db.prepare(`DELETE FROM element_interfaces WHERE element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId)
      this.db.prepare(`DELETE FROM element_decorators WHERE element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId)
      this.db.prepare(`DELETE FROM element_type_parameters WHERE element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId)
      this.db.prepare(`DELETE FROM relationships WHERE source_id IN (SELECT id FROM elements WHERE file_id = ?) OR target_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId, fileId)
      this.db.prepare(`DELETE FROM elements WHERE file_id = ?`).run(fileId)
    })
    tx()
  }

  /**
   * Substitui atomicamente o estado indexado de um arquivo (tudo ou nada).
   * Tudo roda em UMA transação melhor-sqlite3; os mappers (que incluem validateEnum)
   * executam dentro da transação, portanto entrada envenenada (kind inválido) dispara ROLLBACK total.
   */
  replaceIndexedFileState(
    file: CodeMapFile,
    elements: CodeMapElement[],
    relationships: CodeMapRelationship[],
    elementInterfaces: Array<{ elementId: string; interfaceNames: string[] }>,
    symbolReferences: PersistedSymbolReference[] = []
  ): void {
    const tx = this.db.transaction((
      _file: CodeMapFile,
      _elements: CodeMapElement[],
      _relationships: CodeMapRelationship[],
      _elementInterfaces: Array<{ elementId: string; interfaceNames: string[] }>,
      _symbolReferences: PersistedSymbolReference[]
    ) => {
      const fileId = _file.id

      // 1) Deleta tabelas-filha e relações que tocam os elementos do arquivo
      this.db.prepare(`DELETE FROM symbol_references WHERE source_file_id = ? OR source_element_id IN (SELECT id FROM elements WHERE file_id = ?) OR target_element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId, fileId, fileId)
      this.db.prepare(`DELETE FROM element_parameters WHERE element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId)
      this.db.prepare(`DELETE FROM element_interfaces WHERE element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId)
      this.db.prepare(`DELETE FROM element_decorators WHERE element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId)
      this.db.prepare(`DELETE FROM element_type_parameters WHERE element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId)

      // 2) Deleta relações de nível ARQUIVO (source_id/target_id = fileId) e as que tocam elementos do arquivo
      this.db.prepare(`DELETE FROM relationships WHERE source_id = ? OR target_id = ?`).run(fileId, fileId)
      this.db.prepare(`DELETE FROM relationships WHERE source_id IN (SELECT id FROM elements WHERE file_id = ?) OR target_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId, fileId)

      // 3) Deleta os elementos antigos
      this.db.prepare(`DELETE FROM elements WHERE file_id = ?`).run(fileId)

      // 4) Grava o file
      const fileRow = domainToFileRow(_file)
      this.db.prepare(`
        INSERT OR REPLACE INTO files (id, repository_id, context_reference, relative_path, language, extension, lines, size_bytes, mtime, content_hash, token_count, tokenizer_id, tokenizer_encoding, tokenized_content_hash, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(fileRow.id, fileRow.repository_id, fileRow.context_reference, fileRow.relative_path, fileRow.language, fileRow.extension, fileRow.lines, fileRow.size_bytes, fileRow.mtime, fileRow.content_hash, fileRow.token_count, fileRow.tokenizer_id, fileRow.tokenizer_encoding, fileRow.tokenized_content_hash, fileRow.status)

      // 5) Grava os novos elements (mappers com validateEnum DENTRO da transação)
      const elementInsert = this.db.prepare(`
        INSERT OR REPLACE INTO elements (
          id, repository_id, file_id, kind, name, parent_element_id,
          start_line, start_column, start_byte, end_line, end_column, end_byte,
          size_lines, size_bytes, visibility, modifiers, return_type, base_class,
          has_documentation, parameter_count, retrieval_kind, granularity, retrievable,
          declaration_signature
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const element of _elements) {
        const row = domainToElementRow(element) //lança em kind inválido → rollback
        elementInsert.run(
          row.id, row.repository_id, row.file_id, row.kind, row.name, row.parent_element_id,
          row.start_line, row.start_column, row.start_byte, row.end_line, row.end_column, row.end_byte,
          row.size_lines, row.size_bytes, row.visibility, row.modifiers, row.return_type, row.base_class,
          row.has_documentation, row.parameter_count, row.retrieval_kind, row.granularity, row.retrievable,
          row.declaration_signature
        )
      }

      // 6) Grava as relações locais do arquivo
      const relInsert = this.db.prepare(`
        INSERT OR REPLACE INTO relationships (id, repository_id, source_id, target_id, type, source_kind, target_kind)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      for (const rel of _relationships) {
        const row = domainToRelationshipRow(rel)
        relInsert.run(row.id, row.repository_id, row.source_id, row.target_id, row.type, row.source_kind, row.target_kind)
      }

      // 7) Grava as elementInterfaces dos elementos do arquivo
      const deleteIface = this.db.prepare(`DELETE FROM element_interfaces WHERE element_id = ?`)
      const insertIface = this.db.prepare(`INSERT OR REPLACE INTO element_interfaces (element_id, interface_name) VALUES (?, ?)`)
      for (const entry of _elementInterfaces) {
        deleteIface.run(entry.elementId)
        for (const ifaceName of entry.interfaceNames) {
          insertIface.run(entry.elementId, ifaceName)
        }
      }

      const referenceInsert = this.db.prepare(`
        INSERT OR REPLACE INTO symbol_references (
          id, repository_id, source_file_id, source_element_id, target_element_id,
          kind, line, column, start_byte, end_byte
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const reference of _symbolReferences) {
        const row = domainToSymbolReferenceRow(reference)
        referenceInsert.run(
          row.id, row.repository_id, row.source_file_id, row.source_element_id,
          row.target_element_id, row.kind, row.line, row.column, row.start_byte, row.end_byte
        )
      }
    })

    tx(file, elements, relationships, elementInterfaces, symbolReferences)
  }

  /** Salva ou substitui as interfaces implementadas por elementos em uma transação. */
  saveElementInterfaces(entries: Array<{ elementId: string; interfaceNames: string[] }>): void {
    if (entries.length === 0) return

    const tx = this.db.transaction((items: Array<{ elementId: string; interfaceNames: string[] }>) => {
      const deleteStmt = this.db.prepare(`DELETE FROM element_interfaces WHERE element_id = ?`)
      const insertStmt = this.db.prepare(`INSERT OR REPLACE INTO element_interfaces (element_id, interface_name) VALUES (?, ?)`)

      for (const entry of items) {
        deleteStmt.run(entry.elementId)
        for (const ifaceName of entry.interfaceNames) {
          insertStmt.run(entry.elementId, ifaceName)
        }
      }
    })
    tx(entries)
  }

  /** Apaga as interfaces associadas a elementos de um arquivo específico. */
  deleteElementInterfacesByFile(fileId: string): void {
    this.db.prepare(`DELETE FROM element_interfaces WHERE element_id IN (SELECT id FROM elements WHERE file_id = ?)`).run(fileId)
  }

  /** Busca todas as interfaces associadas a elementos de um repositório. */
  getElementInterfacesByRepository(repositoryId: string): Array<{ elementId: string; interfaceNames: string[] }> {
    const rows = this.db.prepare(`
      SELECT e.id as element_id, ei.interface_name
      FROM element_interfaces ei
      JOIN elements e ON e.id = ei.element_id
      WHERE e.repository_id = ?
      ORDER BY e.id
    `).all(repositoryId) as Array<{ element_id: string; interface_name: string }>

    const map = new Map<string, string[]>()
    for (const row of rows) {
      let list = map.get(row.element_id)
      if (!list) {
        list = []
        map.set(row.element_id, list)
      }
      list.push(row.interface_name)
    }

    const result: Array<{ elementId: string; interfaceNames: string[] }> = []
    for (const [elementId, interfaceNames] of map.entries()) {
      result.push({ elementId, interfaceNames })
    }
    return result
  }

  replaceSymbolReferencesForFile(sourceFileId: string, references: PersistedSymbolReference[]): void {
    this.db.transaction((items: PersistedSymbolReference[]) => {
      this.db.prepare('DELETE FROM symbol_references WHERE source_file_id = ?').run(sourceFileId)
      const insert = this.db.prepare(`
        INSERT INTO symbol_references (
          id, repository_id, source_file_id, source_element_id, target_element_id,
          kind, line, column, start_byte, end_byte
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const reference of items) {
        const row = domainToSymbolReferenceRow(reference)
        insert.run(
          row.id, row.repository_id, row.source_file_id, row.source_element_id,
          row.target_element_id, row.kind, row.line, row.column, row.start_byte, row.end_byte
        )
      }
    })(references)
  }

  getSymbolReferencesByTargetElement(targetElementId: string): PersistedSymbolReference[] {
    const rows = this.db.prepare(`
      SELECT sr.*
      FROM symbol_references sr
      JOIN files f ON f.id = sr.source_file_id
      WHERE sr.target_element_id = ?
      ORDER BY f.relative_path, sr.start_byte, sr.end_byte, sr.id
    `).all(targetElementId)
    return rows.map(rowToSymbolReference)
  }

  getSymbolReferencesBySourceElement(sourceElementId: string): PersistedSymbolReference[] {
    const rows = this.db.prepare(`
      SELECT sr.*
      FROM symbol_references sr
      JOIN elements target ON target.id = sr.target_element_id
      JOIN files target_file ON target_file.id = target.file_id
      WHERE sr.source_element_id = ?
      ORDER BY target_file.relative_path, sr.kind, sr.target_element_id, sr.start_byte, sr.end_byte, sr.id
    `).all(sourceElementId)
    return rows.map(rowToSymbolReference)
  }

  getSymbolReferencesBySourceFile(sourceFileId: string): PersistedSymbolReference[] {
    const rows = this.db.prepare(`
      SELECT sr.*
      FROM symbol_references sr
      JOIN files f ON f.id = sr.source_file_id
      WHERE sr.source_file_id = ?
      ORDER BY f.relative_path, sr.start_byte, sr.end_byte, sr.id
    `).all(sourceFileId)
    return rows.map(rowToSymbolReference)
  }

  getImporterFileIds(targetFileId: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT source.file_id
      FROM relationships relationship
      JOIN elements source ON source.id = relationship.source_id
      JOIN files source_file ON source_file.id = source.file_id
      WHERE relationship.type = 'imports' AND relationship.target_id = ?
      ORDER BY source_file.relative_path
    `).all(targetFileId) as Array<{ file_id: string }>
    return rows.map((row) => row.file_id)
  }

  // ─── Relacionamentos ──────────────────────────────────────────────────────

  /** Insere ou atualiza (upsert) uma relação. Usa id como chave de unicidade. */
  saveRelationship(relationship: CodeMapRelationship): void {
    const row = domainToRelationshipRow(relationship)
    this.db.prepare(`
      INSERT OR REPLACE INTO relationships (id, repository_id, source_id, target_id, type, source_kind, target_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.repository_id, row.source_id, row.target_id, row.type, row.source_kind, row.target_kind)
  }

  /** Insere ou atualiza múltiplas relações em uma única transação para performance. */
  saveRelationships(relationships: CodeMapRelationship[]): void {
    const tx = this.db.transaction((items: CodeMapRelationship[]) => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO relationships (id, repository_id, source_id, target_id, type, source_kind, target_kind)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      for (const rel of items) {
        const row = domainToRelationshipRow(rel)
        stmt.run(row.id, row.repository_id, row.source_id, row.target_id, row.type, row.source_kind, row.target_kind)
      }
    })
    tx(relationships)
  }

  /** Lista todas as relações de um repositório. */
  getRelationshipsByRepository(repositoryId: string): CodeMapRelationship[] {
    const rows = this.db.prepare(`SELECT * FROM relationships WHERE repository_id = ?`).all(repositoryId)
    return rows.map(rowToRelationship)
  }

  /** Busca relacionamentos onde o elemento é fonte (sourceId) ou destino (targetId). */
  getRelationshipsByElement(elementId: string): CodeMapRelationship[] {
    const rows = this.db.prepare(`SELECT * FROM relationships WHERE source_id = ? OR target_id = ?`).all(elementId, elementId)
    return rows.map(rowToRelationship)
  }

  getHierarchyRelationshipsBySourceElement(elementId: string): CodeMapRelationship[] {
    const rows = this.db.prepare(`
      SELECT * FROM relationships
      WHERE source_id = ?
        AND source_kind = 'element'
        AND target_kind = 'element'
        AND type IN ('extends', 'implements')
      ORDER BY type, target_id, id
    `).all(elementId)
    return rows.map(rowToRelationship)
  }

  getHierarchyRelationshipsByTargetElement(elementId: string): CodeMapRelationship[] {
    const rows = this.db.prepare(`
      SELECT * FROM relationships
      WHERE target_id = ?
        AND source_kind = 'element'
        AND target_kind = 'element'
        AND type IN ('extends', 'implements')
      ORDER BY type, source_id, id
    `).all(elementId)
    return rows.map(rowToRelationship)
  }

  /** Remove todos os relacionamentos onde o arquivo é fonte ou destino (via sourceId do arquivo ou de seus elementos). */
  deleteRelationshipsByFile(fileId: string): void {
    this.db.prepare(`
      DELETE FROM relationships
      WHERE source_id = ?
        OR target_id = ?
        OR source_id IN (SELECT id FROM elements WHERE file_id = ?)
        OR target_id IN (SELECT id FROM elements WHERE file_id = ?)
    `).run(fileId, fileId, fileId, fileId)
  }

  // ─── Sincronização ────────────────────────────────────────────────────────

  /** Retorna contagens agregadas do repositório usando queries COUNT do SQLite. */
  getSyncStatus(repositoryId: string): CodeMapSyncStatus {
    const filesRow = this.db.prepare(`
      SELECT
        COUNT(*) as totalFiles,
        SUM(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END) as indexedFiles,
        SUM(CASE WHEN status = 'modified' THEN 1 ELSE 0 END) as modifiedFiles
      FROM files WHERE repository_id = ?
    `).get(repositoryId) as { totalFiles: number; indexedFiles: number | null; modifiedFiles: number | null }

    const elementsRow = this.db.prepare(`SELECT COUNT(*) as totalElements FROM elements WHERE repository_id = ?`).get(repositoryId) as { totalElements: number }

    const settingsRow = this.db.prepare(`SELECT last_sync_at FROM repository_settings WHERE repository_id = ?`).get(repositoryId) as { last_sync_at: string | null } | undefined

    return {
      totalFiles: filesRow.totalFiles,
      indexedFiles: filesRow.indexedFiles ?? 0,
      modifiedFiles: filesRow.modifiedFiles ?? 0,
      totalElements: elementsRow.totalElements,
      lastSyncAt: settingsRow?.last_sync_at ?? null
    }
  }
}

// ─── Fábrica e Ciclo de Vida ────────────────────────────────────────────────

/** Cria uma instância de RepositoryRepository para um repositório, garantindo conexão e schema. */
export function createRepositoryDatabase(repoPath: string): RepositoryRepository {
  if (!repoPath || typeof repoPath !== 'string') {
    throw new Error('repoPath é obrigatório e deve ser uma string')
  }

  const db = getOrCreateConnection(repoPath)
  return new RepositoryDatabase(db)
}

/** Fecha a conexão de um repositório específico e remove do cache. */
export function closeRepositoryDatabase(repoPath: string): void {
  const conn = connections.get(repoPath)
  if (conn) {
    try {
      conn.db.close()
    } catch (error: any) {
      console.error('[RepositoryDatabase] Erro ao fechar conexão:', error)
    }
    connections.delete(repoPath)
  }
}

/** Fecha todas as conexões abertas. */
export function closeAllRepositoryDatabases(): void {
  for (const [repoPath] of connections) {
    closeRepositoryDatabase(repoPath)
  }
}
