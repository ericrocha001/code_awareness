import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { AtlasCommit, AtlasHistorySlice, AtlasPersistence } from './git-atlas-cache'

const formatVersion = 1
const byteLimit = 32 * 1024 * 1024
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
interface Row { body: string; checksum: string; bytes: number }

export class GitAtlasSqliteCache implements AtlasPersistence {
  private db?: Database.Database
  private readonly statements = new Map<string, Database.Statement>()
  private maintenance?: NodeJS.Immediate

  constructor(directory: string, repositoryId: string, commonDirectory: string) {
    try {
      const common = realpathSync(commonDirectory)
      const identity = JSON.stringify([repositoryId, process.platform === 'win32' ? common.toLowerCase() : common, formatVersion])
      mkdirSync(directory, { recursive: true })
      const db = this.db = new Database(join(directory, `${digest(identity)}.sqlite`), { timeout: 0 })
      db.pragma('busy_timeout = 0')
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      db.pragma('journal_size_limit = 4194304')
      db.pragma('max_page_count = 16384')
      const version = db.pragma('user_version', { simple: true })
      if (version !== 0 && version !== 1) throw new Error('ATLAS_CACHE_SCHEMA_INCOMPATIBLE')
      db.exec(`
        CREATE TABLE IF NOT EXISTS cache_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS git_commit (sha TEXT PRIMARY KEY, body TEXT NOT NULL, checksum TEXT NOT NULL, bytes INTEGER NOT NULL, last_access INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS history_slice (key TEXT PRIMARY KEY, body TEXT NOT NULL, checksum TEXT NOT NULL, bytes INTEGER NOT NULL, last_access INTEGER NOT NULL, revision TEXT NOT NULL, since_ms INTEGER, upper_ms INTEGER, page_offset INTEGER NOT NULL, complete INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS atlas_commit_lru ON git_commit(last_access);
        CREATE INDEX IF NOT EXISTS atlas_slice_lru ON history_slice(last_access);
        CREATE INDEX IF NOT EXISTS atlas_slice_revision ON history_slice(revision, complete, page_offset, last_access);
        PRAGMA user_version = 1;
      `)
      const stored = this.statement('SELECT value FROM cache_meta WHERE key = ?').get('identity') as { value: string } | undefined
      if (stored && stored.value !== identity) throw new Error('ATLAS_CACHE_IDENTITY_MISMATCH')
      this.statement('INSERT OR IGNORE INTO cache_meta(key, value) VALUES (?, ?)').run('identity', identity)
      this.statement('INSERT OR REPLACE INTO cache_meta(key, value) VALUES (?, ?)').run('limits', JSON.stringify({ formatVersion, byteLimit, commits: 8192, slices: 256 }))
    } catch { this.close() }
  }

  private statement(sql: string) {
    let statement = this.statements.get(sql)
    if (!statement) { statement = this.db!.prepare(sql); this.statements.set(sql, statement) }
    return statement
  }

  private read<T>(table: 'git_commit' | 'history_slice', key: string, maximum: number): T | undefined {
    if (!this.db) return undefined
    try {
      const column = table === 'git_commit' ? 'sha' : 'key'
      const row = this.statement(`SELECT substr(body, 1, ?) AS body, checksum, bytes FROM ${table} WHERE ${column} = ?`).get(maximum, key) as Row | undefined
      if (!row) return undefined
      if (row.bytes > maximum || Buffer.byteLength(row.body) !== row.bytes || digest(key + row.body) !== row.checksum) throw new Error('ATLAS_CACHE_CORRUPT')
      const value = JSON.parse(row.body) as T
      this.statement(`UPDATE ${table} SET last_access = ? WHERE ${column} = ?`).run(Date.now(), key)
      return value
    } catch { this.close(); return undefined }
  }

  getCommit(sha: string): AtlasCommit | undefined {
    const commit = this.read<AtlasCommit>('git_commit', sha, 128 * 1024)
    if (!commit) return undefined
    if (commit.sha !== sha || !shaPattern.test(commit.sha) || !Array.isArray(commit.parents) || commit.parents.length > 64 || commit.parents.some(parent => typeof parent !== 'string' || !shaPattern.test(parent)) ||
      typeof commit.author !== 'string' || typeof commit.subject !== 'string' || typeof commit.timestamp !== 'string' || !Number.isFinite(Date.parse(commit.timestamp))) { this.close(); return undefined }
    return commit
  }

