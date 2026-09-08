/*
-T ---
*/

import type {
  CodeMapElement,
  CodeMapFile,
  CodeMapFileStatus,
  CodeMapRelationship,
  CodeMapRepository,
  CodeMapSyncStatus
} from '../../shared/types'

export interface CodeMapRepositoryRow {
  id: string
  path: string
  name: string
  model_version: number
  last_indexed_at: string | null
}

export interface CodeMapFileRow {
  id: string
  repository_id: string
  context_reference: string | null
  relative_path: string
  language: string
  extension: string
  lines: number
  size_bytes: number
  mtime: number
  content_hash: string | null
  token_count: number | null
  tokenizer_id: string | null
  tokenizer_encoding: string | null
  tokenized_content_hash: string | null
  status: string
}

export interface CodeMapElementRow {
  id: string
  repository_id: string
  file_id: string
  kind: string
  name: string
  parent_element_id: string | null
  start_line: number
  start_column: number
  start_byte: number
  end_line: number
  end_column: number
  end_byte: number
  size_lines: number
  size_bytes: number
  visibility: string | null
  modifiers: string
  return_type: string | null
  base_class: string | null
  has_documentation: number
  parameter_count: number
  retrieval_kind: string | null
  /** Granularidade semântica do elemento */
  granularity: string
  /** Se 1, o elemento pode ser recuperado exatamente via getElementExactSource */
  retrievable: number
}

export interface CodeMapRelationshipRow {
  id: string
  repository_id: string
  source_id: string
  target_id: string
  type: string
  source_kind: string
  target_kind: string
}

export interface RepositoryRepository {
  // ─── Repositórios ─────────────────────────────────────────────────────────

  /** Insere ou atualiza (upsert) um repositório. Usa path como chave de unicidade. */
  saveRepository(repository: CodeMapRepository): void

  /** Busca um repositório pelo caminho absoluto. Retorna null se não encontrado. */
  getRepositoryByPath(path: string): CodeMapRepository | null

  /** Atualiza exclusivamente o campo lastIndexedAt de um repositório. */
  updateRepositoryLastIndexedAt(repositoryId: string, timestamp: string): void

  /** Upsert do carimbo de última sincronização na tabela repository_settings, sem apagar outras colunas. */
  updateLastSyncAt(repositoryId: string, timestamp: string): void

  // ─── Arquivos ─────────────────────────────────────────────────────────────

  /** Insere ou atualiza (upsert) um arquivo. Usa (repositoryId, relativePath) como chave de unicidade. */
  saveFile(file: CodeMapFile): void

  allocateContextReference(repositoryId: string): string

  backfillContextReferences(repositoryId: string): number

  retireContextReference(repositoryId: string, contextReference: string): void

  moveFile(fileId: string, relativePath: string): void

  /** Lista todos os arquivos de um repositório, ordenados por relativePath. */
  getFilesByRepository(repositoryId: string): CodeMapFile[]

  /** Busca um arquivo pelo caminho relativo dentro do repositório. Retorna null se não encontrado. */
  getFileByPath(repositoryId: string, relativePath: string): CodeMapFile | null

  /** Busca um arquivo pelo ID único. Retorna null se não encontrado. */
  getFileById(fileId: string): CodeMapFile | null

  /** Lista apenas os arquivos com status 'modified' de um repositório. Usado pelo Synchronizer para reindexação seletiva. */
  getModifiedFilesByRepository(repositoryId: string): CodeMapFile[]

  /** Atualiza o status de sincronização de um arquivo. */
  updateFileStatus(fileId: string, status: CodeMapFileStatus): void

  /** Remove um arquivo e, em cascata manual, todos os seus elementos, relacionamentos e registros das tabelas auxiliares. */
  deleteFile(fileId: string): void

  /** Remove todos os arquivos de um repositório e, em cascata manual, todos os elementos, relacionamentos e registros das tabelas auxiliares. */
  deleteAllFiles(repositoryId: string): void

  // ─── Elementos ────────────────────────────────────────────────────────────

  /** Insere ou atualiza (upsert) um elemento. Usa id como chave de unicidade. */
  saveElement(element: CodeMapElement): void

  /** Insere ou atualiza múltiplos elementos em uma única transação para performance. */
  saveElements(elements: CodeMapElement[]): void

  /** Lista todos os elementos de um arquivo, ordenados por start_line. */
  getElementsByFile(fileId: string): CodeMapElement[]

  /** Lista todos os elementos de um repositório, ordenados por start_line. */
  getElementsByRepository(repositoryId: string): CodeMapElement[]

  /** Remove todos os elementos de um arquivo específico, incluindo registros das tabelas auxiliares e relacionamentos associados. */
  deleteElementsByFile(fileId: string): void

  /**
   * Substitui atomicamente o estado indexado de um arquivo (tudo ou nada).
   * Dentro de UMA transação: deleta tabelas-filha e relações do arquivo, deleta os elementos antigos,
   * grava o file, os novos elements, as relações locais do arquivo e as elementInterfaces.
   * Os mappers (com validação) rodam DENTRO da transação — entrada envenenada causa rollback total.
   */
  replaceIndexedFileState(
    file: CodeMapFile,
    elements: CodeMapElement[],
    relationships: CodeMapRelationship[],
    elementInterfaces: Array<{ elementId: string; interfaceNames: string[] }>
  ): void

  /** Salva ou substitui as interfaces implementadas por elementos em uma transação. */
  saveElementInterfaces(entries: Array<{ elementId: string; interfaceNames: string[] }>): void

  /** Apaga as interfaces associadas a elementos de um arquivo específico. */
  deleteElementInterfacesByFile(fileId: string): void

  /** Busca todas as interfaces associadas a elementos de um repositório. */
  getElementInterfacesByRepository(repositoryId: string): Array<{ elementId: string; interfaceNames: string[] }>

  // ─── Relacionamentos ──────────────────────────────────────────────────────

  /** Insere ou atualiza (upsert) uma relação. Usa id como chave de unicidade. */
  saveRelationship(relationship: CodeMapRelationship): void

  /** Insere ou atualiza múltiplas relações em uma única transação para performance. */
  saveRelationships(relationships: CodeMapRelationship[]): void

  /** Lista todas as relações de um repositório. */
  getRelationshipsByRepository(repositoryId: string): CodeMapRelationship[]

  /** Busca relacionamentos onde o elemento é fonte (sourceId) ou destino (targetId). */
  getRelationshipsByElement(elementId: string): CodeMapRelationship[]

  /** Remove todos os relacionamentos onde o arquivo é fonte ou destino (via sourceId do arquivo ou de seus elementos). */
  deleteRelationshipsByFile(fileId: string): void

  // ─── Sincronização ────────────────────────────────────────────────────────

  /** Retorna contagens agregadas do repositório (totalFiles, indexedFiles, modifiedFiles, totalElements, lastSyncAt) usando queries COUNT do SQLite. */
  getSyncStatus(repositoryId: string): CodeMapSyncStatus
}
