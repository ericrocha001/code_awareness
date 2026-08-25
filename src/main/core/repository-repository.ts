/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir o contrato de persistência do Repository Model para operações CRUD.
2. Declarar os tipos de persistência (Row) que representam o formato flat das colunas no SQLite.
3. Declarar métodos para persistência e consulta de interfaces implementadas por elementos.
4. Declarar o método de atualização do carimbo de última sincronização (updateLastSyncAt).

Mapa de Relacionamentos do Script

1. shared/types.ts
   - Tipo: Dependência Direta
   - Relação: Consome os tipos de domínio CodeMapElement, CodeMapFile, CodeMapRepository, CodeMapRelationship, CodeMapFileStatus e CodeMapSyncStatus.
   - Criticidade: Alta

2. repository-model.ts (Sprint 5)
   - Tipo: Contrato / Interface
   - Relação: Dependerá apenas desta interface, nunca diretamente do SQLite.
   - Criticidade: Alta

3. repository-database.ts (Sprint 2)
   - Tipo: Dependência Inversa
   - Relação: Implementará esta interface, convertendo entre tipos Row e tipos de domínio.
   - Criticidade: Alta

Invariantes do Script

1. Nenhum tipo de domínio pode conter referência a SQLite ou qualquer tecnologia de banco.
2. Os métodos do contrato devem receber e retornar apenas tipos de domínio, nunca tipos Row.
3. A conversão entre Row e domínio é responsabilidade exclusiva da implementação.
4. Nenhum método pode ser implementado neste arquivo — apenas declarado na interface.
5. Os tipos Row devem permanecer internos ao main process, nunca exportados para shared/types.ts.
6. O tipo CodeMapFileRow representa o formato flat da tabela files, incluindo a coluna content_hash.
7. getFileById deve retornar null quando o id não existir — nunca lançar exceção.

--- FIM ARQUITETURA DO SCRIPT ---
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
  relative_path: string
  language: string
  extension: string
  lines: number
  size_bytes: number
  mtime: number
  content_hash: string | null
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
}

export interface CodeMapRelationshipRow {
  id: string
  repository_id: string
  source_id: string
  target_id: string
  type: string
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