  getSlice(key: string): AtlasHistorySlice | undefined {
    const slice = this.read<AtlasHistorySlice>('history_slice', key, 32 * 1024)
    if (!slice) return undefined
    if (!Array.isArray(slice.shas) || slice.shas.length > 101 || slice.shas.some(sha => typeof sha !== 'string' || !shaPattern.test(sha)) || typeof slice.hasMore !== 'boolean' ||
      !Array.isArray(slice.tips) || slice.tips.length > 512 || slice.tips.some(sha => typeof sha !== 'string' || !shaPattern.test(sha)) ||
      typeof slice.anchorAt !== 'string' || typeof slice.queriedAt !== 'string' || !Number.isFinite(Date.parse(slice.anchorAt)) || !Number.isFinite(Date.parse(slice.queriedAt)) ||
      !['PRESENT', 'CHECKOUT'].includes(slice.anchorKind) || !Number.isInteger(slice.offset) || slice.offset < 0 || !Number.isInteger(slice.limit) || slice.limit < 1 || slice.limit > 100) { this.close(); return undefined }
    if (slice.upperBound !== null && (typeof slice.upperBound !== 'string' || !Number.isFinite(Date.parse(slice.upperBound))) || slice.since !== null && (typeof slice.since !== 'string' || !Number.isFinite(Date.parse(slice.since)))) { this.close(); return undefined }
    return slice
  }

  findSlice(revision: string, since: string | null, until: string): AtlasHistorySlice | undefined {
    if (!this.db) return undefined
    try {
      const start = since === null ? null : Date.parse(since)
      const row = this.statement('SELECT key FROM history_slice WHERE revision = ? AND complete = 1 AND page_offset = 0 AND (since_ms IS NULL OR (? IS NOT NULL AND since_ms <= ?)) AND (upper_ms IS NULL OR upper_ms >= ?) ORDER BY last_access DESC LIMIT 1').get(revision, start, start, Date.parse(until)) as { key: string } | undefined
      return row ? this.getSlice(row.key) : undefined
    } catch { this.close(); return undefined }
  }

  save(key: string, slice: AtlasHistorySlice, commits: readonly AtlasCommit[]): void {
    if (!this.db || commits.length > 102) return
    try {
      const body = JSON.stringify(slice), bytes = Buffer.byteLength(body)
      if (bytes > 32 * 1024) return
      const rows = commits.map(commit => ({ sha: commit.sha, body: JSON.stringify(commit) })).map(row => ({ ...row, bytes: Buffer.byteLength(row.body) })).filter(row => row.bytes <= 128 * 1024)
      if (rows.reduce((total, row) => total + row.bytes, bytes) > 1024 * 1024) return
      this.db.transaction(() => {
        const now = Date.now()
        for (const row of rows) this.statement('INSERT OR IGNORE INTO git_commit(sha, body, checksum, bytes, last_access) VALUES (?, ?, ?, ?, ?)').run(row.sha, row.body, digest(row.sha + row.body), row.bytes, now)
        this.statement('INSERT OR REPLACE INTO history_slice(key, body, checksum, bytes, last_access, revision, since_ms, upper_ms, page_offset, complete) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(key, body, digest(key + body), bytes, now, slice.revision, slice.since === null ? null : Date.parse(slice.since), slice.upperBound === null ? null : Date.parse(slice.upperBound), slice.offset, Number(!slice.hasMore))
      })()
      this.scheduleMaintenance()
    } catch { this.close() }
  }

  private scheduleMaintenance() {
    if (!this.db || this.maintenance) return
    this.maintenance = setImmediate(() => {
      this.maintenance = undefined
      if (!this.db) return
      try {
        const stats = this.statement('SELECT (SELECT COUNT(*) FROM git_commit) AS commits, (SELECT COUNT(*) FROM history_slice) AS slices, (SELECT COALESCE(SUM(bytes), 0) FROM git_commit) + (SELECT COALESCE(SUM(bytes), 0) FROM history_slice) AS bytes').get() as { commits: number; slices: number; bytes: number }
        if (stats.commits <= 8192 && stats.slices <= 256 && stats.bytes <= byteLimit) return
        if (stats.slices > 256 || stats.bytes > byteLimit) this.statement('DELETE FROM history_slice WHERE key IN (SELECT key FROM history_slice ORDER BY last_access LIMIT 32)').run()
        if (stats.commits > 8192 || stats.bytes > byteLimit) this.statement('DELETE FROM git_commit WHERE sha IN (SELECT sha FROM git_commit ORDER BY last_access LIMIT 32)').run()
        this.scheduleMaintenance()
      } catch { this.close() }
    })
  }

  close(): void {
    if (this.maintenance) clearImmediate(this.maintenance)
    this.maintenance = undefined
    try { this.db?.close() } catch {}
    this.db = undefined; this.statements.clear()
  }
}
