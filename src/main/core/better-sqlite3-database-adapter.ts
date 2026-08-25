/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Implementar os contratos ActionLogPort, CheckpointCatalogPort e CampaignPort usando better-sqlite3.
2. Gerenciar o ciclo de vida das conexões internamente (abrir, fechar, reutilizar via Map privado).
3. Garantir que o schema e as migrações sejam aplicados automaticamente antes de qualquer operação (ensureConnection).
4. Prover closeAll() para encerramento gracioso das conexões ao fechar o aplicativo.

Mapa de Relacionamentos do Script

1. database-ports.ts
   - Tipo: Contrato / Interface
   - Relação: Implementa ActionLogPort, CheckpointCatalogPort e CampaignPort.
   - Criticidade: Alta

2. better-sqlite3
   - Tipo: Dependência Direta
   - Relação: Biblioteca SQLite síncrona usada para persistência.
   - Criticidade: Alta

3. main.ts
   - Tipo: Dependência Inversa
   - Relação: Instancia o adapter como único Composition Root e injeta nas dependências.
   - Criticidade: Alta

Invariantes do Script

1. O Map de conexões é privado da instância — sem estado global exportado.
2. Toda operação chama ensureConnection(repoPath) antes de acessar o banco.
3. Schema, migrações, WAL e caminho do banco (<repoPath>/code_awareness/code_checkpoints.db) permanecem idênticos ao database-service.ts original.
4. Nenhuma operação de banco falha silenciosamente por falta de inicialização — a inicialização é transparente para os chamadores.
5. A migração campaign_id é idempotente: erro de coluna duplicada é ignorado, qualquer outro erro é relançado.
6. A migração repo_path em campaigns (Sprint 11) usa PRAGMA table_info para verificar existência antes do ALTER TABLE, seguindo o padrão existente.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { ActionLogPort, CheckpointCatalogPort, CampaignPort } from './database-ports'
import type { ActionLog, CheckpointCatalogRecord, Campaign } from '../../shared/types'

interface DatabaseConnection {
  db: BetterSqlite3Database
  repoPath: string
}

export class BetterSqlite3DatabaseAdapter implements ActionLogPort, CheckpointCatalogPort, CampaignPort {
  private readonly connections = new Map<string, DatabaseConnection>()

  // ─── Inicialização interna ───────────────────────────────────────────────

  private getDbPath(repoPath: string): string {
    return join(repoPath, 'code_awareness', 'code_checkpoints.db')
  }

