// @vitest-environment node
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createRepositoryModel, type RepositoryModel } from './repository-model'
import { cleanupTempRepo, createTempRepo } from './test-helpers'

describe('Context Reference lifecycle', () => {
  let repoPath: string | null = null
  let model: RepositoryModel | null = null

  afterEach(async () => {
    model?.close()
    model = null
    if (repoPath) await cleanupTempRepo(repoPath)
    repoPath = null
  })

  it('preserves identity across edits and safe moves, then retires it on deletion', async () => {
    repoPath = createTempRepo()
    const write = (relativePath: string, content: string): void => {
      const fullPath = join(repoPath!, relativePath)
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, content, 'utf8')
    }

    write('src/original.ts', 'export const value = 1\n')
    model = createRepositoryModel(repoPath)
    await model.indexRepository()

    const initial = model.getFiles()[0]
    expect(initial.contextReference).toMatch(/^[0-9a-z]+$/)

    write('src/original.ts', 'export const value = 2\n')
    await model.updateFileContent('src/original.ts')
    expect(model.getFiles()[0]).toMatchObject({
      id: initial.id,
      contextReference: initial.contextReference
    })

    mkdirSync(join(repoPath, 'src/moved'), { recursive: true })
    renameSync(join(repoPath, 'src/original.ts'), join(repoPath, 'src/moved/renamed.ts'))
    await model.reconcileWithDisk({ indexUnexpected: true })
    expect(model.getFiles()).toEqual([
      expect.objectContaining({
        id: initial.id,
        relativePath: 'src/moved/renamed.ts',
        contextReference: initial.contextReference
      })
    ])

    model.close()
    model = createRepositoryModel(repoPath)
    expect(model.getFiles()[0].contextReference).toBe(initial.contextReference)
    expect(await model.backfillContextReferences()).toBe(0)

    unlinkSync(join(repoPath, 'src/moved/renamed.ts'))
    await model.reconcileWithDisk({ indexUnexpected: true })
    expect(model.getFiles()).toHaveLength(0)

    write('src/replacement.ts', 'export const value = 3\n')
    await model.updateFileContent('src/replacement.ts')
    const replacement = model.getFiles()[0]
    expect(replacement.contextReference).not.toBe(initial.contextReference)
    expect(new Set(model.getFiles().map((file) => file.contextReference)).size).toBe(model.getFiles().length)
  })

  it('migrates and backfills a legacy index without reindexing it', async () => {
    repoPath = createTempRepo()
    mkdirSync(join(repoPath, 'code_awareness'), { recursive: true })
    const normalizedPath = repoPath.replace(/\\/g, '/').replace(/\/$/, '')
    const repositoryId = createHash('sha256').update(normalizedPath).digest('hex').substring(0, 16)
    const legacy = new Database(join(repoPath, 'code_awareness/repository_model.db'))
    legacy.exec(`
      CREATE TABLE repositories (
        id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        model_version INTEGER NOT NULL DEFAULT 1, last_indexed_at TEXT
      );
      CREATE TABLE files (
        id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, relative_path TEXT NOT NULL,
        language TEXT NOT NULL, extension TEXT NOT NULL, lines INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL, mtime INTEGER NOT NULL, status TEXT NOT NULL,
        UNIQUE(repository_id, relative_path)
      );
      INSERT INTO repositories VALUES ('${repositoryId}', '${normalizedPath.replace(/'/g, "''")}', 'legacy', 1, '2026-01-01');
      INSERT INTO files VALUES ('legacy-file', '${repositoryId}', 'src/legacy.ts', 'typescript', '.ts', 1, 10, 1, 'indexed');
    `)
    legacy.close()

    model = createRepositoryModel(repoPath)
    expect(model.getFiles()[0]).toMatchObject({ id: 'legacy-file', contextReference: null })
    expect(await model.backfillContextReferences()).toBe(1)
    const reference = model.getFiles()[0].contextReference
    expect(reference).toMatch(/^[0-9a-z]+$/)

    model.close()
    model = createRepositoryModel(repoPath)
    expect(model.getFiles()[0]).toMatchObject({ id: 'legacy-file', contextReference: reference })
  })
})
