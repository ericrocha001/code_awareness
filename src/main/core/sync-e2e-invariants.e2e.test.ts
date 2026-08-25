/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Provar que sequências complexas criar/modificar/deletar/recriar convergem para banco = disco.
2. Provar que o debounce absorve tempestades de eventos sem perda do estado final.
3. Provar que relacionamentos cross-file em cadeia de 3 níveis são mantidos em reindexações seletivas.
4. Provar que reconciliação entre sessões detecta e cura divergências acumuladas offline.

Mapa de Relacionamentos do Script

1. repository-model.ts
   - Tipo: Dependência Direta
   - Relação: Executa indexRepository, updateFileContent, reconcileWithDisk, verifyIntegrity, close.
   - Criticidade: Alta

2. repository-synchronizer.ts
   - Tipo: Dependência Direta
   - Relação: Testa debounce, sincronização em lote e deduplicação de eventos.
   - Criticidade: Alta

3. test-helpers.ts
   - Tipo: Dependência Direta
   - Relação: Fornece createAndIndexRepo, createTempRepo, writeTestFile, deleteTestFile,
              cleanupTestDir, verifyInvariant e simulateOrphanCorruption.
   - Criticidade: Alta

Invariantes do Script

1. Cada teste usa repositório temporário isolado com cleanupTestDir no afterEach.
2. verifyInvariant é chamado após cada etapa relevante como oráculo de integridade.
3. Assertivas de elementos filtram sempre por kind para evitar ambiguidade com export elements.
4. Timeouts são generosos (>= 15000ms) para acomodar debounce + estabilização em CI.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import {
  createAndIndexRepo,
  createTempRepo,
  writeTestFile,
  deleteTestFile,
  cleanupTestDir,
  verifyInvariant,
  simulateOrphanCorruption
} from './test-helpers'
import { RepositoryModel } from './repository-model'
import { RepositorySynchronizer } from './repository-synchronizer'
import { closeRepositoryDatabase } from './repository-database'
import { repositoryEventBus } from './repository-events'

