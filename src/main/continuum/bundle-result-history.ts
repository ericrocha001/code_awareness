import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BundleResult } from '../../shared/types/continuum-builder-types'

export class BundleResultHistory {
  private readonly db: Database.Database
  private readonly payloadDir: string
  constructor(root: string, private readonly quotaBytes = 100 * 1024 * 1024, private readonly perRepository = 15) {
    this.payloadDir = join(root, 'payloads')
    mkdirSync(this.payloadDir, { recursive: true })
    this.db = new Database(join(root, 'results.sqlite'))
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL'); this.db.pragma('foreign_keys = ON')
    this.db.exec(`CREATE TABLE IF NOT EXISTS payloads (sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES payloads(sha256), metadata_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS results_repository ON results(repository_id);`)
  }
  list(repositoryId: string): BundleResult[] {
    return (this.db.prepare('SELECT metadata_json FROM results WHERE repository_id = ? ORDER BY rowid DESC').all(repositoryId) as Array<{ metadata_json: string }>).map(row => JSON.parse(row.metadata_json))
  }
  get(repositoryId: string, id: string) {
    const row = this.db.prepare('SELECT metadata_json FROM results WHERE repository_id = ? AND id = ?').get(repositoryId, id) as { metadata_json: string } | undefined
    if (!row) throw new Error('BUNDLE_RESULT_NOT_FOUND')
    const result = JSON.parse(row.metadata_json) as BundleResult
    let data: Buffer
    try { data = readFileSync(join(this.payloadDir, result.sha256)) } catch { throw new Error('BUNDLE_HISTORY_FILE_UNAVAILABLE') }
    if (data.length !== result.bytes || createHash('sha256').update(data).digest('hex') !== result.sha256) throw new Error('BUNDLE_HISTORY_INTEGRITY_ERROR')
    return { result, data }
  }
  retain(metadata: Omit<BundleResult, 'id' | 'sha256' | 'bytes'>, data: Buffer): { retained: boolean; retentionMessage: string; id?: string } {
    if (data.length > this.quotaBytes) return { retained: false, retentionMessage: 'Exportado; resultado ultrapassa 100 MiB e não foi retido.' }
    this.sweep()
    const sha256 = createHash('sha256').update(data).digest('hex')
    const target = join(this.payloadDir, sha256), temporary = join(this.payloadDir, randomUUID() + '.tmp')
    if (existsSync(target) && !readFileSync(target).equals(data)) throw new Error('BUNDLE_HISTORY_INTEGRITY_ERROR')
    if (!existsSync(target)) {
      try {
        const fd = openSync(temporary, 'wx', 0o600)
        try { writeFileSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(temporary, target)
      } finally { rmSync(temporary, { force: true }) }
    }
    const result: BundleResult = { ...metadata, id: randomUUID(), sha256, bytes: data.length }
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO payloads VALUES (?, ?)').run(sha256, data.length)
      this.db.prepare('INSERT INTO results VALUES (?, ?, ?, ?)').run(result.id, result.repositoryId, sha256, JSON.stringify(result))
      this.db.prepare('DELETE FROM results WHERE id IN (SELECT id FROM results WHERE repository_id = ? ORDER BY rowid DESC LIMIT -1 OFFSET ?)').run(result.repositoryId, this.perRepository)
      this.db.exec('DELETE FROM payloads WHERE sha256 NOT IN (SELECT sha256 FROM results)')
      while ((this.db.prepare('SELECT coalesce(sum(bytes), 0) AS bytes FROM payloads').get() as { bytes: number }).bytes > this.quotaBytes) {
        this.db.exec('DELETE FROM results WHERE rowid = (SELECT min(rowid) FROM results); DELETE FROM payloads WHERE sha256 NOT IN (SELECT sha256 FROM results)')
      }
    }).immediate()
    const clean = this.sweep()
    return { retained: true, id: result.id, retentionMessage: clean ? 'Resultado retido no histórico local.' : 'Resultado retido; limpeza de arquivos antigos pendente, será tentada na próxima geração.' }
  }
  private sweep(): boolean {
    const referenced = new Set((this.db.prepare('SELECT sha256 FROM payloads').all() as Array<{ sha256: string }>).map(row => row.sha256))
    let clean = true
    for (const file of readdirSync(this.payloadDir)) if (!referenced.has(file) && (/^[a-f0-9]{64}$/.test(file) || /^[a-f0-9-]+\.tmp$/.test(file))) {
      try { rmSync(join(this.payloadDir, file), { force: true }) } catch { clean = false }
    }
    return clean
  }
  close() { this.db.close() }
}
