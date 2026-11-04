import type Database from 'better-sqlite3'

export function migrateSessionNamespace(db: Database.Database, assertCurrent: () => void = () => {}): void {
  const schema = (db.prepare("SELECT sql FROM sqlite_master WHERE name='sessions'").get() as { sql: string }).sql
  const legacy = /UNIQUE\s*\(\s*provider\s*,\s*providerSessionId\s*\)/i
  if (!legacy.test(schema)) return
  if (db.inTransaction) throw new Error('SESSION_MIGRATION_CONFLICT')
  const indexes = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='sessions' AND sql IS NOT NULL").all() as { sql: string }[]).map(row => row.sql)
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      assertCurrent()
      db.exec(schema.replace(/^CREATE TABLE sessions\s*\(/i, 'CREATE TABLE sessions_namespaced(').replace(legacy, 'UNIQUE(provider, agent, providerSessionId)'))
      db.exec('INSERT INTO sessions_namespaced SELECT * FROM sessions; DROP TABLE sessions; ALTER TABLE sessions_namespaced RENAME TO sessions;')
      for (const sql of indexes) db.exec(sql)
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('SESSION_MIGRATION_INTEGRITY_ERROR')
      assertCurrent()
    }).immediate()
  } finally { db.pragma('foreign_keys = ON') }
}
