/*
-T ---
*/

import { describe, it, expect, afterEach, vi } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import {
  createAndIndexRepo,
  createTempRepo,
  writeTestFile,
  cleanupTestDir,
  verifyInvariant
} from './test-helpers'
import { RepositoryModel, createRepositoryModel } from './repository-model'
import { RepositorySynchronizer } from './repository-synchronizer'
import { closeRepositoryDatabase } from './repository-database'
import { repositoryEventBus } from './repository-events'
import * as structureReaderModule from './structure-reader'

describe('Sprint 5 — Resiliência sob Concorrência', () => {
  let model: RepositoryModel
  let repoPath: string

  afterEach(async () => {
    vi.restoreAllMocks()
    if (model && repoPath) {
      closeRepositoryDatabase(repoPath)
      await cleanupTestDir(repoPath)
    }
  })

  it('Teste 1 — Falha no meio da indexação não corrompe o banco', async () => {
    repoPath = createTempRepo()
    writeTestFile(repoPath, 'src/valid1.ts', 'export class Class1 {}\n')
    writeTestFile(repoPath, 'src/valid2.ts', 'export class Class2 {}\n')
    writeTestFile(repoPath, 'src/valid3.ts', 'export class Class3 {}\n')

    model = createRepositoryModel(repoPath)

    const realReadStructure = structureReaderModule.readStructure
    const spy = vi.spyOn(structureReaderModule, 'readStructure').mockImplementation(
      (repositoryId, relativePath, extension, content) => {
        if (relativePath === 'src/valid2.ts') {
          throw new Error('Erro intencional de I/O em readStructure')
        }
        return realReadStructure(repositoryId, relativePath, extension, content)
      }
    )

    // A indexação inicial deve falhar ao processar src/valid2.ts
    await expect(model.indexRepository()).rejects.toThrow('Erro intencional de I/O em readStructure')

    // O primeiro arquivo (processado antes do erro) deve estar indexado
    const valid1File = model.getFileByRelativePath('src/valid1.ts')
    expect(valid1File).toBeDefined()
    expect(model.getElementsByFile(valid1File!.id).length).toBeGreaterThan(0)

    // O segundo e o terceiro arquivos não foram indexados no banco
    const valid2File = model.getFileByRelativePath('src/valid2.ts')
    const valid3File = model.getFileByRelativePath('src/valid3.ts')
    expect(valid2File).toBeNull()
    expect(valid3File).toBeNull()

    // O invariante não possui violações de corrupção (apenas file_missing_in_db para os não indexados)
    const invariant = await verifyInvariant(model, repoPath, { expectFullySynced: false })
    const corruptionViolations = invariant.violations.filter((v) => v.type !== 'file_missing_in_db')
    expect(corruptionViolations.length).toBe(0)

    // Restaura o mock
    spy.mockRestore()

    // Uma segunda chamada indexRepository deve completar sem erros
    await model.indexRepository()
    expect(model.getFiles().length).toBe(3)

    const fullInvariant = await verifyInvariant(model, repoPath)
    expect(fullInvariant.passed).toBe(true)
  })

  it('Teste 2 — Falha na reindexação seletiva preserva o resto do banco', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/valid1.ts': 'export class Class1 {}\n',
      'src/valid2.ts': 'export class Class2 {}\n',
      'src/valid3.ts': 'export class Class3 {}\n'
    }))

    const valid1File = model.getFileByRelativePath('src/valid1.ts')!
    const valid2File = model.getFileByRelativePath('src/valid2.ts')!
    const valid3File = model.getFileByRelativePath('src/valid3.ts')!

    expect(model.getElementsByFile(valid1File.id).length).toBeGreaterThan(0)
    expect(model.getElementsByFile(valid2File.id).length).toBeGreaterThan(0)
    expect(model.getElementsByFile(valid3File.id).length).toBeGreaterThan(0)

    // Sobrescreve valid2.ts com erro de sintaxe
    writeFileSync(join(repoPath, 'src/valid2.ts'), 'export class {{{ broken\n', 'utf-8')
    await model.updateFileContent('src/valid2.ts')

    // valid1 e valid3 permanecem indexados normalmente
    expect(model.getElementsByFile(valid1File.id).length).toBeGreaterThan(0)
    expect(model.getElementsByFile(valid3File.id).length).toBeGreaterThan(0)

    // valid2 permanece no banco mas com 0 elementos devido à falha de parse
    expect(model.getElementsByFile(valid2File.id).length).toBe(0)

    const invariant = await verifyInvariant(model, repoPath, { expectFullySynced: false })
    expect(invariant.passed).toBe(true)

    // Corrigir valid2.ts e reindexar restaura os elementos
    writeFileSync(join(repoPath, 'src/valid2.ts'), 'export class Fixed {}\n', 'utf-8')
    await model.updateFileContent('src/valid2.ts')

    expect(model.getElementsByFile(valid2File.id).length).toBeGreaterThan(0)

    const fullInvariant = await verifyInvariant(model, repoPath)
    expect(fullInvariant.passed).toBe(true)
  })

  it('Teste 3 — Evento recebido durante sincronização em lote não é perdido (auto-sync)', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/first.ts': 'export class First {}\n',
      'src/second.ts': 'export class Second {}\n'
    }))

    const synchronizer = new RepositorySynchronizer(model, model.getRepositoryId())

    model.markFileModified('src/first.ts')
    model.markFileModified('src/second.ts')
    synchronizer.reloadModifiedFilesFromDatabase()

    expect(synchronizer.getModifiedFilesCount()).toBe(2)

    // Crie um terceiro arquivo no disco e emite evento file:modified
    writeFileSync(join(repoPath, 'src/third.ts'), 'export class Third {}\n', 'utf-8')
    repositoryEventBus.emitFileModified(model.getRepositoryId(), 'src/third.ts')

    // A primeira sincronização em lote atualiza os 2 do banco
    const res1 = await synchronizer.synchronizeModified()
    expect(res1.filesUpdated).toBe(2)

    // O evento do terceiro arquivo foi capturado no pendingFiles
    expect(synchronizer.getPendingFilesCount()).toBeGreaterThan(0)

    // Aguarda o debounce de 500ms + estabilização + auto-reindex do terceiro
    // NOTA (Sprint 6): com auto-sync, o terceiro arquivo é reindexado automaticamente
    // após sua confirmação, então modifiedFilesCount vai a 0 (não fica pendente).
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // Auto-sync reindexou o third → sem pendentes (critério congelado #2)
    expect(synchronizer.getModifiedFilesCount()).toBe(0)
    expect(synchronizer.getPendingFilesCount()).toBe(0)

    // Terceiro arquivo está indexado com elementos
    const thirdFile = model.getFileByRelativePath('src/third.ts')
    expect(thirdFile).toBeDefined()
    expect(thirdFile!.status).toBe('indexed')
    const elements = model.getElementsByFile(thirdFile!.id)
    expect(elements.find((e) => e.name === 'Third' && e.kind === 'class')).toBeDefined()

    const invariant = await verifyInvariant(model, repoPath)
    expect(invariant.passed).toBe(true)

    synchronizer.dispose()
  })

  it('Teste 4 — Scan periódico simultâneo com evento de watcher', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/sample.ts': 'export class Sample {}\n'
    }))

    const synchronizer = new RepositorySynchronizer(model, model.getRepositoryId(), {
      periodicScanIntervalMs: 100
    })

    // Modifica o arquivo no disco
    writeFileSync(join(repoPath, 'src/sample.ts'), 'export class SampleModified {}\n', 'utf-8')

    // Emite evento simultaneamente
    repositoryEventBus.emitFileModified(model.getRepositoryId(), 'src/sample.ts')

    // Aguarda debounce + scan periódico
    await new Promise((resolve) => setTimeout(resolve, 600))

    // Deve estar marcado como modified exatamente uma vez sem duplicações
    expect(synchronizer.getModifiedFilesCount()).toBe(1)

    const invariant = await verifyInvariant(model, repoPath, { expectFullySynced: false })
    expect(invariant.passed).toBe(true)

    synchronizer.dispose()
  })

  it('Teste 5 — 50 arquivos modificados simultaneamente', async () => {
    const initialFiles: Record<string, string> = {}
    for (let i = 0; i < 50; i++) {
      const filename = `src/file_${String(i).padStart(2, '0')}.ts`
      initialFiles[filename] = `export class Class_${i} {}\n`
    }

    ;({ model, repoPath } = await createAndIndexRepo(initialFiles))

    const synchronizer = new RepositorySynchronizer(model, model.getRepositoryId())

    // Modifica todos os 50 arquivos no disco e emite eventos em rápida sucessão
    for (let i = 0; i < 50; i++) {
      const filename = `src/file_${String(i).padStart(2, '0')}.ts`
      writeFileSync(join(repoPath, filename), `// modified\nexport class Class_${i} {}\n`, 'utf-8')
      repositoryEventBus.emitFileModified(model.getRepositoryId(), filename)
    }

    // Aguarda debounce + estabilização sequencial de 50 arquivos (50 x 100ms = 5000ms + buffer)
    // NOTA (Sprint 6): com auto-sync, cada arquivo é reindexado automaticamente após sua
    // confirmação, então modifiedFiles fica vazio (sem pendentes). O critério congelado #2
    // exige "após debounce, elementos novos indexados, status indexed".
    await new Promise((resolve) => setTimeout(resolve, 7000))

    expect(synchronizer.getModifiedFilesCount()).toBe(0) // auto-sync reindexou todos → sem pendentes

    // Todos os 50 arquivos estão indexados com o conteúdo modificado
    const files = model.getFiles()
    expect(files.length).toBe(50)
    for (const file of files) {
      expect(file.status).toBe('indexed')
    }

    const invariant = await verifyInvariant(model, repoPath)
    expect(invariant.passed).toBe(true)

    synchronizer.dispose()
  }, 15000)

  it('Teste 6 — Alteração durante a sincronização (race condition)', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/race.ts': 'export class Race1 {}\n'
    }))

    const synchronizer = new RepositorySynchronizer(model, model.getRepositoryId())

    writeFileSync(join(repoPath, 'src/race.ts'), 'export class Race2 {}\n', 'utf-8')
    model.markFileModified('src/race.ts')
    synchronizer.reloadModifiedFilesFromDatabase()

    expect(synchronizer.getModifiedFilesCount()).toBe(1)

    // Intercepta updateFileContent para modificar o arquivo novamente e emitir evento no meio do processamento
    const originalUpdate = model.updateFileContent.bind(model)
    const spy = vi.spyOn(model, 'updateFileContent').mockImplementation(async (relativePath, correlationId) => {
      const res = await originalUpdate(relativePath, correlationId)
      // Durante/após a atualização, altera o disco para Race3 e emite o evento
      writeFileSync(join(repoPath, 'src/race.ts'), 'export class Race3 {}\n', 'utf-8')
      repositoryEventBus.emitFileModified(model.getRepositoryId(), relativePath)
      return res
    })

    const res1 = await synchronizer.synchronizeModified()
    expect(res1.filesUpdated).toBe(1)

    spy.mockRestore()

    // Aguarda o debounce do evento emitido durante a sincronização + auto-reindex
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // Auto-sync reindexou Race3 → sem pendentes (critério congelado #2)
    expect(synchronizer.getModifiedFilesCount()).toBe(0)

    const files = model.getFiles()
    const raceFile = files.find((f) => f.relativePath === 'src/race.ts')!
    const elements = model.getElementsByFile(raceFile.id)
    expect(elements.find((e) => e.name === 'Race3' && e.kind === 'class')).toBeDefined()

    const invariant = await verifyInvariant(model, repoPath)
    expect(invariant.passed).toBe(true)

    synchronizer.dispose()
  })
})
