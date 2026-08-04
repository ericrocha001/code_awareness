/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Inicializar o banco de dados SQLite na pasta code_awareness/ do repositório.
2. Criar o schema e aplicar migrações idempotentes (tabelas action_logs, sprints e checkpoints) automaticamente na primeira execução.
3. Inserir registros de ações no banco.
4. Consultar ações por data ou por repositório.
5. Gerenciar o ciclo de vida do banco (abrir/fechar conexão).
6. Gerenciar o catálogo de checkpoints (fase dual-write temporária).

Mapa de Relacionamentos do Script

1. ../../shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos ActionLog, SprintData e CheckpointCatalogRecord para operações de banco.
   - Criticidade: Alta

2. better-sqlite3
   - Tipo: Dependência Direta
   - Relação: Biblioteca SQLite para persistência de dados síncrona e segura.
   - Criticidade: Alta

3. database-handler.ts (Sprint 1)
   - Tipo: Fluxo de Dados
   - Relação: Recebe chamadas delegadas do handler IPC.
   - Criticidade: Alta

Invariantes do Script

1. Nunca retornar dados inconsistentes após inserção (transações garantem atomicidade).
2. O banco nunca deve ser corrompido por uma operação com erro (transações com rollback).
3. Conexões de bancos não utilizados devem ser fechadas para evitar vazamento de memória.
4. Nenhuma dependência de checkpoint-service.ts.
5. repoPath deve ser validado antes de qualquer operação de banco.
6. A migração campaign_id deve ser idempotente e nunca remover dados existentes.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { ActionLog, Campaign, CheckpointCatalogRecord } from '../../shared/types'

// Cache de conexões abertas: chave = repoPath, valor = instância do banco
interface DatabaseConnection {
  db: BetterSqlite3Database
  repoPath: string
}

const connections = new Map<string, DatabaseConnection>()

// Caminho do arquivo do banco
function getDbPath(repoPath: string): string {
  return join(repoPath, 'code_awareness', 'code_checkpoints.db')
}

// Garante que a pasta code_awareness existe
function ensureDir(repoPath: string): void {
  const dir = join(repoPath, 'code_awareness')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

// Cria as tabelas se não existirem
function ensureSchema(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_logs (
      id TEXT PRIMARY KEY,
      action_type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      checkpoint_id TEXT,
      checkpoint_name TEXT,
      details TEXT,
      repo_path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sprints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      objective TEXT NOT NULL,
      instructions TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      repo_path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      instructions TEXT,
      agent_summary TEXT,
      restored_at TEXT,
      file_count INTEGER NOT NULL DEFAULT 0,
      has_content INTEGER NOT NULL DEFAULT 1,
      campaign_id TEXT,
      repo_path TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_action_logs_repo ON action_logs(repo_path);
    CREATE INDEX IF NOT EXISTS idx_action_logs_timestamp ON action_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_sprints_repo ON sprints(repo_path);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_repo ON checkpoints(repo_path);
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_created ON checkpoints(created_at);
    CREATE TABLE IF NOT EXISTS checkpoint_campaigns (
      checkpoint_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (checkpoint_id, campaign_id)
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoint_campaigns_campaign ON checkpoint_campaigns (campaign_id);
  `)

  // Migração idempotente: adiciona campaign_id a bancos criados antes da Sprint 1.
  // SQLite não suporta ADD COLUMN IF NOT EXISTS; o erro de coluna duplicada é
  // esperado em bancos novos e ignorado. Qualquer outro erro é relançado.
  try {
    db.exec(`ALTER TABLE checkpoints ADD COLUMN campaign_id TEXT`)
  } catch (error: any) {
    if (!String(error.message).includes('duplicate column name')) {
      throw error
    }
  }

  // Migração idempotente (Sprint 1): semeia a tabela checkpoint_campaigns a partir da coluna campaign_id
  db.exec(`
    INSERT OR IGNORE INTO checkpoint_campaigns (checkpoint_id, campaign_id, position)
    SELECT id, campaign_id, 0 FROM checkpoints
    WHERE campaign_id IS NOT NULL AND campaign_id != ''
  `)
}

/**
 * Inicializa o banco de dados para um repositório.
 * Cria a pasta code_awareness/ e o arquivo .db se não existirem.
 */
export function initializeDatabase(repoPath: string): void {
  if (!repoPath || typeof repoPath !== 'string') {
    throw new Error('repoPath é obrigatório e deve ser uma string')
  }

  // Verifica se já existe conexão aberta
  if (connections.has(repoPath)) {
    return
  }

  ensureDir(repoPath)

  const dbPath = getDbPath(repoPath)
  
  // Cria novo banco ou abre o existente
  const db = new Database(dbPath)

  // Otimizações do SQLite via WAL (Write-Ahead Logging)
  db.pragma('journal_mode = WAL')
  
  ensureSchema(db)

  const conn: DatabaseConnection = { db, repoPath }
  connections.set(repoPath, conn)
}

/**
 * Insere uma ação no banco de dados.
 * Gera um ID único baseado em timestamp + random.
 */
export function insertAction(action: Omit<ActionLog, 'id'>): void {
  const conn = connections.get(action.repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${action.repoPath}. Chame initializeDatabase() primeiro.`)
  }

  const id = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`

  try {
    const insertTransaction = conn.db.transaction(() => {
      const stmt = conn.db.prepare(`
        INSERT INTO action_logs (id, action_type, timestamp, checkpoint_id, checkpoint_name, details, repo_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run(
        id,
        action.actionType,
        action.timestamp,
        action.checkpointId || null,
        action.checkpointName || null,
        action.details || null,
        action.repoPath
      )
    })
    
    insertTransaction()
  } catch (error: any) {
    console.error('[DatabaseService] Erro ao inserir ação:', error)
    throw error
  }
}

