/*
-T ---
*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, utimesSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  createAndIndexRepo,
  cleanupTempRepo,
  modifyFileOnDisk,
  deleteTestFile,
  writeTestFile,
  verifyInvariant,
  FIXTURE_SIMPLE_FUNCTION
} from './test-helpers'
import { RepositoryModel, createRepositoryModel } from './repository-model'
import { RepositorySynchronizer } from './repository-synchronizer'
import { repositoryEventBus } from './repository-events'
import { closeRepositoryDatabase } from './repository-database'

describe('Sprint 3 — Convergência Disco ↔ Banco', () => {
  let model: RepositoryModel
  let repoPath: string
  let synchronizer: RepositorySynchronizer | null = null

  beforeEach(() => {
    // Setup individual é feito dentro de cada it() via createAndIndexRepo
  })

  afterEach(async () => {
    if (synchronizer) {
      synchronizer.dispose()
      synchronizer = null
    }
    if (model && repoPath) {
      closeRepositoryDatabase(repoPath)
      await cleanupTempRepo(repoPath)
    }
  })

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  it('deve sincronizar arquivo criado no disco', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({}))
    const repositoryId = model.getRepositoryId()
    synchronizer = new RepositorySynchronizer(model, repositoryId)

    writeTestFile(repoPath, 'src/new.ts', FIXTURE_SIMPLE_FUNCTION)
    repositoryEventBus.emitFileCreated(repositoryId, 'src/new.ts')

    await wait(800) // debounce de 500ms + verificação
    await synchronizer.synchronizeModified()

    const result = await verifyInvariant(model, repoPath)
    expect(result.passed).toBe(true)

    const file = model.getFiles().find((f) => f.relativePath === 'src/new.ts')
    expect(file).toBeDefined()
    expect(file!.status).toBe('indexed')
  })

  it('deve sincronizar arquivo modificado no disco', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/sample.ts': 'export const x = 1\n' }))
    const repositoryId = model.getRepositoryId()
    synchronizer = new RepositorySynchronizer(model, repositoryId)

    const initialHash = model.getFiles()[0].contentHash

    modifyFileOnDisk(repoPath, 'src/sample.ts', 'export const x = 999\n')
    repositoryEventBus.emitFileModified(repositoryId, 'src/sample.ts')

    await wait(800) // debounce + verificação
    await synchronizer.synchronizeModified()

    const result = await verifyInvariant(model, repoPath)
    expect(result.passed).toBe(true)

    const updatedHash = model.getFiles()[0].contentHash
    expect(updatedHash).not.toBe(initialHash)
    expect(updatedHash).toBe(createHash('sha256').update('export const x = 999\n', 'utf-8').digest('hex'))
  })

  it('deve sincronizar arquivo deletado do disco', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/sample.ts': FIXTURE_SIMPLE_FUNCTION }))
    const repositoryId = model.getRepositoryId()
    synchronizer = new RepositorySynchronizer(model, repositoryId)

    expect(model.getFiles().some((f) => f.relativePath === 'src/sample.ts')).toBe(true)

    deleteTestFile(repoPath, 'src/sample.ts')
    repositoryEventBus.emitFileDeleted(repositoryId, 'src/sample.ts')

    await wait(800) // debounce + verificação
    await synchronizer.synchronizeModified()

    const result = await verifyInvariant(model, repoPath)
    expect(result.passed).toBe(true)
    expect(model.getFiles()).toHaveLength(0)
  })

  it('deve detectar arquivo modificado sem evento via scan periódico', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/sample.ts': 'export const x = 1\n' }))
    const repositoryId = model.getRepositoryId()
    synchronizer = new RepositorySynchronizer(model, repositoryId, { periodicScanIntervalMs: 100 })

    modifyFileOnDisk(repoPath, 'src/sample.ts', 'export const x = 999\n')

    await wait(250) // aguarda o timer do scan disparar
    await synchronizer.synchronizeModified()

    const result = await verifyInvariant(model, repoPath)
    expect(result.passed).toBe(true)

    const hash = model.getFiles()[0].contentHash
    expect(hash).toBe(createHash('sha256').update('export const x = 999\n', 'utf-8').digest('hex'))
  })

  it('deve detectar arquivo deletado sem evento via scan periódico', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/sample.ts': FIXTURE_SIMPLE_FUNCTION }))
    const repositoryId = model.getRepositoryId()
    synchronizer = new RepositorySynchronizer(model, repositoryId, { periodicScanIntervalMs: 100 })

    deleteTestFile(repoPath, 'src/sample.ts')

    await wait(250) // aguarda o timer do scan disparar
    await synchronizer.synchronizeModified()

    const result = await verifyInvariant(model, repoPath)
    expect(result.passed).toBe(true)
    expect(model.getFiles()).toHaveLength(0)
  })

  it('deve reconciliar arquivo modificado offline ao reabrir', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/sample.ts': 'export const x = 1\n' }))

    model.close()
    modifyFileOnDisk(repoPath, 'src/sample.ts', 'export const x = 999\n')

    model = createRepositoryModel(repoPath)
    await model.reconcileWithDisk()

    expect(model.getFiles()[0].status).toBe('modified')

    const repositoryId = model.getRepositoryId()
    synchronizer = new RepositorySynchronizer(model, repositoryId)
    await synchronizer.synchronizeModified()

    const result = await verifyInvariant(model, repoPath)
    expect(result.passed).toBe(true)
  })

  it('deve reconciliar arquivo deletado offline ao reabrir', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/sample.ts': FIXTURE_SIMPLE_FUNCTION }))

    model.close()
    deleteTestFile(repoPath, 'src/sample.ts')

    model = createRepositoryModel(repoPath)
    await model.reconcileWithDisk()

    expect(model.getFiles()).toHaveLength(0)

    const result = await verifyInvariant(model, repoPath)
    expect(result.passed).toBe(true)
  })

  it('deve autocurar metadados quando mtime muda mas conteúdo é igual', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/sample.ts': 'export const x = 1\n' }))
    const repositoryId = model.getRepositoryId()
    synchronizer = new RepositorySynchronizer(model, repositoryId)

    const filePath = join(repoPath, 'src/sample.ts')
    const initialHash = model.getFiles()[0].contentHash
    const initialMtime = model.getFiles()[0].mtime

    utimesSync(filePath, new Date(), new Date(Date.now() + 60_000))
    repositoryEventBus.emitFileModified(repositoryId, 'src/sample.ts')

    await wait(800) // debounce + autocura

    const file = model.getFiles()[0]
    expect(file.status).toBe('indexed')
    expect(file.mtime).not.toBe(initialMtime)
    expect(file.contentHash).toBe(initialHash)

    const result = await verifyInvariant(model, repoPath)
    expect(result.passed).toBe(true)
  })


  it('deve ignorar evento quando conteúdo é igual ao indexado', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/sample.ts': 'export const x = 1\n' }))
    const repositoryId = model.getRepositoryId()
    synchronizer = new RepositorySynchronizer(model, repositoryId)

    const initialHash = model.getFiles()[0].contentHash

    writeTestFile(repoPath, 'src/sample.ts', 'export const x = 1\n')
    repositoryEventBus.emitFileModified(repositoryId, 'src/sample.ts')

    await wait(800) // debounce + autocura

    const file = model.getFiles()[0]
    expect(file.status).toBe('indexed')
    expect(file.contentHash).toBe(initialHash)

    const result = await verifyInvariant(model, repoPath)
    expect(result.passed).toBe(true)
  })

  it('mantém arquivo novo fora do índice quando criado sem evento via scan periódico', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({}))
    const repositoryId = model.getRepositoryId()
    synchronizer = new RepositorySynchronizer(model, repositoryId, { periodicScanIntervalMs: 100 })

    // O scan periódico só percorre arquivos já indexados — não descobre arquivos novos.
    writeTestFile(repoPath, 'src/new.ts', FIXTURE_SIMPLE_FUNCTION)

    await wait(250) // aguarda o timer do scan disparar
    await synchronizer.synchronizeModified()

    expect(model.getFiles()).toHaveLength(0)

    const result = await verifyInvariant(model, repoPath)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.type === 'file_missing_in_db' && v.target === 'src/new.ts')).toBe(true)
  })

  it('deve ignorar arquivo acima de 2MB', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/large.ts': 'x'.repeat(3 * 1024 * 1024) }))

    expect(model.getFiles()).toHaveLength(0)

    const result = await verifyInvariant(model, repoPath, { expectFullySynced: false })
    expect(result.passed).toBe(true)
  })

  it('deve ignorar arquivo binário', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({}))

    // Grava um arquivo binário na raiz do repositório temporário.
    writeFileSync(join(repoPath, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    await model.indexRepository()

    expect(model.getFiles()).toHaveLength(0)

    const result = await verifyInvariant(model, repoPath, { expectFullySynced: false })
    expect(result.passed).toBe(true)
  })
})

