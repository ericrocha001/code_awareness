/*
-T ---
*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import { RepositoryModel, createRepositoryModel } from './repository-model'
import { createRepositoryDatabase, closeRepositoryDatabase } from './repository-database'

describe('Sprint 2 — SHA-256 no Índice e Contrato de Persistência', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `code_awareness_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`)
    mkdirSync(testDir, { recursive: true })
  })

  // BUGFIX (Windows): loop de retry para contornar lock do WAL do SQLite.
  afterEach(async () => {
    closeRepositoryDatabase(testDir)
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
        return
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  })

  it('deve calcular e persistir contentHash SHA-256 durante indexRepository', async () => {
    const filePath = join(testDir, 'sample.ts')
    const sampleContent = 'export const hello = "world";\n'
    writeFileSync(filePath, sampleContent, 'utf-8')

    const expectedHash = createHash('sha256').update(sampleContent, 'utf-8').digest('hex')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    const files = model.getFiles()
    expect(files.length).toBe(1)
    expect(files[0].relativePath).toBe('sample.ts')
    expect(files[0].contentHash).toBe(expectedHash)
    expect(files[0].contentHash).toHaveLength(64)
  })

  it('deve atualizar contentHash ao reindexar arquivo via updateFileContent', async () => {
    const filePath = join(testDir, 'sample.ts')
    const initialContent = 'console.log("v1")\n'
    writeFileSync(filePath, initialContent, 'utf-8')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    // Captura o hash antes da atualização (Recomendação 3 da auditoria)
    const filesBefore = model.getFiles()
    const oldHash = filesBefore[0].contentHash
    expect(oldHash).toHaveLength(64)

    const updatedContent = 'console.log("v2")\n'
    writeFileSync(filePath, updatedContent, 'utf-8')

    const expectedHashV2 = createHash('sha256').update(updatedContent, 'utf-8').digest('hex')
    await model.updateFileContent('sample.ts')

    const filesAfter = model.getFiles()
    expect(filesAfter.length).toBe(1)
    // Verifica explicitamente que o hash antigo foi substituído pelo novo
    expect(filesAfter[0].contentHash).not.toBe(oldHash)
    expect(filesAfter[0].contentHash).toBe(expectedHashV2)
  })

  it('deve ser determinístico: mesmo conteúdo sempre produz mesmo hash (Recomendação 1 da auditoria)', async () => {
    const filePath = join(testDir, 'sample.ts')
    const content = 'export const x = 42\n'
    writeFileSync(filePath, content, 'utf-8')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    const filesFirstIndex = model.getFiles()
    const hashAfterFirstIndex = filesFirstIndex[0].contentHash
    expect(hashAfterFirstIndex).toHaveLength(64)

    // Reindexa sem alterar o conteúdo: o hash deve permanecer idêntico
    await model.updateFileContent('sample.ts')

    const filesAfterReindex = model.getFiles()
    expect(filesAfterReindex[0].contentHash).toBe(hashAfterFirstIndex)

    // Modifica conteúdo preservando mtime manualmente via utimes
    const updatedContent = 'export const x = 99\n'
    const { utimesSync } = await import('fs')
    const { statSync } = await import('fs')
    const statBefore = statSync(filePath)
    writeFileSync(filePath, updatedContent, 'utf-8')
    // Restaura o mtime original para simular mtime igual mas conteúdo diferente
    utimesSync(filePath, statBefore.atime, statBefore.mtime)

    await model.updateFileContent('sample.ts')

    const filesAfterContentChange = model.getFiles()
    const expectedNewHash = createHash('sha256').update(updatedContent, 'utf-8').digest('hex')
    // Hash deve ter mudado mesmo com mtime idêntico
    expect(filesAfterContentChange[0].contentHash).not.toBe(hashAfterFirstIndex)
    expect(filesAfterContentChange[0].contentHash).toBe(expectedNewHash)
  })

  it('deve ser idempotente na migração da coluna content_hash no SQLite', () => {
    const codeAwarenessDir = join(testDir, 'code_awareness')
    mkdirSync(codeAwarenessDir, { recursive: true })
    const dbPath = join(codeAwarenessDir, 'repository_model.db')

    // Cria banco legado sem a coluna content_hash
    const legacyDb = new Database(dbPath)
    legacyDb.exec(`
      CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        model_version INTEGER NOT NULL DEFAULT 1,
        last_indexed_at TEXT
      );
      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        language TEXT NOT NULL,
        extension TEXT NOT NULL,
        lines INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'modified',
        FOREIGN KEY (repository_id) REFERENCES repositories(id),
        UNIQUE(repository_id, relative_path)
      );
      INSERT INTO repositories (id, path, name) VALUES ('repo1', '${testDir}', 'test');
      INSERT INTO files (id, repository_id, relative_path, language, extension, lines, size_bytes, mtime, status)
      VALUES ('file1', 'repo1', 'legacy.ts', 'typescript', '.ts', 10, 100, 123456, 'indexed');
    `)
    legacyDb.close()

    // Abrir via createRepositoryDatabase deve executar a migração sem erro
    const dbRepo = createRepositoryDatabase(testDir)
    const files = dbRepo.getFilesByRepository('repo1')

    expect(files.length).toBe(1)
    expect(files[0].relativePath).toBe('legacy.ts')
    expect(files[0].contentHash).toBeNull()

    // Chamar createRepositoryDatabase novamente deve ser totalmente idempotente
    expect(() => createRepositoryDatabase(testDir)).not.toThrow()
  })
})

describe('Sprint 4 — Reconciliação de Abertura com Hash', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `code_awareness_reconcile_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`)
    mkdirSync(testDir, { recursive: true })
  })

  // BUGFIX (Windows): loop de retry para contornar lock do WAL do SQLite.
  afterEach(async () => {
    closeRepositoryDatabase(testDir)
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
        return
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  })

  it('deve autocurar mtime quando hash é igual (reconcileWithDisk)', async () => {
    const filePath = join(testDir, 'sample.ts')
    const content = 'export const x = 42\n'
    writeFileSync(filePath, content, 'utf-8')

    const model1 = createRepositoryModel(testDir)
    await model1.indexRepository()
    model1.close()

    // Modifica mtime sem alterar conteúdo (touch)
    const { utimesSync } = await import('fs')
    const newMtime = new Date(Date.now() + 10000)
    utimesSync(filePath, newMtime, newMtime)

    // Reabre e reconcilia
    const model2 = createRepositoryModel(testDir)
    await model2.reconcileWithDisk()

    const files = model2.getFiles()
    expect(files[0].status).toBe('indexed') // NÃO modified
    expect(files[0].mtime).toBe(Math.floor(newMtime.getTime())) // autocurado
  })

  it('deve marcar como modified quando hash difere (reconcileWithDisk)', async () => {
    const filePath = join(testDir, 'sample.ts')
    writeFileSync(filePath, 'const a = 1\n', 'utf-8')

    const model1 = createRepositoryModel(testDir)
    await model1.indexRepository()
    model1.close()

    // Altera conteúdo
    writeFileSync(filePath, 'const a = 999\n', 'utf-8')

    const model2 = createRepositoryModel(testDir)
    await model2.reconcileWithDisk()

    const files = model2.getFiles()
    expect(files[0].status).toBe('modified')
  })

  it('deve marcar arquivo legado (sem hash) como modified', async () => {
    const filePath = join(testDir, 'legacy.ts')
    writeFileSync(filePath, 'const legacy = true\n', 'utf-8')

    const model1 = createRepositoryModel(testDir)
    await model1.indexRepository()

    // Simula arquivo legado: zera o hash no banco
    const files = model1.getFiles()
    const legacyFile = { ...files[0], contentHash: null }
    // @ts-ignore - aceso direto via db para simulação
    model1['db'].saveFile(legacyFile)
    model1.close()

    const model2 = createRepositoryModel(testDir)
    await model2.reconcileWithDisk()

    const filesAfter = model2.getFiles()
    expect(filesAfter[0].status).toBe('modified')
  })
})

describe('Sprint 6 — Integrity Check Profundo', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `code_awareness_integrity_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`)
    mkdirSync(testDir, { recursive: true })
  })

  // BUGFIX (Windows): loop de retry para contornar lock do WAL do SQLite.
  afterEach(async () => {
    closeRepositoryDatabase(testDir)
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
        return
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  })

  it('deve retornar status healthy quando não há inconsistências', async () => {
    const filePath = join(testDir, 'sample.ts')
    writeFileSync(filePath, 'export const x = 1\n', 'utf-8')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    const result = await model.verifyIntegrity()
    expect(result.status).toBe('healthy')
    expect(result.hashesMismatched).toBe(0)
    expect(result.orphanElements).toBe(0)
    expect(result.invalidRelationships).toBe(0)
  })

  it('deve detectar hash divergente e reparar com autoRepair', async () => {
    const filePath = join(testDir, 'sample.ts')
    const originalContent = 'export const x = 1\n'
    writeFileSync(filePath, originalContent, 'utf-8')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    // Altera o conteúdo do arquivo sem reindexar
    const newContent = 'export const x = 999\n'
    writeFileSync(filePath, newContent, 'utf-8')

    // Verifica sem reparação — deve detectar divergência
    const resultBefore = await model.verifyIntegrity({ autoRepair: false })
    expect(resultBefore.status).toBe('inconsistent')
    expect(resultBefore.hashesMismatched).toBe(1)

    // Verifica com reparação — deve corrigir
    const resultAfter = await model.verifyIntegrity({ autoRepair: true })
    expect(resultAfter.repairResult).toBeDefined()
    expect(resultAfter.repairResult!.status).toBe('success')
    expect(resultAfter.repairResult!.issuesFixed).toBe(1)
    expect(resultAfter.repairResult!.revalidation.status).toBe('healthy')
  })

  it('deve autocurar arquivo ausente no disco via reconcileWithDisk na Fase 0', async () => {
    const filePath = join(testDir, 'sample.ts')
    writeFileSync(filePath, 'export class Foo {}\n', 'utf-8')
    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    // Deleta o arquivo do disco mas mantém no banco (simula corrupção)
    rmSync(filePath)

    // verifyIntegrity chama reconcileWithDisk na Fase 0, que remove o arquivo
    // e seus elementos em cascata. Quando a Fase 1 roda, não há inconsistências.
    const result = await model.verifyIntegrity({ autoRepair: false })
    expect(result.status).toBe('healthy')
    expect(result.filesMissing).toBe(0) // reconciliação já removeu
    expect(result.orphanElements).toBe(0) // cascata removeu elementos também
  })

  it('deve detectar elemento órfão quando elemento existe sem arquivo pai no banco', async () => {
    const filePath = join(testDir, 'sample.ts')
    writeFileSync(filePath, 'export class Foo {}\n', 'utf-8')
    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    // Simula corrupção: remove o arquivo do banco MAS mantém os elementos
    // (cenário que NÃO ocorre na cascata normal, mas pode ocorrer por bug externo)
    const files = model.getFiles()
    const fileId = files[0].id

    // @ts-ignore - acesso direto ao db para simular corrupção
    const db = model['db'] as any
    // Desabilita FK para simular corrupção que não ocorre no fluxo normal (cascata impediria)
    db.db.pragma('foreign_keys = OFF')
    db.db.prepare('DELETE FROM files WHERE id = ?').run(fileId)
    db.db.pragma('foreign_keys = ON')

    // Agora os elementos existem mas o arquivo pai não — órfãos reais
    const result = await model.verifyIntegrity({ autoRepair: false })
    expect(result.status).toBe('inconsistent')
    expect(result.orphanElements).toBeGreaterThan(0)
  })
})

describe('Sprint 5 — Migração de Hashes Ausentes (Backfill)', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `code_awareness_backfill_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`)
    mkdirSync(testDir, { recursive: true })
  })

  // BUGFIX (Windows): loop de retry para contornar lock do WAL do SQLite.
  afterEach(async () => {
    closeRepositoryDatabase(testDir)
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
        return
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  })

  it('deve preencher hash de arquivo legado sem contentHash', async () => {
    const filePath = join(testDir, 'legacy.ts')
    const content = 'const legacy = true\n'
    writeFileSync(filePath, content, 'utf-8')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    // Simula arquivo legado: zera o hash no banco
    const files = model.getFiles()
    const legacyFile = { ...files[0], contentHash: null }
    // @ts-ignore - acesso direto via db para simulação
    model['db'].saveFile(legacyFile)

    // Verifica que o hash foi zerado
    const filesBefore = model.getFiles()
    expect(filesBefore[0].contentHash).toBeNull()

    // Executa backfill
    const updated = await model.backfillContentHashes()
    expect(updated).toBe(1)

    // Verifica que o hash foi preenchido
    const filesAfter = model.getFiles()
    expect(filesAfter[0].contentHash).not.toBeNull()
    expect(filesAfter[0].contentHash).toHaveLength(64)

    // Hash deve corresponder ao conteúdo real
    const expectedHash = createHash('sha256').update(content, 'utf-8').digest('hex')
    expect(filesAfter[0].contentHash).toBe(expectedHash)
  })

  it('deve ser idempotente — executar duas vezes produz mesmo resultado', async () => {
    const filePath = join(testDir, 'sample.ts')
    const content = 'export const x = 1\n'
    writeFileSync(filePath, content, 'utf-8')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    // Simula legado
    const files = model.getFiles()
    const legacyFile = { ...files[0], contentHash: null }
    // @ts-ignore
    model['db'].saveFile(legacyFile)

    // Primeira execução
    const updated1 = await model.backfillContentHashes()
    expect(updated1).toBe(1)

    // Segunda execução — nada a fazer
    const updated2 = await model.backfillContentHashes()
    expect(updated2).toBe(0)

    // Hash permanece o mesmo
    const filesAfter = model.getFiles()
    expect(filesAfter[0].contentHash).not.toBeNull()
    const expectedHash = createHash('sha256').update(content, 'utf-8').digest('hex')
    expect(filesAfter[0].contentHash).toBe(expectedHash)
  })
})

describe('Sprint 15 — Autocura de Status Obsoleto e Reconciliação', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `code_awareness_sprint15_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`)
    mkdirSync(testDir, { recursive: true })
  })

  // BUGFIX (Windows): loop de retry para contornar lock do WAL do SQLite.
  afterEach(async () => {
    closeRepositoryDatabase(testDir)
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
        return
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  })

  it('deve curar arquivo com status modified obsoleto cujo hash confere no disco', async () => {
    const filePath = join(testDir, 'sample.ts')
    const content = 'export const a = 123\n'
    writeFileSync(filePath, content, 'utf-8')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    // Força status 'modified' no banco sem alterar o arquivo no disco
    const files = model.getFiles()
    // @ts-ignore
    model['db'].updateFileStatus(files[0].id, 'modified')

    const filesBefore = model.getFiles()
    expect(filesBefore[0].status).toBe('modified')

    // Executa reconciliação
    const res = await model.reconcileWithDisk()
    expect(res.healed).toBe(1)

    // Status deve ter virado 'indexed'
    const filesAfter = model.getFiles()
    expect(filesAfter[0].status).toBe('indexed')
  })

  it('deve manter status modified se o conteúdo no disco diverge do hash indexado', async () => {
    const filePath = join(testDir, 'sample.ts')
    const content = 'export const a = 123\n'
    writeFileSync(filePath, content, 'utf-8')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    // Altera o arquivo no disco e força status 'modified'
    writeFileSync(filePath, 'export const a = 999\n', 'utf-8')
    const files = model.getFiles()
    // @ts-ignore
    model['db'].updateFileStatus(files[0].id, 'modified')

    const res = await model.reconcileWithDisk()
    expect(res.healed).toBe(0)

    const filesAfter = model.getFiles()
    expect(filesAfter[0].status).toBe('modified')
  })
})
