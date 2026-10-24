import Database from 'better-sqlite3'
import * as io from 'fs/promises'
import { mkdirSync, renameSync, unlinkSync, utimesSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRepositoryModel, type RepositoryModel } from './repository-model'
import { createRepositoryDatabase } from './repository-database'
import { createTempRepo, cleanupTempRepo } from './test-helpers'
import { createTempGitRepo } from './git-test-helpers'
import { RepositoryFileMembership } from './repository-file-membership'
import { GitService } from './git-service'
import { TypeScriptStructureExtractor } from './extraction/typescript-extractor'
import { telemetryService, type TelemetryEntry } from './telemetry-service'
import type { CodeMapWorkMetrics } from './codemap-work-metrics'

vi.mock('fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('fs/promises')>() }))

describe('Code Map U3 — measured disk reconciliation in Windows Electron/SQLite', () => {
  let root = ''
  let model: RepositoryModel
  let sql: Database.Database | undefined
  let unsubscribe: (() => void) | undefined
  const entries: TelemetryEntry[] = []
  const write = (path: string, text: string | Buffer) => writeFileSync(join(root, path), text)
  const summary = (event = 'RECONCILE_COMPLETED') => entries.filter(entry => entry.event === event).at(-1)!.payload as CodeMapWorkMetrics & { skipReason: string | null }

  afterEach(async () => {
    unsubscribe?.(); sql?.close(); model?.close(); vi.restoreAllMocks()
    if (root) await cleanupTempRepo(root)
    root = ''; sql = undefined; entries.length = 0
  })

  async function fixture(git = false) {
    root = git ? await createTempGitRepo() : createTempRepo()
    write('target.ts', 'export function execute() { return 1 }\n')
    write('source.ts', "import { execute } from './target'\nexport function run() { return execute() }\n")
    write('notes.md', '# Original\n')
    model = createRepositoryModel(root, undefined, git ? new RepositoryFileMembership(root, new GitService()) : undefined)
    unsubscribe = telemetryService.subscribe(entry => entries.push(entry))
    await model.indexRepository()
  }

  async function synchronize() {
    const result = await model.reconcileWithDisk({ indexUnexpected: true })
    const paths = [...(result.pendingPaths ?? []), ...model.getModifiedFiles().map(file => file.relativePath), ...model.getPendingFilePaths()]
    const batch = await model.updateFileContents(paths)
    expect(batch.errors).toEqual([])
    await model.backfillSymbolReferences()
    return result
  }

  it('reopens twice with one stat per file, zero source reads/hashes/extractions and zero graph/symbol rewrites', async () => {
    await fixture()
    const files = model.getFiles(), elements = model.getElementsByRepository(), relations = model.getRelationships()
    sql = new Database(join(root, 'code_awareness/repository_model.db'))
    sql.exec(`CREATE TABLE audit (value TEXT);
      CREATE TRIGGER audit_s_i AFTER INSERT ON symbol_references BEGIN INSERT INTO audit VALUES ('symbol'); END;
      CREATE TRIGGER audit_s_d AFTER DELETE ON symbol_references BEGIN INSERT INTO audit VALUES ('symbol'); END;
      CREATE TRIGGER audit_r_i AFTER INSERT ON relationships BEGIN INSERT INTO audit VALUES ('relationship'); END;
      CREATE TRIGGER audit_r_d AFTER DELETE ON relationships BEGIN INSERT INTO audit VALUES ('relationship'); END;`)
    const open = vi.spyOn(io, 'open'), read = vi.spyOn(io, 'readFile'), stats = vi.spyOn(io, 'stat')
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    for (let i = 0; i < 2; i++) {
      model.close(); model = createRepositoryModel(root)
      open.mockClear(); read.mockClear(); stats.mockClear()
      await synchronize()
      expect(open).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      expect(stats).toHaveBeenCalledTimes(files.length)
      expect(summary()).toMatchObject({ filesVisited: files.length, filesStatChecked: files.length, metadataReused: files.length,
        contentReads: 0, hashesCalculated: 0, filesExtracted: 0, relationshipResolutions: 0,
        symbolSourcesResolved: 0, symbolRowsWritten: 0, skipReason: 'PERSISTED_DISK_METADATA_CURRENT' })
      expect(model.getFiles()).toEqual(files)
      expect(model.getElementsByRepository()).toEqual(elements)
      expect(model.getRelationships()).toEqual(relations)
    }
    expect(extract).not.toHaveBeenCalled()
    expect(sql.prepare('SELECT * FROM audit').all()).toEqual([])
    const target = elements.find(element => element.name === 'execute' && element.kind === 'function')!
    expect(model.getSymbolReferencesByTargetElement(target.id)).toHaveLength(1)
    expect((await model.getElementExactSource(target.id))?.content).toContain('return 1')
  })

  it('detects an offline same-size change even with restored mtime, then reuses the new snapshot', async () => {
    await fixture()
    const previous = statSync(join(root, 'target.ts'))
    write('target.ts', 'export function execute() { return 2 }\n')
    utimesSync(join(root, 'target.ts'), previous.atime, previous.mtime)
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    expect((await synchronize()).markedModified).toBe(1)
    expect(extract).toHaveBeenCalledTimes(1)
    expect(summary('FILE_BATCH_COMPLETED')).toMatchObject({ filesExtracted: 1, relationshipResolutions: 1 })
    expect(summary('FILE_BATCH_COMPLETED').symbolSourcesResolved).toBeGreaterThan(0)
    expect(model.getSyncStatus().modifiedFiles).toBe(0)
    await synchronize()
    expect(summary().contentReads).toBe(0)
    expect(summary().hashesCalculated).toBe(0)
  })

  it('preserves rename identity, repairs deletions and imports, and discovers new offline files as one batch', async () => {
    await fixture()
    const targetId = model.getFileByRelativePath('target.ts')!.id
    renameSync(join(root, 'target.ts'), join(root, 'renamed.ts'))
    write('source.ts', "import { execute } from './renamed'\nexport function run() { return execute() }\n")
    unlinkSync(join(root, 'notes.md'))
    write('new.ts', "import { execute } from './renamed'\nexport function added() { return execute() }\n")
    await synchronize()
    expect(model.getFileByRelativePath('renamed.ts')!.id).toBe(targetId)
    expect(model.getFileByRelativePath('notes.md')).toBeNull()
    const target = model.getElementsByRepository().find(element => element.name === 'execute' && element.kind === 'function')!
    expect(model.getSymbolReferencesByTargetElement(target.id)).toHaveLength(2)
    expect(summary('FILE_BATCH_COMPLETED').relationshipResolutions).toBe(1)
    sql = new Database(join(root, 'code_awareness/repository_model.db'))
    expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('re-evaluates root/nested Git ignores in one batch with shared stat and eligibility, including unignore', async () => {
    await fixture(true)
    mkdirSync(join(root, 'nested'))
    write('nested/keep.ts', 'export const nested = 1\n')
    await synchronize()
    write('.gitignore', 'notes.md\n')
    write('nested/.gitignore', 'keep.ts\n')
    const checks = vi.spyOn(GitService.prototype, 'checkIgnoreBatch')
    const stats = vi.spyOn(io, 'stat')
    await synchronize()
    expect(checks.mock.calls.filter(([path, paths]) => path === root.replace(/\\/g, '/') && paths.includes('source.ts'))).toHaveLength(1)
    expect(model.getFileByRelativePath('notes.md')).toBeNull()
    expect(model.getFileByRelativePath('nested/keep.ts')).toBeNull()
    expect(stats.mock.calls.filter(([path]) => String(path).endsWith('source.ts'))).toHaveLength(1)
    write('.gitignore', '')
    write('nested/.gitignore', '')
    await synchronize()
    expect(model.getFileByRelativePath('notes.md')).not.toBeNull()
    expect(model.getFileByRelativePath('nested/keep.ts')).not.toBeNull()
    await synchronize()
    expect(summary().contentReads).toBe(0)
  }, 20000)

  it.each([false, true])('honors nested filesystem ignores without Git and detects eligibility changes (membership=%s)', async membership => {
    await fixture()
    if (membership) {
      model.close()
      model = createRepositoryModel(root, undefined, new RepositoryFileMembership(root, new GitService()))
    }
    mkdirSync(join(root, 'nested'))
    write('nested/.gitignore', '*.ts\n')
    write('nested/hidden.ts', 'export const hidden = 1\n')
    write('notes.md', Buffer.from([0, 1, 2]))
    await synchronize()
    expect(model.getFileByRelativePath('notes.md')).toBeNull()
    expect(model.getFileByRelativePath('nested/hidden.ts')).toBeNull()
    write('nested/.gitignore', '')
    write('notes.md', '# Restored\n')
    await synchronize()
    expect(model.getFileByRelativePath('notes.md')).not.toBeNull()
    expect(model.getFileByRelativePath('nested/hidden.ts')).not.toBeNull()
    write('notes.md', 'x'.repeat(2 * 1024 * 1024 + 1))
    await synchronize()
    expect(model.getFileByRelativePath('notes.md')).toBeNull()
    write('.gitignore', 'nested/\n')
    write('nested/.gitignore', '!hidden.ts\n')
    await synchronize()
    expect(model.getFileByRelativePath('nested/hidden.ts')).toBeNull()
  })

  it('does not treat denied sampling or directory discovery as deletion or successful reconciliation', async () => {
    await fixture()
    const before = model.getFiles()
    write('target.ts', 'export function execute() { return 20 }\n')
    const open = vi.spyOn(io, 'open').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(model.reconcileWithDisk({ indexUnexpected: true })).rejects.toThrow('denied')
    expect(model.getFiles()).toEqual(before)
    expect(entries.at(-1)?.event).toBe('RECONCILE_FAILED')
    open.mockRestore()
    const dirs = vi.spyOn(io, 'readdir').mockRejectedValueOnce(Object.assign(new Error('directory denied'), { code: 'EACCES' }))
    await expect(model.reconcileWithDisk({ indexUnexpected: true })).rejects.toThrow('directory denied')
    expect(model.getFiles()).toEqual(before)
    dirs.mockRestore()
    await synchronize()
    expect(model.getSyncStatus().modifiedFiles).toBe(0)
  })

  it('retains dirty recovery when full verification fails, and does not accept a mixed read/stat observation', async () => {
    await fixture()
    const originalRead = io.readFile
    write('target.ts', 'export function execute() { return 10 }\n')
    const read = vi.spyOn(io, 'readFile').mockImplementationOnce(async () => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }) })
    await expect(model.reconcileWithDisk({ indexUnexpected: true })).rejects.toThrow('RECONCILE_READ_FAILED')
    expect(model.getModifiedFiles().map(file => file.relativePath)).toContain('target.ts')
    read.mockRestore()
    await synchronize()
    write('target.ts', 'export function execute() { return 11 }\n')
    const race = vi.spyOn(io, 'readFile').mockImplementationOnce(async (...args: Parameters<typeof io.readFile>) => {
      const bytes = await originalRead(...args)
      write('target.ts', 'export function execute() { return 12 }\n')
      return bytes
    })
    const result = await model.reconcileWithDisk({ indexUnexpected: true })
    expect(result.markedModified).toBe(1)
    race.mockRestore()
    await synchronize()
    expect((await model.getFileContent('target.ts'))?.content).toContain('return 12')
  })

  it('warms legacy metadata only once without extraction or graph resolution', async () => {
    await fixture()
    sql = new Database(join(root, 'code_awareness/repository_model.db'))
    sql.exec("DELETE FROM projection_checkpoints WHERE phase='DISK_METADATA'")
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    await synchronize()
    expect(summary().hashesCalculated).toBe(3)
    expect(extract).not.toHaveBeenCalled()
    await synchronize()
    expect(summary().contentReads).toBe(0)
    expect(summary().relationshipResolutions).toBe(0)
    expect(createRepositoryDatabase(root).getPendingFileChanges(model.getRepositoryId())).toEqual([])
  })

  it('does not interpret a failed Git ignore query as an empty ignore set', async () => {
    await fixture()
    const git = new GitService()
    await expect(git.checkIgnoreBatch(root, ['target.ts'], { strict: true })).rejects.toThrow('GIT_CHECK_IGNORE_FAILED')
    await expect(git.checkIgnoreBatch(root, ['target.ts'])).resolves.toEqual(new Set())
    model.close()
    model = createRepositoryModel(root, undefined, new RepositoryFileMembership(root, {
      async isGitRepository() { return true },
      checkIgnoreBatch: (path, paths, options) => git.checkIgnoreBatch(path, paths, options)
    }))
    const before = model.getFiles()
    await expect(model.reconcileWithDisk({ indexUnexpected: true })).rejects.toThrow('GIT_CHECK_IGNORE_FAILED')
    expect(model.getFiles()).toEqual(before)
    expect(entries.at(-1)?.event).toBe('RECONCILE_FAILED')
  })
})