/**
 * Retorna ações ordenadas por timestamp descendente.
 */
export function getActions(repoPath: string, limit?: number): ActionLog[] {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  let stmt
  if (limit) {
    stmt = conn.db.prepare(`SELECT * FROM action_logs WHERE repo_path = ? ORDER BY timestamp DESC LIMIT ?`)
    return stmt.all(repoPath, limit).map(mapRowToActionLog) as ActionLog[]
  } else {
    stmt = conn.db.prepare(`SELECT * FROM action_logs WHERE repo_path = ? ORDER BY timestamp DESC`)
    return stmt.all(repoPath).map(mapRowToActionLog) as ActionLog[]
  }
}

/**
 * Consulta ações por intervalo de datas (timestamp).
 */
export function getActionsByDateRange(repoPath: string, startDate: number, endDate: number): ActionLog[] {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  const stmt = conn.db.prepare(`
    SELECT * FROM action_logs WHERE repo_path = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC
  `)
  return stmt.all(repoPath, startDate, endDate).map(mapRowToActionLog) as ActionLog[]
}

/**
 * Fecha a conexão de um repositório específico.
 */
export function closeDatabase(repoPath: string): void {
  const conn = connections.get(repoPath)
  if (conn) {
    try {
      conn.db.close()
    } catch (error: any) {
      console.error('[DatabaseService] Erro ao fechar conexão:', error)
    }
    connections.delete(repoPath)
  }
}

/**
 * Fecha todas as conexões abertas.
 */
export function closeAllDatabases(): void {
  for (const [repoPath] of connections) {
    closeDatabase(repoPath)
  }
}

// Converte uma linha do SQL para o tipo ActionLog
function mapRowToActionLog(row: any): ActionLog {
  return {
    id: row.id,
    actionType: row.action_type,
    timestamp: row.timestamp,
    checkpointId: row.checkpoint_id || undefined,
    checkpointName: row.checkpoint_name || undefined,
    details: row.details || undefined,
    repoPath: row.repo_path
  }
}

// ─── CRUD do Catálogo de Checkpoints ────────────────────────────────────────

/**
 * Insere ou atualiza (replace) um registro no catálogo de checkpoints.
 * Idempotente, não falha em duplicatas.
 */
