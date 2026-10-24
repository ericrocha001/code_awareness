import Database from 'better-sqlite3'
import { buildSync } from 'esbuild'
import { execFileSync } from 'child_process'
import { writeFileSync, unlinkSync, renameSync } from 'fs'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRepositoryModel, RepositoryModel } from './repository-model'
import type { SymbolReferenceFile } from './symbol-reference-resolver'

interface ProjectionInternals {
  buildSymbolResolutionSnapshot(): SymbolReferenceFile[]
  refreshSymbolReferences(sources: ReadonlySet<string>, correlationId: string, factsRegenerated?: number): Promise<number>
}
import { createRepositoryDatabase } from './repository-database'
import { RepositorySynchronizer } from './repository-synchronizer'
import { RelationshipResolver } from './relationship-resolver'
import { TypeScriptStructureExtractor } from './extraction/typescript-extractor'
import { CssStructureExtractor } from './extraction/css-extractor'
import { repositoryEventBus } from './repository-events'
import { cleanupTempRepo, createTempRepo } from './test-helpers'

describe('Code Map U2 — coherent batches and selective projections', () => {
  let root = ''
  let model: RepositoryModel
  let sync: RepositorySynchronizer | undefined
  let sql: Database.Database
  const write = (path: string, content: string) => writeFileSync(join(root, path), content)
  const db = () => createRepositoryDatabase(root)
  const references = (path: string) => model.getSymbolReferencesBySourceFile(model.getFileByRelativePath(path)!.id)
  const assertIntegrity = () => {
    expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(sql.prepare(`SELECT r.id FROM relationships r WHERE
      (r.source_kind='file' AND NOT EXISTS(SELECT 1 FROM files f WHERE f.id=r.source_id)) OR
      (r.source_kind='element' AND NOT EXISTS(SELECT 1 FROM elements e WHERE e.id=r.source_id)) OR
      (r.target_kind='file' AND NOT EXISTS(SELECT 1 FROM files f WHERE f.id=r.target_id)) OR
      (r.target_kind='element' AND NOT EXISTS(SELECT 1 FROM elements e WHERE e.id=r.target_id))`).all()).toEqual([])
  }

  afterEach(async () => {
    sync?.dispose(); await sync?.awaitDisposed()
    model?.close(); sql?.close(); vi.restoreAllMocks()
    repositoryEventBus.removeAllListeners('file:indexed')
    if (root) await cleanupTempRepo(root)
    sync = undefined
  })

  async function fixture() {
    root = createTempRepo()
    write('target.ts', 'export class Base { work() { return 1 } }\nexport function execute() { return 1 }\n')
    write('source.ts', "import { Base, execute } from './target'\nexport class Derived extends Base { run() { return execute() } }\n")
    write('other-target.ts', 'export function standalone() { return 2 }\n')
    write('other-source.ts', "import { standalone } from './other-target'\nexport function quiet() { return standalone() }\n")
    model = createRepositoryModel(root)
    await model.indexRepository()
    sql = new Database(join(root, 'code_awareness/repository_model.db'))
    sql.exec(`CREATE TABLE audit (source TEXT, projection TEXT);
      CREATE TRIGGER audit_symbols_delete AFTER DELETE ON symbol_references BEGIN INSERT INTO audit VALUES (OLD.source_file_id,'SYMBOLS'); END;
      CREATE TRIGGER audit_symbols_insert AFTER INSERT ON symbol_references BEGIN INSERT INTO audit VALUES (NEW.source_file_id,'SYMBOLS'); END;
      CREATE TRIGGER audit_rel_delete AFTER DELETE ON relationships BEGIN INSERT INTO audit VALUES (OLD.source_id,'RELATIONSHIPS'); END;
      CREATE TRIGGER audit_rel_insert AFTER INSERT ON relationships BEGIN INSERT INTO audit VALUES (NEW.source_id,'RELATIONSHIPS'); END;`)
  }

  it('extracts three changed files once, resolves one graph/symbol snapshot and leaves an unrelated subgraph untouched', async () => {
    await fixture()
    write('target.ts', 'export class Base { work() { return 3 } }\nexport function replacement() { return 3 }\n')
    write('source.ts', "import { Base, replacement } from './target'\nexport class Derived extends Base { run() { return replacement() } }\n")
    write('new.ts', "import { replacement } from './target'\nexport function added() { return replacement() }\n")
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    const graph = vi.spyOn(RelationshipResolver.prototype, 'resolve')
    const snapshot = vi.spyOn(model as unknown as ProjectionInternals, 'buildSymbolResolutionSnapshot')
    const unrelated = model.getFileByRelativePath('other-source.ts')!
    const unrelatedElements = model.getElementsByFile(unrelated.id).map(element => element.id)
    const result = await model.updateFileContents(['target.ts', 'source.ts', 'new.ts', 'source.ts'])
    expect(result.errors).toEqual([])
    expect(extract).toHaveBeenCalledTimes(3)
    expect(graph).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(references('source.ts').some(reference => model.getElementsByRepository().find(element => element.id === reference.targetElementId)?.name === 'replacement')).toBe(true)
    expect(references('new.ts')).toHaveLength(1)
    expect(sql.prepare("SELECT COUNT(*) AS n FROM audit WHERE projection='SYMBOLS' AND source=?").get(unrelated.id)).toEqual({ n: 0 })
    for (const id of unrelatedElements) expect(sql.prepare("SELECT COUNT(*) AS n FROM audit WHERE projection='RELATIONSHIPS' AND source=?").get(id)).toEqual({ n: 0 })
    expect(model.getPendingFilePaths()).toEqual([])
    assertIntegrity()
  })

  it('replaces obsolete imports, extends and implements without leaving old edges', async () => {
    await fixture()
    write('contracts.ts', 'export interface One {}\nexport interface Two {}\nexport class Other {}\n')
    write('source.ts', "import { Base } from './target'\nimport { One } from './contracts'\nexport class Derived extends Base implements One {}\n")
    await model.updateFileContents(['contracts.ts', 'source.ts'])
    const oldBase = model.getElementsByRepository().find(element => element.name === 'Base' && element.kind === 'class')!
    const oldOne = model.getElementsByRepository().find(element => element.name === 'One')!
    write('source.ts', "import { Other, Two } from './contracts'\nexport class Derived extends Other implements Two {}\n")
    await model.updateFileContents(['source.ts'])
    expect(model.getRelationships().some(relation => relation.targetId === oldBase.id && relation.type === 'extends')).toBe(false)
    expect(model.getRelationships().some(relation => relation.targetId === oldOne.id && relation.type === 'implements')).toBe(false)
    expect(model.getRelationships().filter(relation => relation.type === 'extends' || relation.type === 'implements')).toHaveLength(2)
    assertIntegrity()
  })

  it('updates existing unresolved importers when a file is created, and removes their references when it is deleted', async () => {
    await fixture()
    write('source.ts', "import { later } from './later'\nexport function use() { return later() }\n")
    await model.updateFileContents(['source.ts'])
    expect(references('source.ts')).toEqual([])
    write('later.ts', 'export function later() { return 4 }\n')
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    await model.updateFileContents(['later.ts'])
    expect(extract).toHaveBeenCalledTimes(1)
    expect(references('source.ts')).toHaveLength(1)
    unlinkSync(join(root, 'later.ts'))
    await model.updateFileContents(['later.ts'])
    expect(references('source.ts')).toEqual([])
    expect(model.getFileByRelativePath('later.ts')).toBeNull()
    assertIntegrity()
  })

  it('preserves recognized rename identity and updates both old and new importers through offline reconciliation', async () => {
    await fixture()
    const original = model.getFileByRelativePath('target.ts')!
    renameSync(join(root, 'target.ts'), join(root, 'renamed.ts'))
    write('new-user.ts', "import { execute } from './renamed'\nexport function use() { return execute() }\n")
    const reconcile = await model.reconcileWithDisk({ indexUnexpected: true })
    sync = new RepositorySynchronizer(model, model.getRepositoryId())
    sync.reconcileMemoryWithDatabase(reconcile.pendingPaths)
    expect((await sync.synchronizeModified()).errors).toEqual([])
    expect(model.getFileByRelativePath('renamed.ts')?.id).toBe(original.id)
    expect(references('source.ts').some(reference => model.getElementsByRepository().find(element => element.id === reference.targetElementId)?.name === 'execute')).toBe(false)
    expect(references('new-user.ts')).toHaveLength(1)
    assertIntegrity()
  })

  it('repairs importers after reconciliation has already removed their target', async () => {
    await fixture()
    expect(references('source.ts').length).toBeGreaterThan(0)
    unlinkSync(join(root, 'target.ts'))
    const reconcile = await model.reconcileWithDisk({ indexUnexpected: true })
    expect(model.getPendingFilePaths()).toContain('target.ts')
    sync = new RepositorySynchronizer(model, model.getRepositoryId())
    sync.reconcileMemoryWithDatabase(reconcile.pendingPaths)
    await sync.synchronizeModified()
    expect(references('source.ts')).toEqual([])
    expect(model.getPendingFilePaths()).toEqual([])
    assertIntegrity()
  })

  it('expands ambiguous hierarchy dependencies conservatively on addition and removal', async () => {
    await fixture()
    write('source.ts', 'export class Derived extends Base {}\n')
    await model.updateFileContents(['source.ts'])
    expect(model.getRelationships().some(relation => relation.type === 'extends')).toBe(true)
    write('duplicate.ts', 'export class Base {}\n')
    await model.updateFileContents(['duplicate.ts'])
    expect(model.getRelationships().some(relation => relation.type === 'extends')).toBe(false)
    unlinkSync(join(root, 'duplicate.ts'))
    await model.reconcileWithDisk()
    sync = new RepositorySynchronizer(model, model.getRepositoryId())
    await sync.synchronizeModified()
    expect(model.getRelationships().some(relation => relation.type === 'extends')).toBe(true)
    assertIntegrity()
  })

  it('serializes overlapping synchronization without duplicate extraction or file:indexed events', async () => {
    await fixture()
    sync = new RepositorySynchronizer(model, model.getRepositoryId())
    write('target.ts', 'export class Base { work() { return 9 } }\nexport function execute() { return 9 }\n')
    model.markFileModified('target.ts')
    sync.reloadModifiedFilesFromDatabase()
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    const events: string[] = []
    repositoryEventBus.onFileIndexed(event => events.push(event.relativePath))
    await Promise.all([sync.synchronizeModified(), sync.synchronizeModified()])
    expect(extract).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['target.ts'])
    expect(sync.getModifiedFilesCount()).toBe(0)
    expect(model.readiness.getState()).toBe('READY')
    assertIntegrity()
  })

  it('restores CSS imports on create/delete/recreate without re-extracting the importer or leaving orphan edges', async () => {
    await fixture()
    write('entry.css', "@import './later.css';\nbody { color: red; }\n")
    await model.updateFileContents(['entry.css'])
    expect(model.getRelationships().filter(relation => relation.sourceKind === 'file')).toEqual([])
    assertIntegrity()
    const extract = vi.spyOn(CssStructureExtractor.prototype, 'extract')
    for (const operation of ['create', 'delete', 'recreate']) {
      if (operation === 'delete') unlinkSync(join(root, 'later.css'))
      else write('later.css', 'body { color: blue; }\n')
      await model.updateFileContents(['later.css'])
      expect(model.getRelationships().filter(relation => relation.sourceKind === 'file')).toHaveLength(operation === 'delete' ? 0 : 1)
      assertIntegrity()
    }
    expect(extract.mock.calls.some(([input]) => input.relativePath === 'entry.css')).toBe(false)
  })

  it('migrates legacy CSS facts once before deletion and reuses their dependency across reopen', async () => {
    await fixture()
    write('entry.css', "@import './later.css';\n")
    write('later.css', 'body { color: red; }\n')
    await model.updateFileContents(['entry.css', 'later.css'])
    const source = model.getFileByRelativePath('entry.css')!
    const row = sql.prepare('SELECT payload FROM symbol_resolution_facts WHERE file_id=?').get(source.id) as { payload: string }
    const facts = JSON.parse(row.payload); delete facts.fileImportTargets
    sql.prepare('UPDATE symbol_resolution_facts SET payload=? WHERE file_id=?').run(JSON.stringify(facts), source.id)
    db().finishProjection(model.getRepositoryId(), source.id, 'FACTS', 'structure-1')
    sql.exec("DELETE FROM projection_checkpoints WHERE scope='@schema' AND phase='file-import-facts'")
    model.close(); model = createRepositoryModel(root)
    const extract = vi.spyOn(CssStructureExtractor.prototype, 'extract')
    unlinkSync(join(root, 'later.css'))
    await model.reconcileWithDisk()
    sync = new RepositorySynchronizer(model, model.getRepositoryId())
    await sync.synchronizeModified()
    write('later.css', 'body { color: green; }\n')
    await model.updateFileContents(['later.css'])
    expect(model.getRelationships().some(relation => relation.sourceId === source.id && relation.type === 'imports')).toBe(true)
    expect(extract.mock.calls.some(([input]) => input.relativePath === 'entry.css')).toBe(false)
    assertIntegrity()
  })

  it('keeps distinct IDs when an old path is recreated after a recognized rename, including explicit rebuild', async () => {
    await fixture()
    const previous = model.getFileByRelativePath('target.ts')!
    renameSync(join(root, 'target.ts'), join(root, 'renamed.ts'))
    const result = await model.reconcileWithDisk({ indexUnexpected: true })
    sync = new RepositorySynchronizer(model, model.getRepositoryId())
    sync.reconcileMemoryWithDatabase(result.pendingPaths)
    await sync.synchronizeModified()
    write('target.ts', 'export function execute() { return 99 }\n')
    await model.updateFileContents(['target.ts'])
    const recreated = model.getFileByRelativePath('target.ts')!
    expect(recreated.id).not.toBe(previous.id)
    expect(model.getFileByRelativePath('renamed.ts')?.id).toBe(previous.id)
    expect(references('source.ts').some(reference => model.getElementsByFile(recreated.id).some(element => element.id === reference.targetElementId))).toBe(true)
    const ids = model.getFiles().map(file => [file.relativePath, file.id])
    await model.indexRepository()
    expect(model.getFiles().map(file => [file.relativePath, file.id])).toEqual(ids)
    assertIntegrity()
  })

  it('coalesces watcher changes into one projection pass and preserves per-path events', async () => {
    await fixture()
    sync = new RepositorySynchronizer(model, model.getRepositoryId())
    write('target.ts', 'export class Base {}\nexport function execute() { return 8 }\n')
    write('other-target.ts', 'export function standalone() { return 8 }\n')
    write('new.ts', 'export function added() { return 8 }\n')
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    const graph = vi.spyOn(RelationshipResolver.prototype, 'resolve')
    const snapshot = vi.spyOn(model as unknown as ProjectionInternals, 'buildSymbolResolutionSnapshot')
    const events: string[] = []
    repositoryEventBus.onFileIndexed(event => events.push(event.relativePath))
    for (const path of ['target.ts', 'other-target.ts', 'new.ts']) repositoryEventBus.emitFileModified(model.getRepositoryId(), path)
    await sync.waitForIdle()
    expect(extract).toHaveBeenCalledTimes(3)
    expect(graph).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(events.sort()).toEqual(['new.ts', 'other-target.ts', 'target.ts'])
    expect(model.readiness.getState()).toBe('READY')
    assertIntegrity()
  })

  it('resolves transitive importers without extracting them', async () => {
    await fixture()
    write('factory.ts', "import { Base } from './target'\nexport const instance = new Base()\n")
    write('consumer.ts', "import { instance } from './factory'\nexport function use() { return instance.work() }\n")
    await model.updateFileContents(['factory.ts', 'consumer.ts'])
    expect(references('consumer.ts').length).toBeGreaterThan(0)
    write('target.ts', 'export class Base { replacement() { return 1 } }\nexport function execute() { return 1 }\n')
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    await model.updateFileContents(['target.ts'])
    expect(extract).toHaveBeenCalledTimes(1)
    expect(references('consumer.ts').some(reference => model.getElementsByRepository().find(element => element.id === reference.targetElementId)?.name === 'work')).toBe(false)
    assertIntegrity()
  })

  it('retains a newer watcher revision arriving after structural commit while symbols are pending', async () => {
    await fixture()
    sync = new RepositorySynchronizer(model, model.getRepositoryId())
    write('target.ts', 'export class Base {}\nexport function execute() { return 10 }\n')
    model.markFileModified('target.ts')
    sync.reloadModifiedFilesFromDatabase()
    let release!: () => void, entered!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const internals = model as unknown as ProjectionInternals
    const original = internals.refreshSymbolReferences.bind(model)
    vi.spyOn(model as unknown as ProjectionInternals, 'refreshSymbolReferences').mockImplementationOnce(async (...args: Parameters<ProjectionInternals['refreshSymbolReferences']>) => { entered(); await hold; return original(...args) })
    const first = sync.synchronizeModified()
    await started
    write('target.ts', 'export class Base {}\nexport function execute() { return 11 }\n')
    const confirmed = new Promise<void>(resolve => {
      const listener = () => { repositoryEventBus.off('file:confirmed', listener); resolve() }
      repositoryEventBus.onFileConfirmed(listener)
    })
    repositoryEventBus.emitFileModified(model.getRepositoryId(), 'target.ts')
    await confirmed
    release()
    await first
    await sync.waitForIdle()
    expect(model.getPendingFilePaths()).toEqual([])
    const target = model.getElementsByRepository().find(element => element.name === 'execute' && element.kind === 'function')!
    expect((await model.getElementExactSource(target.id))?.content).toContain('return 11')
    expect(model.readiness.getState()).toBe('READY')
    assertIntegrity()
  })

  it('does not erase a newer failed intake when an older revision completes', async () => {
    await fixture()
    write('target.ts', 'export class Base {}\nexport function execute() { return 12 }\n')
    let release!: () => void, entered!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const internals = model as unknown as ProjectionInternals
    const original = internals.refreshSymbolReferences.bind(model)
    vi.spyOn(internals, 'refreshSymbolReferences').mockImplementationOnce(async (...args) => { entered(); await hold; return original(...args) })
    const first = model.updateFileContents(['target.ts'])
    await started
    db().enqueueFileChanges(model.getRepositoryId(), ['target.ts'])
    const newer = model.readiness.accept(0, 'target.ts')
    model.readiness.fail(newer, new Error('newer verification failed'))
    release(); await first
    expect(model.getPendingFilePaths()).toEqual(['target.ts'])
    expect(model.readiness.getState()).toBe('DEGRADED')
    await model.updateFileContents(['target.ts'])
    expect(model.getPendingFilePaths()).toEqual([])
    expect(model.readiness.getState()).toBe('READY')
  })

  it('retains a failed new path across reopen and recovers it without repeating successful extraction', async () => {
    await fixture()
    write('broken.ts', 'export function repair() { return 1 }\n')
    write('target.ts', 'export class Base {}\nexport function execute() { return 5 }\n')
    const original = TypeScriptStructureExtractor.prototype.extract
    const fault = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract').mockImplementation(function(this: TypeScriptStructureExtractor, input) {
      if (input.relativePath === 'broken.ts') throw new Error('controlled extraction failure')
      return original.call(this, input)
    })
    const first = await model.updateFileContents(['target.ts', 'broken.ts'])
    expect(first.errors.map(error => error.relativePath)).toEqual(['broken.ts'])
    expect(model.getPendingFilePaths()).toContain('broken.ts')
    expect(model.readiness.getState()).toBe('DEGRADED')
    fault.mockRestore(); model.close(); model = createRepositoryModel(root)
    sync = new RepositorySynchronizer(model, model.getRepositoryId())
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    expect((await sync.synchronizeModified()).errors).toEqual([])
    expect(extract.mock.calls.map(([input]) => input.relativePath)).toEqual(['broken.ts'])
    expect(model.getPendingFilePaths()).toEqual([])
    assertIntegrity()
  })

  it('completes recovered pending work through an explicit rebuild as well as synchronization', async () => {
    await fixture()
    write('new.ts', 'export function rebuild() { return 1 }\n')
    db().enqueueFileChanges(model.getRepositoryId(), ['new.ts'])
    model.close(); model = createRepositoryModel(root)
    expect(model.readiness.getState()).toBe('INITIALIZING')
    await model.indexRepository()
    expect(model.getPendingFilePaths()).toEqual([])
    expect(model.readiness.getState()).toBe('READY')
    assertIntegrity()
  })

  it('rolls back relationship replacement on SQLite failure and retries the durable path', async () => {
    await fixture()
    write('replacement.ts', 'export class Different {}\n')
    write('source.ts', "import { Different } from './replacement'\nexport class Derived extends Different {}\n")
    sql.exec("CREATE TRIGGER abort_graph BEFORE INSERT ON relationships WHEN NEW.type='extends' BEGIN SELECT RAISE(ABORT,'controlled graph failure'); END")
    const first = await model.updateFileContents(['replacement.ts', 'source.ts'])
    expect(first.completedPaths).toEqual([])
    expect(model.getPendingFilePaths().sort()).toEqual(['replacement.ts', 'source.ts'])
    expect(model.readiness.getState()).toBe('DEGRADED')
    sql.exec('DROP TRIGGER abort_graph')
    model.close(); model = createRepositoryModel(root)
    sync = new RepositorySynchronizer(model, model.getRepositoryId())
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    expect((await sync.synchronizeModified()).errors).toEqual([])
    expect(extract).not.toHaveBeenCalled()
    expect(model.getRelationships().some(relation => relation.type === 'extends')).toBe(true)
    assertIntegrity()
  })

  it('recovers a batch after a real worker termination between structural file commits', async () => {
    await fixture()
    write('target.ts', 'export class Base {}\nexport function execute() { return 7 }\n')
    write('source.ts', "import { execute } from './target'\nexport function run() { return execute() }\n")
    model.close()
    const child = join(root, 'code_awareness/batch-crash.cjs')
    buildSync({ stdin: { contents: `const {createRepositoryModel}=require(${JSON.stringify(resolve('src/main/core/repository-model.ts'))});
      const m=createRepositoryModel(process.argv[2]), step=m.updateFileStructure.bind(m);
      m.updateFileStructure=(path,...args)=>{if(path==='source.ts')process.kill(process.pid,'SIGKILL');return step(path,...args)};
      m.updateFileContents(['target.ts','source.ts']).then(()=>process.exit(91));`, resolveDir: process.cwd() }, outfile: child, bundle: true, packages: 'external', platform: 'node', format: 'cjs' })
    expect(() => execFileSync(process.execPath, [child, root], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') }, timeout: 30000, windowsHide: true, stdio: 'pipe' })).toThrow()
    model = createRepositoryModel(root)
    expect(model.getPendingFilePaths().sort()).toEqual(['source.ts', 'target.ts'])
    expect(model.readiness.getState()).toBe('INITIALIZING')
    sync = new RepositorySynchronizer(model, model.getRepositoryId())
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    expect((await sync.synchronizeModified()).errors).toEqual([])
    expect(extract.mock.calls.map(([input]) => input.relativePath)).toEqual(['source.ts'])
    expect(references('source.ts')).toHaveLength(1)
    expect(model.getPendingFilePaths()).toEqual([])
    assertIntegrity()
  })
})
