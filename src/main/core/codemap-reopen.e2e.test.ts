import Database from 'better-sqlite3'
import { buildSync } from 'esbuild'
import { execFileSync } from 'child_process'
import { resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { RepositoryModel, createRepositoryModel } from './repository-model'
import { createRepositoryDatabase } from './repository-database'
import { createDefaultExtractors } from './extraction/default-extractors'
import { TypeScriptStructureExtractor } from './extraction/typescript-extractor'
import { getCanonicalTokenizer } from './tokenizer'
import { CodeMapService } from './code-map-service'
import { WatcherService } from './watcher-service'
import { cleanupTempRepo, createTempRepo } from './test-helpers'

const compression = { async generateCompressionMarkdown(): Promise<string> { throw new Error('unused') } }

describe('Code Map U1 — durable projection checkpoints in real SQLite/Electron', () => {
  let root = ''
  let model: RepositoryModel | undefined
  let sql: Database.Database | undefined
  let service: CodeMapService | undefined

  afterEach(async () => {
    await service?.closeAll()
    model?.close()
    sql?.close()
    vi.restoreAllMocks()
    if (root) await cleanupTempRepo(root)
  })

  async function fixture() {
    root = createTempRepo()
    writeFileSync(join(root, 'target.ts'), 'export function execute() { return 1 }\n')
    for (const name of ['a', 'b']) writeFileSync(join(root, name + '.ts'), `import { execute } from './target'\nexport function ${name}() { return execute() }\n`)
    writeFileSync(join(root, 'empty.md'), 'Plain document without headings\n')
    model = createRepositoryModel(root)
    await model.indexRepository()
    sql = new Database(join(root, 'code_awareness/repository_model.db'))
    sql.exec(`CREATE TABLE audit_symbols (source TEXT, operation TEXT);
      CREATE TRIGGER audit_insert AFTER INSERT ON symbol_references BEGIN INSERT INTO audit_symbols VALUES (NEW.source_file_id, 'INSERT'); END;
      CREATE TRIGGER audit_delete AFTER DELETE ON symbol_references BEGIN INSERT INTO audit_symbols VALUES (OLD.source_file_id, 'DELETE'); END;`)
    await maintenance()
    sql.exec('DELETE FROM audit_symbols')
  }

  async function maintenance() {
    await model!.backfillContentHashes()
    await model!.backfillContextReferences()
    await model!.backfillTokenMetadata()
    await model!.backfillTextDocuments()
    await model!.backfillDeclarationSignatures()
    await model!.backfillSymbolReferences()
  }

  it('reopens twice without extraction, resolver snapshots or symbol DELETE/INSERT, preserving IDs and navigation', async () => {
    await fixture()
    const before = model!.getElementsByRepository()
    const relationships = model!.getRelationships()
    const target = before.find(element => element.name === 'execute' && element.kind === 'function')!
    const uses = model!.getSymbolReferencesByTargetElement(target.id)
    expect(uses).toHaveLength(2)
    const extractor = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    for (let reopen = 0; reopen < 2; reopen++) {
      model!.close()
      model = createRepositoryModel(root)
      const snapshot = vi.spyOn(model as any, 'buildSymbolResolutionSnapshot')
      await maintenance()
      expect(snapshot).not.toHaveBeenCalled()
      expect(model.getElementsByRepository()).toEqual(before)
      expect(model.getRelationships()).toEqual(relationships)
      expect(model.getSymbolReferencesByTargetElement(target.id)).toEqual(uses)
      expect((await model.getElementExactSource(target.id))?.content).toContain('function execute()')
    }
    expect(extractor).not.toHaveBeenCalled()
    expect(sql!.prepare('SELECT COUNT(*) AS n FROM audit_symbols').get()).toEqual({ n: 0 })
  })

  it('reopens through CodeMapService twice with no extraction or symbol writes', async () => {
    await fixture()
    const relationships = model!.getRelationships()
    model!.close(); model = undefined
    service = new CodeMapService(new WatcherService(), compression)
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    for (let i = 0; i < 2; i++) {
      await service.openRepository(root)
      await service.awaitSnapshot(root)
      expect(service.getFiles(root)).toHaveLength(4)
      expect(service.getRelationships(root)).toEqual(relationships)
      expect(service.getModifiedFilesCount(root)).toBe(0)
      service.closeRepository(root)
    }
    await service.closeAll()
    expect(extract).not.toHaveBeenCalled()
    expect(sql!.prepare('SELECT COUNT(*) AS n FROM audit_symbols').get()).toEqual({ n: 0 })
  })

  it('recovers interrupted symbol persistence without rewriting already completed sources or trusting facts alone', async () => {
    await fixture()
    const a = model!.getFileByRelativePath('a.ts')!
    const b = model!.getFileByRelativePath('b.ts')!
    sql!.exec("DELETE FROM projection_checkpoints WHERE phase IN ('SYMBOLS', 'SYMBOL_SOURCE')")
    sql!.exec(`CREATE TRIGGER interrupt_symbols BEFORE INSERT ON symbol_references WHEN NEW.source_file_id='${b.id}' BEGIN SELECT RAISE(ABORT, 'controlled interruption'); END;`)
    await expect(model!.backfillSymbolReferences()).rejects.toThrow('controlled interruption')
    expect(createRepositoryDatabase(root).projectionCurrent(model!.getRepositoryId(), '', 'SYMBOLS', 'structure-1:symbols-1')).toBe(false)
    expect(model!.readiness.getState()).toBe('DEGRADED')
    await expect(model!.readiness.barrier('SYMBOL_REFERENCES')).rejects.toThrow('controlled interruption')
    expect(sql!.prepare("SELECT state FROM projection_checkpoints WHERE scope=? AND phase='SYMBOL_SOURCE'").get(a.id)).toEqual({ state: 'CLEAN' })
    model!.close()
    sql!.exec('DROP TRIGGER interrupt_symbols; DELETE FROM audit_symbols')
    model = createRepositoryModel(root)
    const extraction = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    expect(await model.backfillSymbolReferences()).toBe(2)
    expect(extraction).not.toHaveBeenCalled()
    expect(sql!.prepare('SELECT COUNT(*) AS n FROM audit_symbols WHERE source=?').get(a.id)).toEqual({ n: 0 })
    expect(model.getSymbolReferencesBySourceFile(b.id)).toHaveLength(1)
  })

  it('invalidates on resolver version without re-extraction, and on parser version with re-extraction', async () => {
    await fixture()
    model!.close()
    model = new RepositoryModel(root, createDefaultExtractors(), getCanonicalTokenizer(), undefined, { structure: 'structure-1', resolver: 'symbols-2' })
    const extraction = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    await model.backfillSymbolReferences()
    expect(extraction).not.toHaveBeenCalled()
    expect(sql!.prepare('SELECT COUNT(*) AS n FROM audit_symbols').get()).not.toEqual({ n: 0 })
    model.close()
    model = new RepositoryModel(root, createDefaultExtractors(), getCanonicalTokenizer(), undefined, { structure: 'structure-2', resolver: 'symbols-2' })
    await model.backfillSymbolReferences()
    expect(extraction).toHaveBeenCalledTimes(3)
    expect(await model.backfillSymbolReferences()).toBe(2)
    expect(extraction).toHaveBeenCalledTimes(3)
  })

  it('migrates legacy checkpoints once, including legitimate null signatures and documents with no sections', async () => {
    await fixture()
    sql!.exec('DELETE FROM projection_checkpoints')
    model!.close()
    model = createRepositoryModel(root)
    await maintenance()
    await maintenance()
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    await maintenance()
    expect(extract).not.toHaveBeenCalled()
    const id = model.getFileByRelativePath('empty.md')!.id
    expect(createRepositoryDatabase(root).projectionCurrent(model.getRepositoryId(), id, 'DOCUMENTS', 'structure-1')).toBe(true)
    expect(sql!.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('regenerates missing facts without replacing an already compatible structural projection', async () => {
    await fixture()
    const source = model!.getFileByRelativePath('a.ts')!
    createRepositoryDatabase(root).deleteSymbolResolutionFacts(source.id)
    const replacement = vi.spyOn((model as any).db, 'replaceIndexedFileState')
    expect(await model!.backfillSymbolReferences()).toBe(2)
    expect(replacement).not.toHaveBeenCalled()
    expect(model!.getSymbolReferencesBySourceFile(source.id)).toHaveLength(1)
  })

  it('does not silently accept removed symbol rows when facts remain present', async () => {
    await fixture()
    sql!.exec('DELETE FROM symbol_references')
    expect(await model!.backfillSymbolReferences()).toBe(2)
    expect(sql!.prepare('SELECT COUNT(*) AS n FROM symbol_references').get()).toEqual({ n: 2 })
  })

  it('recovers a real abruptly terminated Electron worker using only unfinished symbol sources', async () => {
    await fixture()
    const a = model!.getFileByRelativePath('a.ts')!
    const b = model!.getFileByRelativePath('b.ts')!
    sql!.exec("DELETE FROM projection_checkpoints WHERE phase IN ('SYMBOLS', 'SYMBOL_SOURCE')")
    model!.close(); model = undefined
    const childFile = join(root, 'code_awareness/interrupt.cjs')
    buildSync({ stdin: { contents: `
      const {createRepositoryModel}=require(${JSON.stringify(resolve('src/main/core/repository-model.ts'))});
      const {createRepositoryDatabase}=require(${JSON.stringify(resolve('src/main/core/repository-database.ts'))});
      const root=process.argv[2], model=createRepositoryModel(root), db=model.db, original=db.replaceSymbolReferencesForFile.bind(db);
      db.replaceSymbolReferencesForFile=(id, rows)=>{if(id===process.argv[3])process.kill(process.pid,'SIGKILL');return original(id,rows)};
      model.backfillSymbolReferences().then(()=>process.exit(91));
    `, resolveDir: process.cwd() }, outfile: childFile, bundle: true, packages: 'external', platform: 'node', format: 'cjs' })
    let terminated = false
    try { execFileSync(process.execPath, [childFile, root, b.id], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') }, stdio: 'pipe', windowsHide: true, timeout: 30000 }) }
    catch { terminated = true }
    expect(terminated).toBe(true)
    expect(sql!.prepare("SELECT state FROM projection_checkpoints WHERE scope='' AND phase='SYMBOLS'").get()).toEqual({ state: 'RUNNING' })
    expect(sql!.prepare("SELECT state FROM projection_checkpoints WHERE scope=? AND phase='SYMBOL_SOURCE'").get(a.id)).toEqual({ state: 'CLEAN' })
    sql!.exec('DELETE FROM audit_symbols')
    model = createRepositoryModel(root)
    expect(await model.backfillSymbolReferences()).toBe(2)
    expect(sql!.prepare('SELECT COUNT(*) AS n FROM audit_symbols WHERE source=?').get(a.id)).toEqual({ n: 0 })
    expect(sql!.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('invalidates token metadata without invalidating parser facts or resolving symbols', async () => {
    await fixture()
    model!.close()
    const tokenizer = { id: 'tokenizer-upgrade', encoding: 'test', count: vi.fn((content: string) => content.length) }
    model = new RepositoryModel(root, createDefaultExtractors(), tokenizer)
    const extract = vi.spyOn(TypeScriptStructureExtractor.prototype, 'extract')
    const resolver = vi.spyOn(model as any, 'buildSymbolResolutionSnapshot')
    await maintenance()
    expect(tokenizer.count).toHaveBeenCalledTimes(4)
    expect(extract).not.toHaveBeenCalled()
    expect(resolver).not.toHaveBeenCalled()
    tokenizer.count.mockClear()
    await maintenance()
    expect(tokenizer.count).not.toHaveBeenCalled()
  })

  it('records a legitimate null signature after migration rather than extracting it on every reopen', async () => {
    await fixture()
    model!.close()
    const extractors = createDefaultExtractors().map(extractor => ({
      supports: (extension: string) => extractor.supports(extension),
      extract: vi.fn((input: Parameters<typeof extractor.extract>[0]) => {
        const result = extractor.extract(input)
        for (const element of result.elements) element.declarationSignature = null
        return result
      })
    }))
    model = new RepositoryModel(root, extractors)
    await model.indexRepository()
    sql!.exec("DELETE FROM projection_checkpoints WHERE phase='SIGNATURES'")
    await model.backfillDeclarationSignatures()
    for (const extractor of extractors) extractor.extract.mockClear()
    await model.backfillDeclarationSignatures()
    for (const extractor of extractors) expect(extractor.extract).not.toHaveBeenCalled()
  })

  it('drains maintenance before close, and serializes immediate reopen on the same SQLite connection', async () => {
    await fixture()
    model!.close(); model = undefined
    service = new CodeMapService(new WatcherService(), compression)
    let release!: () => void
    let entered!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const original = RepositoryModel.prototype.backfillTokenMetadata
    vi.spyOn(RepositoryModel.prototype, 'backfillTokenMetadata').mockImplementationOnce(async function (this: RepositoryModel) {
      entered(); await hold
      return original.call(this)
    })
    await service.openRepository(root)
    await started
    service.closeRepository(root)
    let reopened = false
    const opening = service.openRepository(root).then(() => { reopened = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(reopened).toBe(false)
    expect(sql!.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 4 })
    release()
    await opening
    await service.awaitSnapshot(root)
    expect(service.getReadiness(root).state).toBe('READY')
    expect(service.getFiles(root)).toHaveLength(4)
    await service.closeAll()
  })
})