describe('Sprint 6 — Invariantes End-to-End', () => {
  let model: RepositoryModel
  let repoPath: string

  afterEach(async () => {
    if (model && repoPath) {
      closeRepositoryDatabase(repoPath)
      await cleanupTestDir(repoPath)
    }
  })

  it('Teste 1 — Sequência criar/modificar/deletar/recriar converge para banco = disco', async () => {
    repoPath = createTempRepo()
    model = new RepositoryModel(repoPath)

    // Etapa 1: cria a.ts e indexa
    writeTestFile(repoPath, 'src/a.ts', 'export class A {}\n')
    await model.indexRepository()
    let inv = await verifyInvariant(model, repoPath)
    expect(inv.passed).toBe(true)

    // Etapa 2: adiciona método a a.ts e reindexa
    writeTestFile(repoPath, 'src/a.ts', 'export class A {\n  hello(): void {}\n}\n')
    await model.updateFileContent('src/a.ts')
    inv = await verifyInvariant(model, repoPath)
    expect(inv.passed).toBe(true)
    const aElements = model.getElementsByFile(model.getFileByRelativePath('src/a.ts')!.id)
    expect(aElements.find((e) => e.name === 'hello' && e.kind === 'method')).toBeDefined()

    // Etapa 3: cria b.ts com extends e indexa
    writeTestFile(repoPath, 'src/b.ts', "import { A } from './a'\nexport class B extends A {}\n")
    await model.updateFileContent('src/b.ts')
    inv = await verifyInvariant(model, repoPath)
    expect(inv.passed).toBe(true)
    expect(model.getRelationships().filter((r) => r.type === 'extends').length).toBe(1)

    // Etapa 4: deleta a.ts do disco e sincroniza (o cleanup de deleteFile remove o
    // stale imports relationship de b.ts → a.ts automaticamente)
    deleteTestFile(repoPath, 'src/a.ts')
    await model.updateFileContent('src/a.ts')
    inv = await verifyInvariant(model, repoPath)
    expect(inv.passed).toBe(true)
    expect(model.getFileByRelativePath('src/a.ts')).toBeNull()

    // Etapa 5: recria a.ts com conteúdo diferente e sincroniza
    writeTestFile(repoPath, 'src/a.ts', 'export class ANew { recreated(): void {} }\n')
    await model.updateFileContent('src/a.ts')
    inv = await verifyInvariant(model, repoPath)
    expect(inv.passed).toBe(true)
    expect(model.getFileByRelativePath('src/a.ts')).toBeDefined()

    // Etapa 6: remove extends de b.ts e sincroniza
    writeTestFile(repoPath, 'src/b.ts', 'export class B {}\n')
    await model.updateFileContent('src/b.ts')
    inv = await verifyInvariant(model, repoPath)
    expect(inv.passed).toBe(true)

    // Estado final: sem relacionamentos extends
    expect(model.getRelationships().filter((r) => r.type === 'extends').length).toBe(0)
    // b.ts existe com seus elementos
    const bFile = model.getFileByRelativePath('src/b.ts')
    expect(bFile).toBeDefined()
    expect(model.getElementsByFile(bFile!.id).find((e) => e.name === 'B' && e.kind === 'class')).toBeDefined()
    // a.ts existe com conteúdo recriado
    const aFile = model.getFileByRelativePath('src/a.ts')
    expect(aFile).toBeDefined()
    expect(model.getElementsByFile(aFile!.id).find((e) => e.name === 'ANew' && e.kind === 'class')).toBeDefined()
  })

  it('Teste 2 — Tempestade de eventos é absorvida pelo debounce, estado final é o correto', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/sample.ts': 'export class V1 {}\n'
    }))

    const synchronizer = new RepositorySynchronizer(model, model.getRepositoryId())

    // 4 escritas rápidas sem await + 5 eventos imediatos em sequência
    writeFileSync(join(repoPath, 'src/sample.ts'), 'export class V2 {}\n', 'utf-8')
    writeFileSync(join(repoPath, 'src/sample.ts'), 'export class V3 {}\n', 'utf-8')
    writeFileSync(join(repoPath, 'src/sample.ts'), 'export class V4 {}\n', 'utf-8')
    writeFileSync(join(repoPath, 'src/sample.ts'), 'export class V5 {}\n', 'utf-8')
    repositoryEventBus.emitFileModified(model.getRepositoryId(), 'src/sample.ts')
    repositoryEventBus.emitFileModified(model.getRepositoryId(), 'src/sample.ts')
    repositoryEventBus.emitFileModified(model.getRepositoryId(), 'src/sample.ts')
    repositoryEventBus.emitFileModified(model.getRepositoryId(), 'src/sample.ts')
    repositoryEventBus.emitFileModified(model.getRepositoryId(), 'src/sample.ts')

    // Aguarda debounce (500ms) + estabilização (100ms) + processamento + margem
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // O debounce deve ter deduplicado: exatamente 1 arquivo na fila de modified
    expect(synchronizer.getModifiedFilesCount()).toBe(1)
    // A fila de pendentes foi drenada pelo processQueue após o debounce
    expect(synchronizer.getPendingFilesCount()).toBe(0)

    const result = await synchronizer.synchronizeModified()
    expect(result.filesUpdated).toBe(1)

    // O conteúdo final indexado deve corresponder à última escrita (V5)
    const sampleFile = model.getFileByRelativePath('src/sample.ts')!
    const elements = model.getElementsByFile(sampleFile.id)
    expect(elements.find((e) => e.name === 'V5' && e.kind === 'class')).toBeDefined()
    expect(elements.find((e) => e.name === 'V1' && e.kind === 'class')).toBeUndefined()

    const inv = await verifyInvariant(model, repoPath)
    expect(inv.passed).toBe(true)

    synchronizer.dispose()
  }, 15000)

  it('Teste 3 — Cross-file com três níveis de dependência sobrevive a reindexações seletivas', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/base.ts': 'export class Base { baseMethod(): void {} }\n',
      'src/middle.ts': "import { Base } from './base'\nexport class Middle extends Base { middleMethod(): void {} }\n",
      'src/leaf.ts': "import { Middle } from './middle'\nexport class Leaf extends Middle { leafMethod(): void {} }\n"
    }))

    const extendsRels = model.getRelationships().filter((r) => r.type === 'extends')
    expect(extendsRels.length).toBe(2) // Leaf→Middle, Middle→Base

    const importsRels = model.getRelationships().filter((r) => r.type === 'imports')
    expect(importsRels.length).toBeGreaterThanOrEqual(2) // leaf→middle, middle→base

    // Reindexação seletiva de base.ts adicionando método
    writeFileSync(
      join(repoPath, 'src/base.ts'),
      'export class Base { baseMethod(): void {} newMethod(): void {} }\n',
      'utf-8'
    )
    await model.updateFileContent('src/base.ts')

    // Ambos extends permanecem intactos
    expect(model.getRelationships().filter((r) => r.type === 'extends').length).toBe(2)
    // Novo método aparece em Base
    const baseFile = model.getFileByRelativePath('src/base.ts')!
    expect(
      model.getElementsByFile(baseFile.id).find((e) => e.name === 'newMethod' && e.kind === 'method')
    ).toBeDefined()

    let inv = await verifyInvariant(model, repoPath)
    expect(inv.passed).toBe(true)

    // Remove middle.ts do disco e sincroniza (o cleanup de deleteFile remove o
    // stale imports relationship de leaf.ts → middle.ts automaticamente)
    try {
      unlinkSync(join(repoPath, 'src/middle.ts'))
    } catch {
      // fallback silencioso — o arquivo já não existe
    }
    await model.updateFileContent('src/middle.ts')

    // Elementos de middle.ts removidos do banco
    expect(model.getFileByRelativePath('src/middle.ts')).toBeNull()

    // Relacionamentos que tinham middle.ts como source ou target são removidos
    const relsAfter = model.getRelationships().filter((r) => r.type === 'extends')
    expect(relsAfter.length).toBe(0)

    // leaf.ts ainda existe com seus elementos
    const leafFile = model.getFileByRelativePath('src/leaf.ts')!
    expect(leafFile).toBeDefined()
    expect(
      model.getElementsByFile(leafFile.id).find((e) => e.name === 'Leaf' && e.kind === 'class')
    ).toBeDefined()

    inv = await verifyInvariant(model, repoPath)
    expect(inv.passed).toBe(true)
  })

  it('Teste 4 — Reconciliação entre sessões detecta e cura divergências acumuladas offline', async () => {
    // ── Fase 1: Sessão 1 ─────────────────────────────────────────────────
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/a.ts': 'export class A {}\n',
      'src/b.ts': 'export class B {}\n',
      'src/c.ts': 'export class C {}\n'
    }))

    const cFile = model.getFileByRelativePath('src/c.ts')!

    // Modifica a.ts no disco sem sincronizar
    writeFileSync(join(repoPath, 'src/a.ts'), 'export class AModified {}\n', 'utf-8')

    // Deleta b.ts do disco sem sincronizar
    try {
      unlinkSync(join(repoPath, 'src/b.ts'))
    } catch {
      // no-op
    }

    // Simula corrupção: remove c.ts do banco mantendo os elementos órfãos (R2)
    simulateOrphanCorruption(model, cFile.id)

    // Fecha a sessão 1
    closeRepositoryDatabase(repoPath)

    // ── Fase 2: Sessão 2 ─────────────────────────────────────────────────
    model = new RepositoryModel(repoPath)

    // reconcileWithDisk deve detectar: a.ts (divergente), b.ts (ausente)
    // Nota: c.ts foi removido do banco; seus elementos órfãos são limpos pelo verifyIntegrity
    const reconcileResult = await model.reconcileWithDisk()
    expect(reconcileResult.removed).toBe(1) // b.ts removido
    expect(reconcileResult.markedModified).toBe(1) // a.ts marcado

    // a.ts deve estar marcado como modified
    const aFileAfter = model.getFileByRelativePath('src/a.ts')
    expect(aFileAfter).toBeDefined()
    expect(aFileAfter!.status).toBe('modified')

    // b.ts deve ter sido removido
    expect(model.getFileByRelativePath('src/b.ts')).toBeNull()

    // Limpa elementos órfãos deixados pela corrupção simulada de c.ts
    await model.verifyIntegrity({ autoRepair: true })

    // Sincroniza a.ts modificado
    const synchronizer = new RepositorySynchronizer(model, model.getRepositoryId())
    synchronizer.reloadModifiedFilesFromDatabase()
    const syncResult = await synchronizer.synchronizeModified()
    expect(syncResult.filesUpdated).toBe(1)

    // Verifica convergência final: banco = disco
    const inv = await verifyInvariant(model, repoPath)
    expect(inv.passed).toBe(true)

    synchronizer.dispose()
  })
})