  private ensureDir(repoPath: string): void {
    const dir = join(repoPath, 'code_awareness')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  private ensureSchema(db: BetterSqlite3Database, repoPath: string): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_logs (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        checkpoint_id TEXT,
        checkpoint_name TEXT,
        details TEXT,
        repo_path TEXT NOT NULL,
        operation_id TEXT
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

    // Migração idempotente: adiciona operation_id a action_logs se não existir
    try {
      db.exec(`ALTER TABLE action_logs ADD COLUMN operation_id TEXT`)
    } catch (error: any) {
      if (!String(error.message).includes('duplicate column name')) {
        throw error
      }
    }

    // Migração idempotente (Sprint 11): adiciona repo_path à tabela campaigns.
    // Usa PRAGMA table_info para verificar existência antes do ALTER TABLE.
    // Como o banco é por repositório, todas as linhas existentes pertencem ao mesmo repoPath.
    const campaignCols = db.prepare(`PRAGMA table_info(campaigns)`).all() as Array<{ name: string }>
    if (!campaignCols.some(c => c.name === 'repo_path')) {
      db.exec(`ALTER TABLE campaigns ADD COLUMN repo_path TEXT NOT NULL DEFAULT ''`)
      db.prepare(`UPDATE campaigns SET repo_path = ? WHERE repo_path = ''`).run(repoPath)
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_campaigns_repo ON campaigns(repo_path)`)

    // Migração idempotente (Sprint 1): semeia a tabela checkpoint_campaigns a partir da coluna campaign_id
    db.exec(`
      INSERT OR IGNORE INTO checkpoint_campaigns (checkpoint_id, campaign_id, position)
      SELECT id, campaign_id, 0 FROM checkpoints
      WHERE campaign_id IS NOT NULL AND campaign_id != ''
    `)
  }

  /**
   * Abre (ou reutiliza) a conexão com o banco do repositório.
   * Garante que o diretório, o arquivo, o WAL e o schema existam antes de retornar.
   */
  private ensureConnection(repoPath: string): BetterSqlite3Database {
    if (!repoPath || typeof repoPath !== 'string') {
      throw new Error('repoPath é obrigatório e deve ser uma string')
    }

    const existing = this.connections.get(repoPath)
    if (existing) return existing.db

    this.ensureDir(repoPath)
    const db = new Database(this.getDbPath(repoPath))
    db.pragma('journal_mode = WAL')
    this.ensureSchema(db, repoPath)

    this.connections.set(repoPath, { db, repoPath })
    return db

  }

  /**
   * Fecha uma conexão específica.
   */
  closeDatabase(repoPath: string): void {
    const conn = this.connections.get(repoPath)
    if (conn) {
      try { conn.db.close() } catch (error: any) {
        console.error('[BetterSqlite3DatabaseAdapter] Erro ao fechar conexão:', error)
      }
      this.connections.delete(repoPath)
    }
  }

  /**
   * Fecha todas as conexões abertas. Chamado pelo main.ts no before-quit.
   */
  closeAll(): void {
    for (const [repoPath] of this.connections) {
      this.closeDatabase(repoPath)
    }
  }

  // ─── ActionLogPort ───────────────────────────────────────────────────────

  insertAction(action: Omit<ActionLog, 'id'>): void {
    const db = this.ensureConnection(action.repoPath)
    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`
    try {
      const insertTransaction = db.transaction(() => {
        const stmt = db.prepare(`
          INSERT INTO action_logs (id, action_type, timestamp, checkpoint_id, checkpoint_name, details, repo_path, operation_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        stmt.run(
          id,
          action.actionType,
          action.timestamp,
          action.checkpointId || null,
          action.checkpointName || null,
          action.details || null,
          action.repoPath,
          action.operationId || null
        )
      })
      insertTransaction()
    } catch (error: any) {
      console.error('[BetterSqlite3DatabaseAdapter] Erro ao inserir ação:', error)
      throw error
    }
  }

  getActions(repoPath: string, limit?: number): ActionLog[] {
    const db = this.ensureConnection(repoPath)
    if (limit) {
      const stmt = db.prepare(`SELECT * FROM action_logs WHERE repo_path = ? ORDER BY timestamp DESC LIMIT ?`)
      return stmt.all(repoPath, limit).map(this.mapRowToActionLog) as ActionLog[]
    }
    const stmt = db.prepare(`SELECT * FROM action_logs WHERE repo_path = ? ORDER BY timestamp DESC`)
    return stmt.all(repoPath).map(this.mapRowToActionLog) as ActionLog[]
  }

  getActionsByDateRange(repoPath: string, startDate: number, endDate: number): ActionLog[] {
    const db = this.ensureConnection(repoPath)
    const stmt = db.prepare(`
      SELECT * FROM action_logs WHERE repo_path = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC
    `)
    return stmt.all(repoPath, startDate, endDate).map(this.mapRowToActionLog) as ActionLog[]
  }

  private mapRowToActionLog(row: any): ActionLog {
    return {
      id: row.id,
      actionType: row.action_type,
      timestamp: row.timestamp,
      checkpointId: row.checkpoint_id || undefined,
      checkpointName: row.checkpoint_name || undefined,
      details: row.details || undefined,
      repoPath: row.repo_path,
      operationId: row.operation_id || undefined
    }
  }

  // ─── CheckpointCatalogPort ───────────────────────────────────────────────

  insertCheckpointCatalog(repoPath: string, record: Omit<CheckpointCatalogRecord, 'repoPath'>): void {
    const db = this.ensureConnection(repoPath)
    try {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO checkpoints (id, name, created_at, instructions, agent_summary, restored_at, file_count, has_content, repo_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run(
        record.id, record.name, record.createdAt, record.instructions,
        record.agentSummary, record.restoredAt, record.fileCount,
        record.hasContent ? 1 : 0, repoPath
      )
    } catch (error: any) {
      console.error('[BetterSqlite3DatabaseAdapter] Erro ao inserir checkpoint no catálogo:', error)
      throw error
    }
  }

  getCheckpointsCatalog(repoPath: string): CheckpointCatalogRecord[] {
    const db = this.ensureConnection(repoPath)
    const stmt = db.prepare(`SELECT * FROM checkpoints WHERE repo_path = ? ORDER BY created_at DESC`)
    return stmt.all(repoPath).map(this.mapRowToCheckpointCatalogRecord) as CheckpointCatalogRecord[]
  }

  getCheckpointCatalog(repoPath: string, checkpointId: string): CheckpointCatalogRecord | null {
    const db = this.ensureConnection(repoPath)
    const stmt = db.prepare(`SELECT * FROM checkpoints WHERE id = ? AND repo_path = ?`)
    const row = stmt.get(checkpointId, repoPath)
    return row ? this.mapRowToCheckpointCatalogRecord(row) : null
  }

  updateCheckpointCatalog(
    repoPath: string,
    checkpointId: string,
    patch: Partial<Omit<CheckpointCatalogRecord, 'id' | 'repoPath'>>
  ): void {
    const db = this.ensureConnection(repoPath)
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
          val = val ? 1 : (0 as any)
        }
        values.push(val === undefined ? null : val)
      }
    }

    if (setClauses.length === 0) return
    values.push(checkpointId, repoPath)

    try {
      const stmt = db.prepare(`UPDATE checkpoints SET ${setClauses.join(', ')} WHERE id = ? AND repo_path = ?`)
      stmt.run(...values)
    } catch (error: any) {
      console.error('[BetterSqlite3DatabaseAdapter] Erro ao atualizar checkpoint no catálogo:', error)
      throw error
    }
  }

  deleteCheckpointCatalog(repoPath: string, checkpointId: string): void {
    const db = this.ensureConnection(repoPath)
    try {
      // cascade manual: deletar o catálogo deleta os vínculos do checkpoint na caderneta
      db.prepare('DELETE FROM checkpoint_campaigns WHERE checkpoint_id = ?').run(checkpointId)
      db.prepare(`DELETE FROM checkpoints WHERE id = ? AND repo_path = ?`).run(checkpointId, repoPath)
    } catch (error: any) {
      console.error('[BetterSqlite3DatabaseAdapter] Erro ao deletar checkpoint do catálogo:', error)
      throw error
    }
  }

  getContentCheckpoints(repoPath: string): CheckpointCatalogRecord[] {
    const db = this.ensureConnection(repoPath)
    const stmt = db.prepare(`SELECT * FROM checkpoints WHERE repo_path = ? AND has_content = 1 ORDER BY created_at ASC`)
    return stmt.all(repoPath).map(this.mapRowToCheckpointCatalogRecord) as CheckpointCatalogRecord[]
  }

  archiveCheckpointCatalog(repoPath: string, checkpointId: string): void {
    const db = this.ensureConnection(repoPath)
    try {
      db.prepare(`UPDATE checkpoints SET has_content = 0 WHERE id = ? AND repo_path = ?`).run(checkpointId, repoPath)
    } catch (error: any) {
      console.error('[BetterSqlite3DatabaseAdapter] Erro ao arquivar checkpoint no catálogo:', error)
      throw error
    }
  }

  setCheckpointCampaignLinks(repoPath: string, checkpointId: string, campaignIds: string[]): void {
    const db = this.ensureConnection(repoPath)
    try {
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM checkpoint_campaigns WHERE checkpoint_id = ?').run(checkpointId)
        const insert = db.prepare('INSERT INTO checkpoint_campaigns (checkpoint_id, campaign_id, position) VALUES (?, ?, ?)')
        for (let i = 0; i < campaignIds.length; i++) {
          insert.run(checkpointId, campaignIds[i], i)
        }
      })
      tx()
    } catch (error: any) {
      console.error('[BetterSqlite3DatabaseAdapter] Erro ao atualizar ligações de campanha:', error)
      throw error
    }
  }

  getCheckpointCampaignIds(repoPath: string, checkpointId: string): string[] {
    const db = this.ensureConnection(repoPath)
    const stmt = db.prepare(`SELECT campaign_id FROM checkpoint_campaigns WHERE checkpoint_id = ? ORDER BY position, campaign_id`)
    return stmt.all(checkpointId).map((row: any) => row.campaign_id)
  }

  getCheckpointCampaignIdsMap(repoPath: string): Record<string, string[]> {
    const db = this.ensureConnection(repoPath)
    const stmt = db.prepare(`SELECT checkpoint_id, campaign_id FROM checkpoint_campaigns ORDER BY checkpoint_id, position, campaign_id`)
    const rows = stmt.all() as Array<{ checkpoint_id: string; campaign_id: string }>
    const map: Record<string, string[]> = {}
    for (const row of rows) {
      if (!map[row.checkpoint_id]) map[row.checkpoint_id] = []
      map[row.checkpoint_id].push(row.campaign_id)
    }
    return map
  }

  getCampaignCheckpointIds(repoPath: string, campaignId: string): string[] {
    const db = this.ensureConnection(repoPath)
    const stmt = db.prepare(`SELECT checkpoint_id FROM checkpoint_campaigns WHERE campaign_id = ?`)
    return stmt.all(campaignId).map((row: any) => row.checkpoint_id)
  }

  private mapRowToCheckpointCatalogRecord(row: any): CheckpointCatalogRecord {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      // BUGFIX: Usa ?? null em vez de || null para preservar strings vazias ("").
      instructions: row.instructions ?? null,
      agentSummary: row.agent_summary ?? null,
      restoredAt: row.restored_at ?? null,
      fileCount: row.file_count,
      hasContent: row.has_content === 1,
      repoPath: row.repo_path
    }
  }

  // ─── CampaignPort ────────────────────────────────────────────────────────

  insertCampaign(repoPath: string, campaign: Campaign): void {
    const db = this.ensureConnection(repoPath)
    try {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO campaigns (id, slug, name, description, status, created_at, updated_at, repo_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run(campaign.id, campaign.slug, campaign.name, campaign.description,
        campaign.status, campaign.createdAt, campaign.updatedAt, repoPath)
    } catch (error: any) {
      console.error('[BetterSqlite3DatabaseAdapter] Erro ao inserir campanha:', error)
      throw error
    }
  }

  getCampaigns(repoPath: string): Campaign[] {
    const db = this.ensureConnection(repoPath)
    const stmt = db.prepare(`SELECT * FROM campaigns WHERE repo_path = ? ORDER BY created_at DESC`)
    return stmt.all(repoPath).map(this.mapRowToCampaign) as Campaign[]
  }

  getCampaign(repoPath: string, campaignId: string): Campaign | null {
    const db = this.ensureConnection(repoPath)
    const stmt = db.prepare(`SELECT * FROM campaigns WHERE id = ? AND repo_path = ?`)
    const row = stmt.get(campaignId, repoPath)
    return row ? this.mapRowToCampaign(row) : null
  }

  getCampaignBySlug(repoPath: string, slug: string): Campaign | null {
    const db = this.ensureConnection(repoPath)
    const stmt = db.prepare(`SELECT * FROM campaigns WHERE slug = ? AND repo_path = ?`)
    const row = stmt.get(slug, repoPath)
    return row ? this.mapRowToCampaign(row) : null
  }

  updateCampaign(repoPath: string, campaignId: string, patch: Partial<Omit<Campaign, 'id'>>): void {
    const db = this.ensureConnection(repoPath)
    const keys = Object.keys(patch) as Array<keyof typeof patch>
    if (keys.length === 0) return

    const setClauses: string[] = []
    const values: any[] = []

    const columnMap: Record<keyof Omit<Campaign, 'id'>, string> = {
      slug: 'slug', name: 'name', description: 'description',
      status: 'status', createdAt: 'created_at', updatedAt: 'updated_at'
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
    values.push(repoPath)

    try {
      const stmt = db.prepare(`UPDATE campaigns SET ${setClauses.join(', ')} WHERE id = ? AND repo_path = ?`)
      stmt.run(...values)
    } catch (error: any) {
      console.error('[BetterSqlite3DatabaseAdapter] Erro ao atualizar campanha:', error)
      throw error
    }
  }

  private mapRowToCampaign(row: any): Campaign {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      // BUGFIX: Usa ?? '' em vez de ?? null porque o tipo Campaign declara
      // description como string (não nullable).
      description: row.description ?? '',
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}

