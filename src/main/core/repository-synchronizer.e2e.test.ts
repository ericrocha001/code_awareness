/*
-T ---
*/

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'fs'
import { statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { RepositoryModel, createRepositoryModel } from './repository-model'
import { RepositorySynchronizer } from './repository-synchronizer'
import { repositoryEventBus } from './repository-events'
import { closeRepositoryDatabase } from './repository-database'

describe('Sprint 3 — Detecção Verificada', () => {
  let testDir: string
  let model: RepositoryModel
  let synchronizer: RepositorySynchronizer

  beforeEach(() => {
    testDir = join(tmpdir(), `sync_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`)
    mkdirSync(testDir, { recursive: true })
  })

  // BUGFIX (Windows): o lock do WAL do SQLite pode segurar um handle após fechar a
  // conexão, impedindo a remoção imediata do diretório; faz um pequeno loop de retry.
  afterEach(async () => {
    synchronizer?.dispose()
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

  /** Cria model, indexa arquivo e cria synchronizer já configurado. */
  async function setupWithFile(filename: string, content: string): Promise<{
    filePath: string
    repositoryId: string
  }> {
    const filePath = join(testDir, filename)
    writeFileSync(filePath, content, 'utf-8')
    model = createRepositoryModel(testDir)
    await model.indexRepository()
    const repositoryId = model.getRepositoryId()
    synchronizer = new RepositorySynchronizer(model, repositoryId)
    return { filePath, repositoryId }
  }

  it('deve deduplicar eventos para o mesmo arquivo na fila', async () => {
    const { repositoryId } = await setupWithFile('sample.ts', 'const a = 1\n')

    // Emite 3 eventos para o mesmo arquivo: apenas 1 deve entrar na fila
    repositoryEventBus.emitFileModified(repositoryId, 'sample.ts')
    repositoryEventBus.emitFileModified(repositoryId, 'sample.ts')
    repositoryEventBus.emitFileModified(repositoryId, 'sample.ts')

    expect(synchronizer.getPendingFilesCount()).toBe(1)
  })

  it('deve ignorar eventos de outro repositório', async () => {
    const { repositoryId } = await setupWithFile('sample.ts', 'const a = 1\n')

    repositoryEventBus.emitFileModified('outro-repositorio-id', 'sample.ts')

    expect(synchronizer.getPendingFilesCount()).toBe(0)
  })

  it('deve marcar arquivo como modified E reindexar automaticamente (auto-sync) quando hash difere', async () => {
    const { filePath, repositoryId } = await setupWithFile('sample.ts', 'const a = 1\n')

    // Altera conteúdo do arquivo no disco
    const newContent = 'const a = 999\n'
    writeFileSync(filePath, newContent, 'utf-8')

    repositoryEventBus.emitFileModified(repositoryId, 'sample.ts')
    expect(synchronizer.getPendingFilesCount()).toBe(1)

    // Aguarda debounce (500ms) + estabilização + auto-reindex atômico
    await new Promise(resolve => setTimeout(resolve, 1500))

    // Auto-sync: arquivo é reindexado automaticamente (status indexed, não modified)
    const files = model.getFiles()
    expect(files[0].status).toBe('indexed')
    expect(files[0].contentHash).toBe(createHash('sha256').update(newContent, 'utf-8').digest('hex'))

    // Recuperação exata retorna o NOVO conteúdo
    const elements = model.getElementsByFile(files[0].id)
    const constA = elements.find(e => e.name === 'a' && e.kind === 'constant')
    expect(constA).toBeDefined()
    const source = await model.getElementExactSource(constA!.id)
    expect(source).not.toBeNull()
    expect(source!.content).toContain('999')
  })

  it('deve autocurar metadados e NÃO marcar como modified quando hash é igual', async () => {
    const content = 'const a = 1\n'
    const { filePath, repositoryId } = await setupWithFile('sample.ts', content)

    // Verifica estado inicial: arquivo indexado com status 'indexed'
    const filesBeforeEvent = model.getFiles()
    expect(filesBeforeEvent[0].status).toBe('indexed')
    const originalMtime = filesBeforeEvent[0].mtime

    // Reescreve o mesmo conteúdo (hash idêntico) sem alterar mtime — simula touch sem mudança real
    writeFileSync(filePath, content, 'utf-8')
    // Restaura o mtime original para que apenas o conteúdo seja igual
    const currentStat = statSync(filePath)
    utimesSync(filePath, currentStat.atime, new Date(originalMtime))

    repositoryEventBus.emitFileModified(repositoryId, 'sample.ts')

    await new Promise(resolve => setTimeout(resolve, 1000))

    const filesAfter = model.getFiles()
    // Hash igual → NÃO deve marcar como modified
    expect(filesAfter[0].status).toBe('indexed')
    expect(synchronizer.getModifiedFilesCount()).toBe(0)
  })

  it('deve marcar arquivo legado (contentHash nulo) como sempre modified', async () => {
    const { repositoryId } = await setupWithFile('sample.ts', 'const a = 1\n')

    // Simula arquivo legado: força contentHash para null no banco via model
    // (updateFileMetadata não altera hash, então usamos saveFile diretamente via model indexado)
    // A maneira mais simples: emitir evento para arquivo sem hash, verificando via getFileByRelativePath
    // Para o teste, verificamos que um arquivo com contentHash null é sempre marcado como modified.
    // Aqui testamos via integração: indexamos, zeramos o hash via banco legado, emitimos evento.

    // Usa o banco legado: fecha a conexão atual, abre diretamente e zera content_hash
    synchronizer.dispose()
    closeRepositoryDatabase(testDir)

    const Database = (await import('better-sqlite3')).default
    const dbPath = join(testDir, 'code_awareness', 'repository_model.db')
    const legacyDb = new Database(dbPath)
    legacyDb.exec(`UPDATE files SET content_hash = NULL`)
    legacyDb.close()

    // Reabre model e synchronizer com o ID da nova instância (pode diferir da sessão anterior)
    model = createRepositoryModel(testDir)
    synchronizer = new RepositorySynchronizer(model, model.getRepositoryId())

    const filesWithNullHash = model.getFiles()
    expect(filesWithNullHash[0].contentHash).toBeNull()

    repositoryEventBus.emitFileModified(repositoryId, 'sample.ts')

    await new Promise(resolve => setTimeout(resolve, 1000))

    const filesAfter = model.getFiles()
    expect(filesAfter[0].status).toBe('modified')
  })

  it('deve remover arquivo deletado automaticamente (auto-sync) e limpar o índice', async () => {
    const { filePath, repositoryId } = await setupWithFile('sample.ts', 'const a = 1\n')

    // Remove o arquivo do disco
    rmSync(filePath)
    expect(existsSync(filePath)).toBe(false)

    repositoryEventBus.emitFileModified(repositoryId, 'sample.ts')

    // Aguarda debounce + estabilização + auto-reindex (que detecta deleção e remove do banco)
    await new Promise(resolve => setTimeout(resolve, 1500))

    // Auto-sync: arquivo deletado é removido do índice (file + elements + relationships)
    const files = model.getFiles()
    expect(files.length).toBe(0)
    expect(synchronizer.getModifiedFilesCount()).toBe(0)

    // Não existe mais nenhum elemento no repositório
    expect(model.getElementsByRepository()).toHaveLength(0)
  })

  it('deve calcular hash SHA-256 correto para confirmação de mudança', async () => {
    const initialContent = 'const original = true\n'
    const { filePath, repositoryId } = await setupWithFile('check.ts', initialContent)

    const newContent = 'const modified = true\n'
    writeFileSync(filePath, newContent, 'utf-8')

    const expectedHash = createHash('sha256').update(newContent, 'utf-8').digest('hex')
    expect(expectedHash).toHaveLength(64)

    repositoryEventBus.emitFileModified(repositoryId, 'check.ts')

    await new Promise(resolve => setTimeout(resolve, 1000))

    // Após marcar modified e reindexar, o hash deve ser o novo
    await synchronizer.synchronizeModified()
    const files = model.getFiles()
    expect(files[0].contentHash).toBe(expectedHash)
    expect(files[0].status).toBe('indexed')
  })

  it('deve tratar arquivos de repositórios diferentes independentemente', async () => {
    await setupWithFile('a.ts', 'const a = 1\n')
    const repositoryId1 = model.getRepositoryId()

    // Evento de repositório diferente não deve entrar na fila deste synchronizer
    repositoryEventBus.emitFileModified('repositorio-completamente-diferente', 'a.ts')
    repositoryEventBus.emitFileModified(repositoryId1, 'a.ts')

    expect(synchronizer.getPendingFilesCount()).toBe(1)
  })
})

describe('Sprint 10 — Varredura Periódica Barata', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `code_awareness_periodic_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`)
    mkdirSync(testDir, { recursive: true })
    // A varredura periódica depende de timers reais (setInterval/setTimeout)
    vi.useRealTimers()
  })

  afterEach(() => {
    closeRepositoryDatabase(testDir)
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('não deve executar varredura quando timer está desabilitado', async () => {
    const model = createRepositoryModel(testDir)
    const synchronizer = new RepositorySynchronizer(model, model.getRepositoryId(), {
      periodicScanIntervalMs: 0 // desabilitado
    })

    // Aguarda um pouco para garantir que o timer não dispara
    await new Promise(resolve => setTimeout(resolve, 100))

    const count = synchronizer.getModifiedFilesCount()
    expect(count).toBe(0)

    synchronizer.dispose()
    model.close()
  })

  it('deve detectar divergências quando timer está habilitado', async () => {
    const filePath = join(testDir, 'sample.ts')
    writeFileSync(filePath, 'export const x = 1\n', 'utf-8')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    const synchronizer = new RepositorySynchronizer(model, model.getRepositoryId(), {
      periodicScanIntervalMs: 100 // 100ms para teste rápido
    })

    // Altera o arquivo sem disparar evento do watcher
    await new Promise(resolve => setTimeout(resolve, 50))
    writeFileSync(filePath, 'export const x = 999\n', 'utf-8')

    // Aguarda o timer disparar
    await new Promise(resolve => setTimeout(resolve, 200))

    const count = synchronizer.getModifiedFilesCount()
    expect(count).toBeGreaterThan(0)

    synchronizer.dispose()
    model.close()
  })

  it('deve curar status modified obsoleto quando conteúdo confere (varredura periódica)', async () => {
    const filePath = join(testDir, 'sample.ts')
    writeFileSync(filePath, 'export const x = 1\n', 'utf-8')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    // Marca como modified no banco sem alterar o conteúdo (status obsoleto)
    model.markFileModified('sample.ts')

    const synchronizer = new RepositorySynchronizer(model, model.getRepositoryId(), {
      periodicScanIntervalMs: 100
    })
    // Popula o conjunto em memória a partir do banco
    synchronizer.reloadModifiedFilesFromDatabase()
    expect(synchronizer.getModifiedFilesCount()).toBe(1)

    // Aguarda o timer disparar e curar o status obsoleto
    await new Promise(resolve => setTimeout(resolve, 250))

    expect(synchronizer.getModifiedFilesCount()).toBe(0)
    const files = model.getFiles()
    expect(files[0].status).toBe('indexed')

    synchronizer.dispose()
    model.close()
  })

  it('deve manter pendente quando conteúdo diverge do hash (varredura periódica)', async () => {
    const filePath = join(testDir, 'sample.ts')
    writeFileSync(filePath, 'export const x = 1\n', 'utf-8')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()

    // Altera o conteúdo no disco e marca como modified no banco
    writeFileSync(filePath, 'export const x = 999\n', 'utf-8')
    model.markFileModified('sample.ts')

    const synchronizer = new RepositorySynchronizer(model, model.getRepositoryId(), {
      periodicScanIntervalMs: 100
    })
    synchronizer.reloadModifiedFilesFromDatabase()
    expect(synchronizer.getModifiedFilesCount()).toBe(1)

    await new Promise(resolve => setTimeout(resolve, 250))

    // Conteúdo realmente divergente → permanece pendente
    expect(synchronizer.getModifiedFilesCount()).toBe(1)
    const files = model.getFiles()
    expect(files[0].status).toBe('modified')

    synchronizer.dispose()
    model.close()
  })
})

describe('Sprint 15 — reconcileMemoryWithDatabase', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `sync_s15_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`)
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

  it('deve remover stale modified de memória quando banco não confirma como modified', async () => {
    const filePath = join(testDir, 'sample.ts')
    const content = 'export const x = 1\n'
    writeFileSync(filePath, content, 'utf-8')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()
    const repositoryId = model.getRepositoryId()
    const synchronizer = new RepositorySynchronizer(model, repositoryId)

    // Injeta stale modified diretamente no modifiedFiles interno do synchronizer
    // @ts-ignore - acesso interno para teste
    synchronizer['modifiedFiles'].add('sample.ts')
    // @ts-ignore
    synchronizer['modifiedFiles'].add('inexistente.ts')

    expect(synchronizer.getModifiedFilesCount()).toBe(2)

    // Reconcilia: banco não tem nenhum modified (arquivo foi indexado com sucesso)
    const remaining = synchronizer.reconcileMemoryWithDatabase()
    // O banco não confirma esses arquivos como modified, devem ser removidos
    expect(remaining).toBe(0)

    synchronizer.dispose()
  })

  it('deve manter arquivos que o banco confirma como modified', async () => {
    const filePath = join(testDir, 'sample.ts')
    const content = 'export const x = 1\n'
    writeFileSync(filePath, content, 'utf-8')

    const model = createRepositoryModel(testDir)
    await model.indexRepository()
    const repositoryId = model.getRepositoryId()
    const synchronizer = new RepositorySynchronizer(model, repositoryId)

    // Força status modified no banco
    const files = model.getFiles()
    // @ts-ignore
    model['db'].updateFileStatus(files[0].id, 'modified')

    // Reconcilia: banco confirma sample.ts como modified
    const remaining = synchronizer.reconcileMemoryWithDatabase()
    expect(remaining).toBe(1)
    // @ts-ignore
    expect(synchronizer['modifiedFiles'].has('sample.ts')).toBe(true)

    synchronizer.dispose()
  })
})
