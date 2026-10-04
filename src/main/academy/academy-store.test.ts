import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AcademyStore } from './academy-store'

const roots: string[] = []
const pkg = (name = 'alpha', body = '# Alpha') => ({ skillMd: `---\nname: ${name}\ndescription: Skill ${name}\n---\n\n${body}\n`, artifacts: { 'references/guide.md': 'Olá β' } })
const open = () => {
  const root = mkdtempSync(join(tmpdir(), 'academy-store-'))
  roots.push(root)
  return new AcademyStore(join(root, 'academy.db'))
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('AcademyStore', () => {
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

