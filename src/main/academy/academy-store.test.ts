import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcademyStore } from './academy-store'
import Database from 'better-sqlite3'

const roots: string[] = []
const pkg = (name = 'alpha', body = '# Alpha') => ({ skillMd: `---\nname: ${name}\ndescription: Skill ${name}\n---\n\n${body}\n`, artifacts: { 'references/guide.md': 'Olá β' } })
const open = () => {
  const root = mkdtempSync(join(tmpdir(), 'academy-store-'))
  roots.push(root)
  return new AcademyStore(join(root, 'academy.db'))
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('AcademyStore', () => {
  it('discovers metadata and selects an exact immutable package while preserving legacy and archived history', () => {
    const store = open()
    try {
      const skill = store.create({ package: pkg(), scope: 'GLOBAL', origin: 'UI' })
      const selected = store.update({ skillId: skill.id, expectedVersion: 1, package: pkg('alpha', 'literal ç 漢字 ` ${x} $(cmd)\r\n'), origin: 'MCP' }).current
      const latest = store.update({ skillId: skill.id, expectedVersion: 2, package: pkg('alpha', '# latest'), origin: 'LOCAL_CLI' }).current
      const full = [latest, selected, skill.current]
      expect(store.history(skill.id)).toEqual(full)
      expect(store.history(skill.id, { metadataOnly: true })).toEqual(full.map(({ package: _, ...metadata }) => metadata))
      expect(store.history(skill.id, { version: 2 })).toEqual(selected)
      store.archive(skill.id, 3)
      expect(store.history(skill.id, { version: 2 })).toEqual(selected)
      expect(store.history(skill.id, { metadataOnly: true })).toHaveLength(3)
      expect(() => store.history(skill.id, { version: 4 })).toThrowError('VERSION_NOT_FOUND')
      expect(() => store.history('absent', { metadataOnly: true })).toThrowError('SKILL_NOT_FOUND')
      expect(() => store.history('absent', { version: 2 })).toThrowError('SKILL_NOT_FOUND')
    } finally { store.close() }
  })

  it('projects metadata in SQL and never materializes unselected version bodies', () => {
    const store = open()
    const db = (store as unknown as { db: Database.Database }).db
    const prepare = vi.spyOn(db, 'prepare')
    try {
      const skill = store.create({ package: pkg(), scope: 'GLOBAL', origin: 'UI' })
      store.update({ skillId: skill.id, expectedVersion: 1, package: pkg('alpha', 'unselected'), origin: 'MCP' })
      db.prepare('UPDATE academy_versions SET artifacts_json=? WHERE skill_id=? AND version=2').run('invalid JSON', skill.id)
      const changesBefore = db.prepare('SELECT total_changes() AS count').get()
      prepare.mockClear()
      expect(store.history(skill.id, { metadataOnly: true }).map(v => v.version)).toEqual([2, 1])
      const metadataSql = prepare.mock.calls.map(([sql]) => String(sql)).filter(sql => sql.includes('academy_versions'))
      expect(metadataSql).toHaveLength(1)
      expect(metadataSql[0]).not.toMatch(/\*|skill_md|artifacts_json/)
      prepare.mockClear()
      expect(store.history(skill.id, { version: 1 })).toEqual(skill.current)
      const selectedSql = prepare.mock.calls.map(([sql]) => String(sql)).filter(sql => sql.includes('academy_versions'))
      expect(selectedSql).toEqual(['SELECT * FROM academy_versions WHERE skill_id=? AND version=?'])
      expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(changesBefore)
      expect(() => store.history(skill.id)).toThrow()
    } finally { prepare.mockRestore(); store.close() }
  })
  it('migrates legacy distribution states atomically and preserves indexes, foreign keys and restart persistence', () => {
    const store = open()
    const path = store.databasePath
    const skill = store.create({ package: pkg(), scope: 'GLOBAL', origin: 'UI' })
    const destination = store.upsertDestination('C:/legacy-project', 'legacy')
    const state = { skillId: skill.id, destinationId: destination.id, target: 'CLAUDE_CODE' as const, canonicalVersion: 1, canonicalHash: skill.current.packageHash, distributedVersion: 1, distributedHash: skill.current.packageHash, status: 'CURRENT' as const, errorCode: null, errorMessage: null, exposureName: skill.name, linkMechanism: 'JUNCTION' as const }
    store.setDistributionState(state)
    const before = store.listDistributionStates()
    store.close()
    const legacy = new Database(path)
    const schema = legacy.prepare("SELECT sql FROM sqlite_master WHERE name='academy_distribution_states'").get() as { sql: string }
    legacy.exec(schema.sql.replace('academy_distribution_states', 'legacy_states').replace(",'ANTIGRAVITY'", ''))
    legacy.exec('INSERT INTO legacy_states SELECT * FROM academy_distribution_states; DROP TABLE academy_distribution_states; ALTER TABLE legacy_states RENAME TO academy_distribution_states; CREATE INDEX distribution_status ON academy_distribution_states(status)')
    legacy.close()
    const migrated = new AcademyStore(path)
    expect(migrated.listDistributionStates()).toEqual(before)
    migrated.setDistributionState({ ...state, target: 'ANTIGRAVITY' })
    const after = migrated.listDistributionStates()
    migrated.close()
    const reopened = new AcademyStore(path)
    expect(reopened.listDistributionStates()).toEqual(after)
    reopened.close()
    const database = new Database(path)
    expect(database.pragma('foreign_key_check')).toEqual([])
    expect(database.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name='distribution_status'").get()).toEqual({ name: 'distribution_status' })
    database.pragma('foreign_keys = ON')
    expect(() => database.prepare("UPDATE academy_distribution_states SET skill_id='missing'").run()).toThrow()
    database.close()
  })
  it('creates immutable versions and survives reopen', () => {
    const store = open()
    const dbPath = store.databasePath
    const created = store.create({ package: pkg(), scope: 'GLOBAL', origin: 'UI' })
    const updated = store.update({ skillId: created.id, expectedVersion: 1, package: pkg('alpha', '# V2'), origin: 'MCP' })
    expect(updated.currentVersion).toBe(2)
    expect(store.history(created.id).map((item) => [item.version, item.origin])).toEqual([[2, 'MCP'], [1, 'UI']])
    expect(store.history(created.id)[1].package).toEqual(pkg())
    store.close()
    const reopened = new AcademyStore(dbPath)
    expect(reopened.get(created.id).current.package.skillMd).toContain('# V2')
    expect(reopened.get(created.id).current.package.artifacts['references/guide.md']).toBe('Olá β')
    reopened.close()
  })

  it('enforces active names, optimistic concurrency and archive/restore', () => {
    const store = open()
    const first = store.create({ package: pkg(), scope: 'GLOBAL', origin: 'UI' })
    expect(() => store.create({ package: pkg(), scope: 'GLOBAL', origin: 'UI' })).toThrowError(/already exists/)
    expect(() => store.update({ skillId: first.id, expectedVersion: 0, package: pkg(), origin: 'UI' })).toThrowError(/changed since/)
    expect(store.archive(first.id, 1).status).toBe('ARCHIVED')
    const replacement = store.create({ package: pkg(), scope: 'GLOBAL', origin: 'UI' })
    expect(() => store.restore(first.id, 1)).toThrow()
    store.archive(replacement.id, 1)
    expect(store.restore(first.id, 1).status).toBe('ACTIVE')
    store.close()
  })

  it('rolls back create atomically when project association is invalid', () => {
    const store = open()
    expect(() => store.create({ package: pkg(), scope: 'PROJECT', projectIds: ['missing'], origin: 'UI' })).toThrowError(/Unknown destination/)
    expect(store.list()).toEqual([])
    store.close()
  })

  it('persists destinations, projections and conflicts', () => {
    const store = open()
    const destination = store.upsertDestination('C:/repo', 'repo')
    const skill = store.create({ package: pkg(), scope: 'PROJECT', projectIds: [destination.id], origin: 'IMPORT' })
    expect(store.isAssigned(skill.id, destination.id)).toBe(true)
    store.setProjection(skill.id, destination.id, 1, skill.current.packageHash, skill.name)
    expect(store.getProjection(skill.id, destination.id)).toEqual({ version: 1, packageHash: skill.current.packageHash, skillName: skill.name })
    const conflict = store.createConflict(skill.id, 'FILESYSTEM', 1, pkg('alpha', '# local'), 'hash', destination.id, 'C:/repo/.skills/alpha')
    expect(store.listConflicts()[0].id).toBe(conflict.id)
    store.resolveConflict(conflict.id)
    expect(store.listConflicts()).toEqual([])
    store.close()
  })

  it('persists Academy Git profile and survives reopen', () => {
    const store = open()
    const dbPath = store.databasePath
    expect(store.getGitProfile()).toBeNull()

    const saved = store.saveGitProfile({
      repositoryCatalogId: 'catalog-123',
      githubRepositoryId: 'gh-456',
      branch: 'main',
      lastSnapshotHash: null,
      lastCommitSha: null,
      lastPushedCommitSha: null,
      syncState: 'SYNCED',
      lastError: null
    })
    expect(saved.repositoryCatalogId).toBe('catalog-123')
    expect(saved.githubRepositoryId).toBe('gh-456')
    expect(saved.syncState).toBe('SYNCED')

    store.updateGitSyncState({
      syncState: 'DIRTY',
      lastSnapshotHash: 'hash-abc',
      lastCommitSha: 'sha-123',
      lastPushedCommitSha: 'sha-123'
    })

    store.close()

    const reopened = new AcademyStore(dbPath)
    const profile = reopened.getGitProfile()
    expect(profile).not.toBeNull()
    expect(profile?.repositoryCatalogId).toBe('catalog-123')
    expect(profile?.githubRepositoryId).toBe('gh-456')
    expect(profile?.branch).toBe('main')
    expect(profile?.lastSnapshotHash).toBe('hash-abc')
    expect(profile?.lastCommitSha).toBe('sha-123')
    expect(profile?.lastPushedCommitSha).toBe('sha-123')
    expect(profile?.syncState).toBe('DIRTY')
    reopened.close()
  })
})