export function insertCheckpointCatalog(repoPath: string, record: Omit<CheckpointCatalogRecord, 'repoPath'>): void {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  try {
    const stmt = conn.db.prepare(`
      INSERT OR REPLACE INTO checkpoints (id, name, created_at, instructions, agent_summary, restored_at, file_count, has_content, repo_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      record.id,
      record.name,
      record.createdAt,
      record.instructions,
      record.agentSummary,
      record.restoredAt,
      record.fileCount,
      record.hasContent ? 1 : 0,
      repoPath
    )
  } catch (error: any) {
    console.error('[DatabaseService] Erro ao inserir checkpoint no catálogo:', error)
    throw error
  }
}

/**
 * Retorna todos os registros do catálogo para um repositório, ordenados por data de criação descendente.
 */
export function getCheckpointsCatalog(repoPath: string): CheckpointCatalogRecord[] {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  const stmt = conn.db.prepare(`SELECT * FROM checkpoints WHERE repo_path = ? ORDER BY created_at DESC`)
  return stmt.all(repoPath).map(mapRowToCheckpointCatalogRecord) as CheckpointCatalogRecord[]
}

/**
 * Busca um registro específico no catálogo por ID e repositório.
 */
export function getCheckpointCatalog(repoPath: string, checkpointId: string): CheckpointCatalogRecord | null {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  const stmt = conn.db.prepare(`SELECT * FROM checkpoints WHERE id = ? AND repo_path = ?`)
  const row = stmt.get(checkpointId, repoPath)
  return row ? mapRowToCheckpointCatalogRecord(row) : null
}

/**
 * Atualiza campos específicos de um registro no catálogo.
 */
export function updateCheckpointCatalog(
  repoPath: string,
  checkpointId: string,
  patch: Partial<Omit<CheckpointCatalogRecord, 'id' | 'repoPath'>>
): void {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  const keys = Object.keys(patch) as Array<keyof typeof patch>
  if (keys.length === 0) return

  const setClauses: string[] = []
  const values: any[] = []

  const columnMap: Record<keyof Omit<CheckpointCatalogRecord, 'id' | 'repoPath'>, string> = {
    name: 'name',
    createdAt: 'created_at',
    instructions: 'instructions',
    agentSummary: 'agent_summary',
    restoredAt: 'restored_at',
    fileCount: 'file_count',
    hasContent: 'has_content'
  }

  for (const key of keys) {
    const colName = columnMap[key as keyof Omit<CheckpointCatalogRecord, 'id' | 'repoPath'>]
    if (colName) {
      setClauses.push(`${colName} = ?`)
      let val = patch[key as keyof typeof patch]
      if (key === 'hasContent' && typeof val === 'boolean') {
        val = val ? 1 : 0
      }
      values.push(val === undefined ? null : val)
    }
  }

  if (setClauses.length === 0) return

  values.push(checkpointId, repoPath)

  try {
    const stmt = conn.db.prepare(`
      UPDATE checkpoints SET ${setClauses.join(', ')} WHERE id = ? AND repo_path = ?
    `)
    stmt.run(...values)
  } catch (error: any) {
    console.error('[DatabaseService] Erro ao atualizar checkpoint no catálogo:', error)
    throw error
  }
}

/**
 * Deleta um registro do catálogo.
 */
export function deleteCheckpointCatalog(repoPath: string, checkpointId: string): void {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  try {
    // cascade manual: deletar o catálogo deleta os vínculos do checkpoint na caderneta (integridade referencial manual; não há FOREIGN KEY para preservar o desacoplamento entre features)
    conn.db.prepare('DELETE FROM checkpoint_campaigns WHERE checkpoint_id = ?').run(checkpointId)
    const stmt = conn.db.prepare(`DELETE FROM checkpoints WHERE id = ? AND repo_path = ?`)
    stmt.run(checkpointId, repoPath)
  } catch (error: any) {
    console.error('[DatabaseService] Erro ao deletar checkpoint do catálogo:', error)
    throw error
  }
}

/**
 * Retorna todos os registros do catálogo com conteúdo (has_content = 1),
 * ordenados por data de criação ascendente (mais antigo primeiro).
 * Usado pelo checkpoint-service para aplicar o limite de 100 checkpoints.
 */
export function getContentCheckpoints(repoPath: string): CheckpointCatalogRecord[] {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  const stmt = conn.db.prepare(`SELECT * FROM checkpoints WHERE repo_path = ? AND has_content = 1 ORDER BY created_at ASC`)
  return stmt.all(repoPath).map(mapRowToCheckpointCatalogRecord) as CheckpointCatalogRecord[]
}

/**
 * Marca um registro como sem conteúdo (arquivado), para uso em sprints futuras.
 */
export function archiveCheckpointCatalog(repoPath: string, checkpointId: string): void {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  try {
    const stmt = conn.db.prepare(`UPDATE checkpoints SET has_content = 0 WHERE id = ? AND repo_path = ?`)
    stmt.run(checkpointId, repoPath)
  } catch (error: any) {
    console.error('[DatabaseService] Erro ao arquivar checkpoint no catálogo:', error)
    throw error
  }
}

// Converte uma linha do SQL para o tipo CheckpointCatalogRecord
function mapRowToCheckpointCatalogRecord(row: any): CheckpointCatalogRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    // BUGFIX: Usa ?? null em vez de || null para preservar strings vazias ("").
    // O operador || converte "" em null, perdendo a semântica de "campo vazio".
    instructions: row.instructions ?? null,
    agentSummary: row.agent_summary ?? null,
    restoredAt: row.restored_at ?? null,
    fileCount: row.file_count,
    hasContent: row.has_content === 1,
    repoPath: row.repo_path
  }
}

// Converte uma linha do SQL para o tipo Campaign
function mapRowToCampaign(row: any): Campaign {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    // BUGFIX: Usa ?? '' em vez de ?? null porque o tipo Campaign declara
    // description como string (não nullable). A coluna é NOT NULL
    // com DEFAULT, então o fallback defensivo é string vazia.
    description: row.description ?? '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ─── Ligações Checkpoint ↔ Campaign ───

export function setCheckpointCampaignLinks(repoPath: string, checkpointId: string, campaignIds: string[]): void {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  try {
    const tx = conn.db.transaction(() => {
      conn.db.prepare('DELETE FROM checkpoint_campaigns WHERE checkpoint_id = ?').run(checkpointId)
      const insert = conn.db.prepare('INSERT INTO checkpoint_campaigns (checkpoint_id, campaign_id, position) VALUES (?, ?, ?)')
      for (let i = 0; i < campaignIds.length; i++) {
        insert.run(checkpointId, campaignIds[i], i)
      }
    })
    tx()
  } catch (error: any) {
    console.error('[DatabaseService] Erro ao atualizar ligações de campanha:', error)
    throw error
  }
}

export function getCheckpointCampaignIds(repoPath: string, checkpointId: string): string[] {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  const stmt = conn.db.prepare(`SELECT campaign_id FROM checkpoint_campaigns WHERE checkpoint_id = ? ORDER BY position, campaign_id`)
  return stmt.all(checkpointId).map((row: any) => row.campaign_id)
}

export function getCheckpointCampaignIdsMap(repoPath: string): Record<string, string[]> {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  const stmt = conn.db.prepare(`SELECT checkpoint_id, campaign_id FROM checkpoint_campaigns ORDER BY checkpoint_id, position, campaign_id`)
  const rows = stmt.all() as Array<{ checkpoint_id: string; campaign_id: string }>
  const map: Record<string, string[]> = {}
  for (const row of rows) {
    if (!map[row.checkpoint_id]) {
      map[row.checkpoint_id] = []
    }
    map[row.checkpoint_id].push(row.campaign_id)
  }
  return map
}

export function getCampaignCheckpointIds(repoPath: string, campaignId: string): string[] {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  const stmt = conn.db.prepare(`SELECT checkpoint_id FROM checkpoint_campaigns WHERE campaign_id = ?`)
  return stmt.all(campaignId).map((row: any) => row.checkpoint_id)
}

// ─── CRUD de Campaigns ──────────────────────────────────────────────────────────

/**
 * Insere ou atualiza (replace) uma campanha.
 * Idempotente, não falha em duplicatas.
 */
export function insertCampaign(repoPath: string, campaign: Campaign): void {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  try {
    const stmt = conn.db.prepare(`
      INSERT OR REPLACE INTO campaigns (id, slug, name, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      campaign.id,
      campaign.slug,
      campaign.name,
      campaign.description,
      campaign.status,
      campaign.createdAt,
      campaign.updatedAt
    )
  } catch (error: any) {
    console.error('[DatabaseService] Erro ao inserir campanha:', error)
    throw error
  }
}

/**
 * Retorna todas as campanhas de um repositório, ordenadas por data de criação descendente.
 */
export function getCampaigns(repoPath: string): Campaign[] {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  const stmt = conn.db.prepare(`SELECT * FROM campaigns ORDER BY created_at DESC`)
  return stmt.all().map(mapRowToCampaign) as Campaign[]
}

/**
 * Busca uma campanha por ID.
 */
export function getCampaign(repoPath: string, campaignId: string): Campaign | null {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  const stmt = conn.db.prepare(`SELECT * FROM campaigns WHERE id = ?`)
  const row = stmt.get(campaignId)
  return row ? mapRowToCampaign(row) : null
}

/**
 * Busca uma campanha por slug.
 * Usada pelo serviço para validar unicidade antes de inserir ou renomear.
 */
export function getCampaignBySlug(repoPath: string, slug: string): Campaign | null {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  const stmt = conn.db.prepare(`SELECT * FROM campaigns WHERE slug = ?`)
  const row = stmt.get(slug)
  return row ? mapRowToCampaign(row) : null
}

/**
 * Atualiza campos específicos de uma campanha.
 */
export function updateCampaign(
  repoPath: string,
  campaignId: string,
  patch: Partial<Omit<Campaign, 'id'>>
): void {
  const conn = connections.get(repoPath)
  if (!conn) {
    throw new Error(`Banco de dados não inicializado para: ${repoPath}. Chame initializeDatabase() primeiro.`)
  }

  const keys = Object.keys(patch) as Array<keyof typeof patch>
  if (keys.length === 0) return

  const setClauses: string[] = []
  const values: any[] = []

  const columnMap: Record<keyof Omit<Campaign, 'id'>, string> = {
    slug: 'slug',
    name: 'name',
    description: 'description',
    status: 'status',
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }

  for (const key of keys) {
    const colName = columnMap[key]
    if (colName) {
      setClauses.push(`${colName} = ?`)
      values.push(patch[key] === undefined ? null : patch[key])
    }
  }

  if (setClauses.length === 0) return

  values.push(campaignId)

  try {
    const stmt = conn.db.prepare(`
      UPDATE campaigns SET ${setClauses.join(', ')} WHERE id = ?
    `)
    stmt.run(...values)
  } catch (error: any) {
    console.error('[DatabaseService] Erro ao atualizar campanha:', error)
    throw error
  }
}
