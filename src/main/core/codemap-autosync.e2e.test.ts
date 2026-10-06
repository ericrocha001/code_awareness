/*
-T ---
*/

import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { getParser, getLanguageForExtension } from './language-adapter'
import { createRepositoryModel, RepositoryModel } from './repository-model'
import { RepositorySynchronizer } from './repository-synchronizer'
import { closeRepositoryDatabase } from './repository-database'
import { repositoryEventBus } from './repository-events'
import { createTempRepo, cleanupTempRepo } from './test-helpers'

// Margem generosa: debounce (500ms) + estabilização (100ms) + reindex atômico
const WAIT_MS = 2500
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('CodeMap — Atualização Automática Real (Auto-Sync)', () => {
  let model: RepositoryModel
  let repoPath: string
  let sync: RepositorySynchronizer | null = null

  afterEach(async () => {
    if (sync) {
      sync.dispose()
      sync = null
    }
    if (model && repoPath) {
      closeRepositoryDatabase(repoPath)
      await cleanupTempRepo(repoPath)
    }
  })

  it('deve carregar os módulos repository-synchronizer e repository-events sem erro', () => {
    expect(getParser).toBeDefined()
    expect(getLanguageForExtension).toBeDefined()
    expect(RepositorySynchronizer).toBeDefined()
    expect(repositoryEventBus).toBeDefined()
  })

  it('Auto-sync modified: emitFileModified reindexa sozinho (sem synchronizeModified)', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)
    const path = join(repoPath, 'service.ts')
    writeFileSync(path, 'export class Service {\n  run(): string { return "v1"; }\n}\n', 'utf-8')
    await model.indexRepository()

    const file = model.getFiles().find((f) => f.relativePath === 'service.ts')
    expect(file).toBeDefined()
    const repositoryId = file!.repositoryId

    sync = new RepositorySynchronizer(model, repositoryId)

    // Modifica o conteúdo no disco
    const newContent = 'export class Service {\n  run(): string { return "v2"; }\n  stop(): void {}\n}\n'
    writeFileSync(path, newContent, 'utf-8')

    // Aguarda estabilização e emite o evento
    await wait(100)
    repositoryEventBus.emitFileModified(repositoryId, 'service.ts')

    // Aguarda debounce + estabilização + reindex atômico
    await wait(WAIT_MS)

    // Status voltou para indexed (reindexado automaticamente — NÃO fica modified)
    const fileAfter = model.getFiles().find((f) => f.relativePath === 'service.ts')
    expect(fileAfter).toBeDefined()
    expect(fileAfter!.status).toBe('indexed')

    // Elementos novos indexados (stop apareceu)
    const elements = model.getElementsByFile(fileAfter!.id)
    const stop = elements.find((e) => e.name === 'stop' && e.kind === 'method')
    expect(stop).toBeDefined()

    // Recuperação exata retorna o NOVO conteúdo
    const run = elements.find((e) => e.name === 'run' && e.kind === 'method')
    expect(run).toBeDefined()
    const source = await model.getElementExactSource(run!.id)
    expect(source).not.toBeNull()
    expect(source!.content).toContain('v2')

    // Nenhum pendente acumulado
    expect(sync.getModifiedFilesCount()).toBe(0)
    // NOTA: synchronizeModified() NÃO foi chamado neste teste — o auto-sync bastou.
  })

  it('Auto-sync new: arquivo criado via evento aparece no índice com elementos', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)
    // Arquivo inicial para obter o repositoryId
    writeFileSync(join(repoPath, 'seed.ts'), 'export const seed = 1;\n', 'utf-8')
    await model.indexRepository()

    const seedFile = model.getFiles().find((f) => f.relativePath === 'seed.ts')
    const repositoryId = seedFile!.repositoryId

    sync = new RepositorySynchronizer(model, repositoryId)

    // Cria um arquivo NOVO no disco
    const newPath = join(repoPath, 'fresh.ts')
    writeFileSync(newPath, 'export class Fresh {\n  boom(): void {}\n}\n', 'utf-8')
    await wait(100)
    repositoryEventBus.emitFileModified(repositoryId, 'fresh.ts')

    await wait(WAIT_MS)

    // Aparece no índice com elementos
    const freshFile = model.getFiles().find((f) => f.relativePath === 'fresh.ts')
    expect(freshFile).toBeDefined()
    expect(freshFile!.status).toBe('indexed')
    const elements = model.getElementsByFile(freshFile!.id)
    const boom = elements.find((e) => e.name === 'boom' && e.kind === 'method')
    expect(boom).toBeDefined()
    const source = await model.getElementExactSource(boom!.id)
    expect(source).not.toBeNull()
    expect(source!.content).toContain('boom')
  })

  it('Auto-sync deleted: arquivo deletado via evento remove file+elements+relationships', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)
    writeFileSync(join(repoPath, 'doomed.ts'), 'export class Doomed {}\n', 'utf-8')
    await model.indexRepository()

    const file = model.getFiles().find((f) => f.relativePath === 'doomed.ts')
    expect(file).toBeDefined()
    const repositoryId = file!.repositoryId

    sync = new RepositorySynchronizer(model, repositoryId)

    // Deleta o arquivo do disco
    unlinkSync(join(repoPath, 'doomed.ts'))
    expect(existsSync(join(repoPath, 'doomed.ts'))).toBe(false)
    await wait(100)
    repositoryEventBus.emitFileModified(repositoryId, 'doomed.ts')

    await wait(WAIT_MS)

    // File + elements + relationships desaparecem do índice
    const gone = model.getFiles().find((f) => f.relativePath === 'doomed.ts')
    expect(gone).toBeUndefined()
    const allElements = model.getElementsByRepository()
    expect(allElements.find((e) => e.name === 'Doomed')).toBeUndefined()
  })

  it('Reconciliação de conjuntos: arquivo criado com o app fechado é indexado na abertura', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)
    writeFileSync(join(repoPath, 'a.ts'), 'export const a = 1;\n', 'utf-8')
    await model.indexRepository()

    // Arquivo criado "com o app fechado" (presente no disco, ausente no banco)
    writeFileSync(join(repoPath, 'late.ts'), 'export class Late {\n  wake(): void {}\n}\n', 'utf-8')

    // Reconciliação com indexUnexpected=true (o mesmo que CodeMapService.openRepository usa)
    const res = await model.reconcileWithDisk({ indexUnexpected: true })
    expect(res.pendingPaths).toEqual(['late.ts'])
    sync = new RepositorySynchronizer(model, model.getRepositoryId())
    sync.reconcileMemoryWithDatabase(res.pendingPaths)
    expect((await sync.synchronizeModified()).filesUpdated).toBe(1)

    // O arquivo novo está indexado com elementos
    const lateFile = model.getFiles().find((f) => f.relativePath === 'late.ts')
    expect(lateFile).toBeDefined()
    expect(lateFile!.status).toBe('indexed')
    const elements = model.getElementsByFile(lateFile!.id)
    expect(elements.find((e) => e.name === 'Late' && e.kind === 'class')).toBeDefined()
  })
})
