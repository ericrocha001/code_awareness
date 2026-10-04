import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { GitHubRepositoryIdentity, RepositoryAvailability, RepositoryGitState, RepositoryRecord, RepositoryStatus } from '../../shared/types/repository-catalog-types'

type Row = Record<string, any>

export interface RepositoryCatalogUpsert {
  path: string
  normalizedPath: string
  name: string
  status: RepositoryStatus
  availability: RepositoryAvailability
  gitState: RepositoryGitState
}

export class RepositoryCatalogStore {
  private readonly db: Database.Database

  constructor(readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new Database(databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repository_catalog_records (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','HIDDEN')),
        checkout_path TEXT,
        normalized_checkout_path TEXT UNIQUE,
        availability TEXT CHECK(availability IN ('AVAILABLE','MISSING')),
        git_state TEXT CHECK(git_state IN ('GIT','NON_GIT')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          (checkout_path IS NULL AND normalized_checkout_path IS NULL AND availability IS NULL AND git_state IS NULL)
          OR
          (checkout_path IS NOT NULL AND normalized_checkout_path IS NOT NULL AND availability IS NOT NULL AND git_state IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS repository_catalog_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS repository_catalog_status_name
        ON repository_catalog_records(status, name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS repository_catalog_github_links (
        repository_record_id TEXT PRIMARY KEY REFERENCES repository_catalog_records(id) ON DELETE CASCADE,
        github_repository_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        owner_login TEXT NOT NULL,
        name TEXT NOT NULL,
        full_name TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK(visibility IN ('PUBLIC','PRIVATE','INTERNAL')),
        html_url TEXT NOT NULL,
        clone_url TEXT NOT NULL,
        access_state TEXT NOT NULL CHECK(access_state IN ('AVAILABLE','UNAVAILABLE')),
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS repository_catalog_github_access
        ON repository_catalog_github_links(access_state, full_name COLLATE NOCASE);
    `)
  }

  close(): void { this.db.close() }

  list(includeHidden = false): RepositoryRecord[] {
    const sql = includeHidden
      ? `${RECORD_SELECT} ORDER BY r.name COLLATE NOCASE, r.id`
      : `${RECORD_SELECT} WHERE r.status='ACTIVE' ORDER BY r.name COLLATE NOCASE, r.id`
    return (this.db.prepare(sql).all() as Row[]).map(recordFromRow)
  }

  get(id: string): RepositoryRecord {
    const row = this.db.prepare(`${RECORD_SELECT} WHERE r.id=?`).get(id) as Row | undefined
    if (!row) throw new Error('REPOSITORY_NOT_FOUND')
    return recordFromRow(row)
  }

  findByNormalizedPath(normalizedPath: string): RepositoryRecord | null {
    const row = this.db.prepare(`${RECORD_SELECT} WHERE r.normalized_checkout_path=?`).get(normalizedPath) as Row | undefined
    return row ? recordFromRow(row) : null
  }

  findByGitHubRepositoryId(repositoryId: string): RepositoryRecord | null {
    const row = this.db.prepare(`${RECORD_SELECT} WHERE g.github_repository_id=?`).get(repositoryId) as Row | undefined
    return row ? recordFromRow(row) : null
  }

  createRemoteOnly(identity: GitHubRepositoryIdentity): RepositoryRecord {
    const existing = this.findByGitHubRepositoryId(identity.repositoryId)
    if (existing) return this.attachGitHub(existing.id, identity)
    const id = randomUUID()
    const now = new Date().toISOString()
    const create = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO repository_catalog_records(id,name,status,created_at,updated_at)
        VALUES(?,?,'ACTIVE',?,?)`).run(id, identity.name, now, now)
      writeGitHubLink(this.db, id, identity)
    })
    create()
    return this.get(id)
  }

  attachGitHub(id: string, identity: GitHubRepositoryIdentity): RepositoryRecord {
    const owned = this.findByGitHubRepositoryId(identity.repositoryId)
    if (owned && owned.id !== id) throw new Error('GITHUB_REPOSITORY_ALREADY_LINKED')
    const update = this.db.transaction(() => {
      if (!this.db.prepare('SELECT id FROM repository_catalog_records WHERE id=?').get(id)) throw new Error('REPOSITORY_NOT_FOUND')
      writeGitHubLink(this.db, id, identity)
      this.db.prepare('UPDATE repository_catalog_records SET name=CASE WHEN checkout_path IS NULL THEN ? ELSE name END, updated_at=? WHERE id=?')
        .run(identity.name, new Date().toISOString(), id)
    })
    update()
    return this.get(id)
  }

  attachLocalCheckout(id: string, input: Omit<RepositoryCatalogUpsert, 'status'>): RepositoryRecord {
    const conflicting = this.findByNormalizedPath(input.normalizedPath)
    if (conflicting && conflicting.id !== id) throw new Error('LOCAL_PATH_CONFLICT')
    const result = this.db.prepare(`UPDATE repository_catalog_records SET
      name=?, checkout_path=?, normalized_checkout_path=?, availability=?, git_state=?, updated_at=? WHERE id=?
    `).run(input.name, input.path, input.normalizedPath, input.availability, input.gitState, new Date().toISOString(), id)
    if (!result.changes) throw new Error('REPOSITORY_NOT_FOUND')
    return this.get(id)
  }

  markGitHubUnavailableExcept(repositoryIds: string[]): void {
    const now = new Date().toISOString()
    const reconcile = this.db.transaction(() => {
      this.db.prepare("UPDATE repository_catalog_github_links SET access_state='UNAVAILABLE'").run()
      for (let index = 0; index < repositoryIds.length; index += 500) {
        const batch = repositoryIds.slice(index, index + 500)
        const placeholders = batch.map(() => '?').join(',')
        this.db.prepare(`UPDATE repository_catalog_github_links SET access_state='AVAILABLE'
          WHERE github_repository_id IN (${placeholders})`).run(...batch)
      }
      this.db.prepare(`UPDATE repository_catalog_records SET updated_at=? WHERE id IN (
        SELECT repository_record_id FROM repository_catalog_github_links
      )`).run(now)
    })
    reconcile()
  }

  upsertLocalCheckout(input: RepositoryCatalogUpsert): { record: RepositoryRecord; created: boolean } {
    const existing = this.findByNormalizedPath(input.normalizedPath)
    const now = new Date().toISOString()
    if (existing) {
      this.db.prepare(`UPDATE repository_catalog_records SET
        checkout_path=?, name=?, status=?, availability=?, git_state=?, updated_at=? WHERE id=?
      `).run(input.path, existing.name, input.status, input.availability, input.gitState, now, existing.id)
      return { record: this.get(existing.id), created: false }
    }
    const id = randomUUID()
    this.db.prepare(`INSERT INTO repository_catalog_records(
      id,name,status,checkout_path,normalized_checkout_path,availability,git_state,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      id, input.name, input.status, input.path, input.normalizedPath,
      input.availability, input.gitState, now, now
    )
    return { record: this.get(id), created: true }
  }

  setStatus(id: string, status: RepositoryStatus): RepositoryRecord {
    const result = this.db.prepare('UPDATE repository_catalog_records SET status=?, updated_at=? WHERE id=?')
      .run(status, new Date().toISOString(), id)
    if (!result.changes) throw new Error('REPOSITORY_NOT_FOUND')
    return this.get(id)
  }

  refreshCheckout(id: string, path: string, availability: RepositoryAvailability, gitState: RepositoryGitState): RepositoryRecord {
    const result = this.db.prepare(`UPDATE repository_catalog_records SET
      checkout_path=?, availability=?, git_state=?, updated_at=? WHERE id=?
    `).run(path, availability, gitState, new Date().toISOString(), id)
    if (!result.changes) throw new Error('REPOSITORY_NOT_FOUND')
    return this.get(id)
  }

  isLegacyMigrationComplete(): boolean {
    return Boolean(this.db.prepare("SELECT value FROM repository_catalog_meta WHERE key='legacy-migration-v1'").get())
  }

  markLegacyMigrationComplete(): void {
    this.db.prepare("INSERT OR REPLACE INTO repository_catalog_meta(key,value) VALUES('legacy-migration-v1',?)")
      .run(new Date().toISOString())
  }
}

function recordFromRow(row: Row): RepositoryRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    localCheckout: row.checkout_path ? {
      path: row.checkout_path,
      availability: row.availability,
      gitState: row.git_state
    } : null,
    github: row.github_repository_id ? {
      repositoryId: row.github_repository_id,
      ownerId: row.github_owner_id,
      ownerLogin: row.github_owner_login,
      name: row.github_name,
      fullName: row.github_full_name,
      visibility: row.github_visibility,
      htmlUrl: row.github_html_url,
      cloneUrl: row.github_clone_url,
      accessState: row.github_access_state,
      lastSeenAt: row.github_last_seen_at
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

const RECORD_SELECT = `SELECT r.*,
  g.github_repository_id, g.owner_id AS github_owner_id, g.owner_login AS github_owner_login,
  g.name AS github_name, g.full_name AS github_full_name, g.visibility AS github_visibility,
  g.html_url AS github_html_url, g.clone_url AS github_clone_url,
  g.access_state AS github_access_state, g.last_seen_at AS github_last_seen_at
  FROM repository_catalog_records r
  LEFT JOIN repository_catalog_github_links g ON g.repository_record_id=r.id`

function writeGitHubLink(db: Database.Database, recordId: string, identity: GitHubRepositoryIdentity): void {
  db.prepare(`INSERT INTO repository_catalog_github_links(
    repository_record_id,github_repository_id,owner_id,owner_login,name,full_name,visibility,
    html_url,clone_url,access_state,last_seen_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repository_record_id) DO UPDATE SET
    github_repository_id=excluded.github_repository_id, owner_id=excluded.owner_id,
    owner_login=excluded.owner_login, name=excluded.name, full_name=excluded.full_name,
    visibility=excluded.visibility, html_url=excluded.html_url, clone_url=excluded.clone_url,
    access_state=excluded.access_state, last_seen_at=excluded.last_seen_at`).run(
      recordId, identity.repositoryId, identity.ownerId, identity.ownerLogin, identity.name,
      identity.fullName, identity.visibility, identity.htmlUrl, identity.cloneUrl,
      identity.accessState, identity.lastSeenAt
    )
}
