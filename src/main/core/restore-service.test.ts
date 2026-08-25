/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar o RestoreService via 8 Provas de Aceitação usando repositórios Git temporários reais.
2. Provar a restauração completa com backup fail-safe e rollback automático em falha parcial.
3. Provar o cálculo de arquivos remanescentes por evidência (checkpoints mais novos + disco).
4. Provar a garantia estrutural de único restoredAt (incluindo estado corrompido).
5. Provar a segurança de paths via resolveSafePath (path traversal, absoluto, Windows UNC).
6. Provar que o preview é operação de leitura pura (sem efeitos colaterais).
7. Provar a validação de integridade do checkpoint antes da escrita.
8. Provar o contrato IPC do restore-handler (único grupo com mocks).
9. Provar a detecção de falhas de consistência pós-escrita (marcação, cleanup, logs).

Mapa de Relacionamentos do Script

1. restore-service.ts
   - Tipo: Dependência Direta
   - Relação: Instancia e valida o contrato público do RestoreService.
   - Criticidade: Alta

2. checkpoint-service.ts
   - Tipo: Dependência Direta
   - Relação: Instância real com FakeCheckpointCatalogPort injetada no RestoreService.
   - Criticidade: Alta

3. git-test-helpers.ts
   - Tipo: Dependência Direta
   - Relação: Cria, manipula e limpa repositórios Git temporários reais.
   - Criticidade: Alta

4. fake-ports.ts
   - Tipo: Dependência Direta
   - Relação: Fornece FakeCheckpointCatalogPort e FakeActionLogPort para persistência em memória sem SQLite.
   - Criticidade: Alta

Invariantes do Script

1. Todo repositório temporário é limpo após cada teste via cleanupTempRepo.
2. Nenhum teste usa mocks para PA-R01 a PA-R06 — usa Git real e filesystem real com Fakes em memória para banco.
3. Mock apenas para PA-R07 (handler IPC do Electron via vi.mock).
4. O oráculo de integridade (hash SHA-256) é verificado em cenários de restauração.
5. Nenhuma dependência direta de better-sqlite3 ou database-service.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, chmodSync, existsSync, readFileSync, unlinkSync } from 'fs'
import * as fsPromises from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'
import type { IpcMainInvokeEvent } from 'electron'
import { CheckpointService } from './checkpoint-service'
import { RestoreService } from './restore-service'
import { FakeCheckpointCatalogPort, FakeActionLogPort } from './fake-ports'
import {
  createTempGitRepo,
  cleanupTempRepo,
  writeFile,
  stageAll,
  commit
} from './git-test-helpers'

// Mapa de handlers IPC capturados para PA-R07
const registeredHandlers = new Map<string, Function>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      registeredHandlers.set(channel, handler)
    })
  }
}))

import { registerRestoreHandlers } from '../ipc/restore-handler'

async function invokeHandler(channel: string, ...args: unknown[]): Promise<any> {
  const handler = registeredHandlers.get(channel)
  if (!handler) throw new Error(`Handler não registrado: ${channel}`)
  const mockEvent = {} as IpcMainInvokeEvent
  return handler(mockEvent, ...args)
}

describe('RestoreService — Bateria de Testes de Integração', () => {
  let fakeCatalog: FakeCheckpointCatalogPort
  let fakeActionLog: FakeActionLogPort
  let cpService: CheckpointService
  let restoreService: RestoreService

  beforeEach(() => {
    fakeCatalog = new FakeCheckpointCatalogPort()
    fakeActionLog = new FakeActionLogPort()
    cpService = new CheckpointService(fakeCatalog)
    restoreService = new RestoreService(cpService, fakeActionLog)
  })
  // ─── PA-R01 — Restauração Completa com Rollback em Falha ─────────────────
  describe('PA-R01 — Restauração Completa com Rollback em Falha', () => {
    it('Cenário A — Sucesso total com backup', async () => {
      const repoPath = await createTempGitRepo()
      try {
        writeFile(repoPath, 'a.ts', 'v1')
        writeFile(repoPath, 'b.ts', 'v1')
        await stageAll(repoPath)
        await commit(repoPath, 'initial')




        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1 Initial')

        // Modifica arquivos no disco para v2
        writeFile(repoPath, 'a.ts', 'v2')
        writeFile(repoPath, 'b.ts', 'v2')

        const result = await restoreService.execute(repoPath, cp1.id, {
          createSafety: true,
          cleanupFiles: []
        })

        expect(result.restored).toBe(2)
        expect(result.failed).toBe(0)
        expect(result.partial).toBe(false)
        expect(result.safetyBackupId).toBeDefined()
        expect(typeof result.safetyBackupId).toBe('string')

        // Conteúdo no disco voltou para v1
        expect(readFileSync(join(repoPath, 'a.ts'), 'utf-8')).toBe('v1')
        expect(readFileSync(join(repoPath, 'b.ts'), 'utf-8')).toBe('v1')

        // Action logs no banco de dados
        const actions = fakeActionLog.getActions(repoPath)
        expect(actions.some(a => a.actionType === 'checkpoint_created')).toBe(true)
        expect(actions.some(a => a.actionType === 'checkpoint_restored')).toBe(true)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário B — Sucesso total sem backup', async () => {
      const repoPath = await createTempGitRepo()
      try {
        writeFile(repoPath, 'a.ts', 'v1')
        writeFile(repoPath, 'b.ts', 'v1')
        await stageAll(repoPath)
        await commit(repoPath, 'initial')




        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1 Initial')

        writeFile(repoPath, 'a.ts', 'v2')
        writeFile(repoPath, 'b.ts', 'v2')

        const result = await restoreService.execute(repoPath, cp1.id, {
          createSafety: false,
          cleanupFiles: []
        })

        expect(result.restored).toBe(2)
        expect(result.failed).toBe(0)
        expect(result.partial).toBe(false)
        expect(result.safetyBackupId).toBeUndefined()
        expect(readFileSync(join(repoPath, 'a.ts'), 'utf-8')).toBe('v1')
        expect(readFileSync(join(repoPath, 'b.ts'), 'utf-8')).toBe('v1')
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário C — Backup falha, restauração aborta', async () => {
      const repoPath = await createTempGitRepo()
      try {
        writeFile(repoPath, 'a.ts', 'v1')
        await stageAll(repoPath)
        await commit(repoPath, 'initial')




        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1 Initial')

        writeFile(repoPath, 'a.ts', 'v2')

        // Força falha no createCheckpoint durante o backup de segurança
        vi.spyOn(cpService, 'createCheckpoint').mockRejectedValueOnce(new Error('Erro simular falha no disk backup'))

        await expect(
          restoreService.execute(repoPath, cp1.id, {
            createSafety: true,
            cleanupFiles: []
          })
        ).rejects.toThrow(/backup/i)

        // O arquivo a.ts no disco permanece v2 (nenhuma escrita foi feita)
        expect(readFileSync(join(repoPath, 'a.ts'), 'utf-8')).toBe('v2')
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário D — Falha parcial com rollback automático', async () => {
      const repoPath = await createTempGitRepo()
      try {
        writeFile(repoPath, 'a.ts', 'v1')
        writeFile(repoPath, 'b.ts', 'v1')
        writeFile(repoPath, 'c.ts', 'v1')
        await stageAll(repoPath)
        await commit(repoPath, 'initial')




        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1 Initial')

        // Modifica arquivos para v2
        writeFile(repoPath, 'a.ts', 'v2')
        writeFile(repoPath, 'b.ts', 'v2')
        writeFile(repoPath, 'c.ts', 'v2')

        // Simula falha na primeira tentativa de restauração (writeCheckpointFiles)
        // para acionar o rollback automático via backup de segurança
        const originalWriteFiles = (restoreService as any).writeCheckpointFiles.bind(restoreService)
        let callCount = 0
        vi.spyOn(restoreService as any, 'writeCheckpointFiles').mockImplementation(async (rPath: string, cpData: any) => {
          callCount++
          if (callCount === 1) {
            // Primeira chamada (restauração primária): simula falha parcial
            return { restored: 2, failed: 1, errors: ['c.ts: permissão negada'] }
          }
          // Segunda chamada (rollback): executa restauração real do backup de segurança
          return originalWriteFiles(rPath, cpData)
        })

        const result = await restoreService.execute(repoPath, cp1.id, {
          createSafety: true,
          cleanupFiles: []
        })

        expect(result.partial).toBe(true)
        expect(result.rollbackAttempted).toBe(true)
        expect(result.rollbackSuccess).toBe(true)

        // Todos os arquivos voltaram ao estado pré-restauração (v2)
        expect(readFileSync(join(repoPath, 'a.ts'), 'utf-8')).toBe('v2')
        expect(readFileSync(join(repoPath, 'b.ts'), 'utf-8')).toBe('v2')
        expect(readFileSync(join(repoPath, 'c.ts'), 'utf-8')).toBe('v2')

        // Verifica log de rollback no banco de dados
        const actions = fakeActionLog.getActions(repoPath)
        const rollbackLog = actions.find(a => a.actionType === 'restore_rollback')
        expect(rollbackLog).toBeDefined()
        expect(rollbackLog?.details).toContain('bem-sucedido')
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário E — Falha parcial sem backup', async () => {
      const repoPath = await createTempGitRepo()
      try {
        writeFile(repoPath, 'a.ts', 'v1')
        writeFile(repoPath, 'b.ts', 'v1')
        writeFile(repoPath, 'c.ts', 'v1')
        await stageAll(repoPath)
        await commit(repoPath, 'initial')




        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1 Initial')

        writeFile(repoPath, 'a.ts', 'v2')
        writeFile(repoPath, 'b.ts', 'v2')
        writeFile(repoPath, 'c.ts', 'v2')

        chmodSync(join(repoPath, 'c.ts'), 0o444)

        const result = await restoreService.execute(repoPath, cp1.id, {
          createSafety: false,
          cleanupFiles: []
        })

        expect(result.partial).toBe(true)
        expect(result.rollbackAttempted).toBe(false)
        expect(readFileSync(join(repoPath, 'a.ts'), 'utf-8')).toBe('v1')
        expect(readFileSync(join(repoPath, 'b.ts'), 'utf-8')).toBe('v1')
        expect(readFileSync(join(repoPath, 'c.ts'), 'utf-8')).toBe('v2')
      } finally {
        chmodSync(join(repoPath, 'c.ts'), 0o644)

        await cleanupTempRepo(repoPath)
      }
    })
  })

  // ─── PA-R02 — Cálculo de Remanescentes por Evidência ─────────────────────
  describe('PA-R02 — Cálculo de Remanescentes por Evidência', () => {
    it('Cenário A — Evidência correta com 3 checkpoints e arquivo deletado do disco', async () => {
      const repoPath = await createTempGitRepo()
      try {



        // Checkpoint A
        writeFile(repoPath, 'a.ts', 'v1')
        await stageAll(repoPath)
        await commit(repoPath, 'CP A')
        const cpA = await cpService.createCheckpoint(repoPath, 'CP A')
        await new Promise(r => setTimeout(r, 20))

        // Checkpoint B
        writeFile(repoPath, 'b.ts', 'v1')
        writeFile(repoPath, 'c.ts', 'v1')
        writeFile(repoPath, 'd.ts', 'v1')
        await stageAll(repoPath)
        await commit(repoPath, 'CP B')
        const cpB = await cpService.createCheckpoint(repoPath, 'CP B')
        await new Promise(r => setTimeout(r, 20))

        // Checkpoint C
        writeFile(repoPath, 'e.ts', 'v1')
        await stageAll(repoPath)
        await commit(repoPath, 'CP C')
        const cpC = await cpService.createCheckpoint(repoPath, 'CP C')

        // Deleta d.ts do disco
        unlinkSync(join(repoPath, 'd.ts'))

        const preview = await restoreService.preview(repoPath, cpA.id)
        const orphanFiles = preview.plan.orphanFiles

        // d.ts não deve estar presente pois não existe no disco
        expect(orphanFiles.find(f => f.relativePath === 'd.ts')).toBeUndefined()

        // a.ts está no alvo A, não é órfão
        expect(orphanFiles.find(f => f.relativePath === 'a.ts')).toBeUndefined()

        // b.ts, c.ts foram introduzidos em B e existem no disco
        const fileB = orphanFiles.find(f => f.relativePath === 'b.ts')
        const fileC = orphanFiles.find(f => f.relativePath === 'c.ts')
        expect(fileB?.originCheckpointId).toBe(cpB.id)
        expect(fileC?.originCheckpointId).toBe(cpB.id)

        // e.ts foi introduzido em C e existe no disco
        const fileE = orphanFiles.find(f => f.relativePath === 'e.ts')
        expect(fileE?.originCheckpointId).toBe(cpC.id)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário B — Arquivo em múltiplos checkpoints (primeiro checkpoint determina a origem)', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cpA = await cpService.createCheckpoint(repoPath, 'CP A')
        await new Promise(r => setTimeout(r, 20))

        writeFile(repoPath, 'x.ts', 'v1')
        const cpB = await cpService.createCheckpoint(repoPath, 'CP B')
        await new Promise(r => setTimeout(r, 20))

        writeFile(repoPath, 'y.ts', 'v1')
        const cpC = await cpService.createCheckpoint(repoPath, 'CP C')

        const preview = await restoreService.preview(repoPath, cpA.id)
        const fileX = preview.plan.orphanFiles.find(f => f.relativePath === 'x.ts')
        expect(fileX?.originCheckpointId).toBe(cpB.id)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })
  })

  // ─── PA-R03 — Unicidade do Ponto de Restauração ──────────────────────────
  describe('PA-R03 — Unicidade do Ponto de Restauração', () => {
    it('Cenário A — Marcação única', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cpA = await cpService.createCheckpoint(repoPath, 'CP A')
        const cpB = await cpService.createCheckpoint(repoPath, 'CP B')

        const success = await restoreService.markManual(repoPath, cpB.id)
        expect(success).toBe(true)

        const loadedA = await cpService.loadCheckpoint(repoPath, cpA.id)
        const loadedB = await cpService.loadCheckpoint(repoPath, cpB.id)

        expect(loadedA?.restoredAt ?? null).toBeNull()
        expect(loadedB?.restoredAt).not.toBeNull()
        expect(typeof loadedB?.restoredAt).toBe('string')
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário B — Estado corrompido com múltiplos restoredAt', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cpA = await cpService.createCheckpoint(repoPath, 'CP A')
        const cpB = await cpService.createCheckpoint(repoPath, 'CP B')
        const cpC = await cpService.createCheckpoint(repoPath, 'CP C')

        // Força estado corrompido com múltiplos restoredAt no banco/catálogo
        fakeCatalog.updateCheckpointCatalog(repoPath, cpA.id, { restoredAt: '2026-01-01T00:00:00Z' })
        fakeCatalog.updateCheckpointCatalog(repoPath, cpB.id, { restoredAt: '2026-01-02T00:00:00Z' })

        // Executa marcação manual em C
        await restoreService.markManual(repoPath, cpC.id)

        const loadedA = await cpService.loadCheckpoint(repoPath, cpA.id)
        const loadedB = await cpService.loadCheckpoint(repoPath, cpB.id)
        const loadedC = await cpService.loadCheckpoint(repoPath, cpC.id)

        expect(loadedA?.restoredAt ?? null).toBeNull()
        expect(loadedB?.restoredAt ?? null).toBeNull()
        expect(loadedC?.restoredAt).not.toBeNull()
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário C — Desmarcação via unmark()', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cpA = await cpService.createCheckpoint(repoPath, 'CP A')

        await restoreService.markManual(repoPath, cpA.id)
        let loadedA = await cpService.loadCheckpoint(repoPath, cpA.id)
        expect(loadedA?.restoredAt).not.toBeNull()

        const unmarkSuccess = await restoreService.unmark(repoPath, cpA.id)
        expect(unmarkSuccess).toBe(true)

        loadedA = await cpService.loadCheckpoint(repoPath, cpA.id)
        expect(loadedA?.restoredAt ?? null).toBeNull()
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })
  })

  // ─── PA-R04 — Limpeza Guardada e Segurança de Paths ─────────────────────
  describe('PA-R04 — Limpeza Guardada e Segurança de Paths', () => {
    it('Cenário A — Limpeza com sucesso', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        // Arquivo órfão no disco
        writeFile(repoPath, 'orphan.ts', 'remnant')

        const result = await restoreService.execute(repoPath, cp1.id, {
          createSafety: false,
          cleanupFiles: ['orphan.ts']
        })

        expect(result.cleanup?.removed).toBe(1)
        expect(existsSync(join(repoPath, 'orphan.ts'))).toBe(false)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário B — Restauração parcial não limpa arquivos', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        writeFile(repoPath, 'b.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        writeFile(repoPath, 'orphan.ts', 'remnant')
        chmodSync(join(repoPath, 'b.ts'), 0o444)

        const result = await restoreService.execute(repoPath, cp1.id, {
          createSafety: false,
          cleanupFiles: ['orphan.ts']
        })

        expect(result.partial).toBe(true)
        expect(result.cleanup).toBeUndefined()
        expect(existsSync(join(repoPath, 'orphan.ts'))).toBe(true)
      } finally {
        chmodSync(join(repoPath, 'b.ts'), 0o644)

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário C — Path traversal com ../../../etc/passwd', async () => {
      const repoPath = await createTempGitRepo()
      try {


        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        await expect(
          restoreService.execute(repoPath, cp1.id, {
            createSafety: false,
            cleanupFiles: ['../../../etc/passwd']
          })
        ).rejects.toThrow(/traversal/i)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário D — Path absoluto /etc/passwd', async () => {
      const repoPath = await createTempGitRepo()
      try {


        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        await expect(
          restoreService.execute(repoPath, cp1.id, {
            createSafety: false,
            cleanupFiles: ['/etc/passwd']
          })
        ).rejects.toThrow(/absoluto/i)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário E — Path Windows Drive C:\\Windows\\System32\\config', async () => {
      const repoPath = await createTempGitRepo()
      try {


        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        await expect(
          restoreService.execute(repoPath, cp1.id, {
            createSafety: false,
            cleanupFiles: ['C:\\Windows\\System32\\config']
          })
        ).rejects.toThrow(/absoluto/i)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário F — Path Windows UNC \\\\server\\share\\arquivo', async () => {
      const repoPath = await createTempGitRepo()
      try {


        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        await expect(
          restoreService.execute(repoPath, cp1.id, {
            createSafety: false,
            cleanupFiles: ['\\\\server\\share\\arquivo']
          })
        ).rejects.toThrow(/(absoluto|traversal|fora)/i)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário G — Cleanup com arquivo inexistente', async () => {
      const repoPath = await createTempGitRepo()
      try {


        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        const result = await restoreService.execute(repoPath, cp1.id, {
          createSafety: false,
          cleanupFiles: ['non_existent.ts']
        })

        expect(result.cleanup?.removed).toBe(0)
        expect(result.cleanup?.errors).toHaveLength(0)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })
  })

  // ─── PA-R05 — Preview Puro e Correto ─────────────────────────────────────
  describe('PA-R05 — Preview Puro e Correto', () => {
    it('Cenário A — Sem efeitos colaterais', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        const fileHashBefore = createHash('sha256').update(readFileSync(join(repoPath, 'a.ts'))).digest('hex')
        const actionsBefore = fakeActionLog.getActions(repoPath).length

        await restoreService.preview(repoPath, cp1.id)

        const fileHashAfter = createHash('sha256').update(readFileSync(join(repoPath, 'a.ts'))).digest('hex')
        const actionsAfter = fakeActionLog.getActions(repoPath).length

        expect(fileHashAfter).toBe(fileHashBefore)
        expect(actionsAfter).toBe(actionsBefore)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário B — Validação de permissões em preview', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        writeFile(repoPath, 'b.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        chmodSync(join(repoPath, 'b.ts'), 0o444)

        const result = await restoreService.preview(repoPath, cp1.id)

        expect(result.plan.canRestore).toContain('a.ts')
        expect(result.plan.cannotRestore).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: 'b.ts', reason: 'permissão negada' })
          ])
        )
      } finally {
        chmodSync(join(repoPath, 'b.ts'), 0o644)

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário C — Diretório pai inexistente (preview assume mkdir)', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'deep/dir/file.ts', 'content')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        // Exclui a pasta deep do disco
        unlinkSync(join(repoPath, 'deep/dir/file.ts'))

        const result = await restoreService.preview(repoPath, cp1.id)

        expect(result.plan.canRestore).toContain('deep/dir/file.ts')
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário D — Checkpoint inexistente retorna plano vazio', async () => {
      const repoPath = await createTempGitRepo()
      try {



        const result = await restoreService.preview(repoPath, 'cp_non_existent')

        expect(result.plan.targetCheckpointId).toBe('cp_non_existent')
        expect(result.plan.filesToWrite).toHaveLength(0)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })
  })

  // ─── PA-R06 — Integridade do Checkpoint Antes da Escrita ─────────────────
  describe('PA-R06 — Integridade do Checkpoint Antes da Escrita', () => {
    it('Cenário A — Checkpoint válido restaura com sucesso', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        const result = await restoreService.execute(repoPath, cp1.id, {
          createSafety: false,
          cleanupFiles: []
        })

        expect(result.restored).toBe(1)
        expect(result.failed).toBe(0)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário B — Checkpoint corrompido aborta sem escrever', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        // Altera o arquivo JSON no disco para corromper o hash SHA-256
        const jsonPath = join(repoPath, 'code_checkpoints', `${cp1.id}.json`)
        const cpData = JSON.parse(readFileSync(jsonPath, 'utf-8'))
        cpData.files['a.ts'].hash = 'deadbeef'
        writeFileSync(jsonPath, JSON.stringify(cpData, null, 2), 'utf-8')

        writeFile(repoPath, 'a.ts', 'v2')

        await expect(
          restoreService.execute(repoPath, cp1.id, {
            createSafety: false,
            cleanupFiles: []
          })
        ).rejects.toThrow(/corrompido/i)

        // O arquivo a.ts permanece v2
        expect(readFileSync(join(repoPath, 'a.ts'), 'utf-8')).toBe('v2')
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário C — Checkpoint arquivado (JSON deletado) lança erro', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        // Deleta o arquivo .json do checkpoint
        const jsonPath = join(repoPath, 'code_checkpoints', `${cp1.id}.json`)
        unlinkSync(jsonPath)

        await expect(
          restoreService.execute(repoPath, cp1.id, {
            createSafety: false,
            cleanupFiles: []
          })
        ).rejects.toThrow(/não encontrado/i)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })
  })

  // ─── PA-R07 — Contrato IPC do Restore Handler ─────────────────────────────
  describe('PA-R07 — Contrato IPC do Restore Handler', () => {
    beforeEach(() => {
      registeredHandlers.clear()
      vi.clearAllMocks()
      registerRestoreHandlers(restoreService)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('Cenário A — Registro de canais IPC de restauração', () => {
      const expectedChannels = [
        'restore:preview',
        'restore:execute',
        'restore:unmark',
        'restore:mark-manual'
      ]
      for (const ch of expectedChannels) {
        expect(registeredHandlers.has(ch)).toBe(true)
      }
    })

    it('Cenário B — Validação de repoPath vazio no preview', async () => {
      const res = await invokeHandler('restore:preview', '', 'cp_123')
      expect(res).toEqual({
        success: false,
        error: expect.stringMatching(/repoPath é obrigatório/)
      })
    })

    it('Cenário C — Validação de checkpointId malicioso no execute', async () => {
      const res = await invokeHandler('restore:execute', '/repo', '../../etc/passwd', { createSafety: false, cleanupFiles: [] })
      expect(res).toEqual({
        success: false,
        error: expect.stringMatching(/caracteres inválidos/)
      })
    })

    it('Cenário D — Validação de options não-objeto no execute', async () => {
      const res = await invokeHandler('restore:execute', '/repo', 'cp_123', 'invalid-options')
      expect(res).toEqual({
        success: false,
        error: expect.stringMatching(/options deve ser um objeto/)
      })
    })

    it('Cenário E — Validação de cleanupFiles com não-strings', async () => {
      const res = await invokeHandler('restore:execute', '/repo', 'cp_123', {
        createSafety: false,
        cleanupFiles: [123]
      })
      expect(res).toEqual({
        success: false,
        error: expect.stringMatching(/Cada elemento de cleanupFiles deve ser uma string/)
      })
    })

    it('Cenário F — Validação de plan sem stateHash', async () => {
      const res = await invokeHandler('restore:execute', '/repo', 'cp_123', {
        createSafety: false,
        cleanupFiles: [],
        plan: { targetCheckpointId: 'cp_123' }
      })
      expect(res).toEqual({
        success: false,
        error: expect.stringMatching(/stateHash é obrigatório/)
      })
    })

    it('Cenário G — Resultado parcial em restore:execute', async () => {
      vi.spyOn(RestoreService.prototype, 'execute').mockResolvedValueOnce({
        restored: 1,
        failed: 1,
        errors: ['falha ao escrever file.ts'],
        partial: true
      })

      const res = await invokeHandler('restore:execute', '/repo', 'cp_123', {
        createSafety: false,
        cleanupFiles: []
      })

      expect(res.success).toBe(false)
      expect(res.partial).toBe(true)
      expect(res.error).toContain('Restauração parcial: 1 restaurado(s), 1 falha(ram)')
    })

    it('Cenário H — planStale em restore:execute', async () => {
      vi.spyOn(RestoreService.prototype, 'execute').mockResolvedValueOnce({
        restored: 0,
        failed: 0,
        errors: ['O estado do projeto mudou desde o preview. Gere um novo preview.'],
        partial: false,
        planStale: true
      })

      const res = await invokeHandler('restore:execute', '/repo', 'cp_123', {
        createSafety: false,
        cleanupFiles: [],
        plan: { targetCheckpointId: 'cp_123', stateHash: 'hash' } as any
      })

      expect(res.success).toBe(false)
      expect(res.planStale).toBe(true)
      expect(res.error).toContain('estado do projeto mudou')
    })
  })

  // ─── PA-R08 — Falhas de Consistência Pós-Escrita ─────────────────────────
  describe('PA-R08 — Falhas de Consistência Pós-Escrita', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('Cenário A — Falha em markRestorePoint após escrita', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        writeFile(repoPath, 'a.ts', 'v2')

        // Mocka updateCheckpointMetadata para lançar erro durante a marcação
        vi.spyOn(cpService, 'updateCheckpointMetadata').mockRejectedValueOnce(new Error('Erro no DB metadata update'))

        const result = await restoreService.execute(repoPath, cp1.id, {
          createSafety: false,
          cleanupFiles: []
        })

        expect(result.restored).toBe(1)
        expect(result.markFailed).toBe(true)
        // Arquivo foi restaurado no disco
        expect(readFileSync(join(repoPath, 'a.ts'), 'utf-8')).toBe('v1')

        // Metadata de restoredAt continuou null/undefined devido à falha
        const loaded = await cpService.loadCheckpoint(repoPath, cp1.id)
        expect(loaded?.restoredAt ?? null).toBeNull()
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário B — Falha em performCleanup após sucesso', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        // Cria orphan.ts como diretório não-vazio; unlink() lança EISDIR
        const { mkdirSync, writeFileSync: writeSync } = await import('fs')
        mkdirSync(join(repoPath, 'orphan.ts', 'sub'), { recursive: true })
        writeSync(join(repoPath, 'orphan.ts', 'sub', 'file.txt'), 'data')

        const result = await restoreService.execute(repoPath, cp1.id, {
          createSafety: false,
          cleanupFiles: ['orphan.ts']
        })

        expect(result.cleanup?.removed).toBe(0)
        expect(result.cleanup?.errors.length).toBeGreaterThan(0)
        expect(existsSync(join(repoPath, 'orphan.ts'))).toBe(true)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário C — Falha de log de action no banco não aborta operação', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')

        writeFile(repoPath, 'a.ts', 'v2')

        // Mock fakeActionLog insertAction to throw
        vi.spyOn(fakeActionLog, 'insertAction').mockImplementation(() => {
          throw new Error('Banco SQLite inacessível')
        })

        const result = await restoreService.execute(repoPath, cp1.id, {
          createSafety: true,
          cleanupFiles: []
        })

        expect(result.restored).toBe(1)
        expect(result.partial).toBe(false)
        expect(readFileSync(join(repoPath, 'a.ts'), 'utf-8')).toBe('v1')
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })
  })

  // ─── PA-R09 — Concorrência, Observabilidade e Estado Obsoleto Real ─────────
  describe('PA-R09 — Concorrência, Observabilidade e Estado Obsoleto Real', () => {
    it('Cenário A — Concorrência de restaurações no mesmo repo é rejeitada', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')
        writeFile(repoPath, 'a.ts', 'v2')

        // Inicia a primeira restauração mas não aguarda (cria um delay artificial via mock)
        const originalWrite = (restoreService as any).writeCheckpointFiles.bind(restoreService)
        vi.spyOn(restoreService as any, 'writeCheckpointFiles').mockImplementation(async (...args: any[]) => {
          await new Promise(r => setTimeout(r, 100)) // Delay para garantir sobreposição
          return originalWrite(...args)
        })

        const promise1 = restoreService.execute(repoPath, cp1.id, { createSafety: false, cleanupFiles: [] })
        
        // Tenta executar a segunda restauração simultaneamente
        await expect(
          restoreService.execute(repoPath, cp1.id, { createSafety: false, cleanupFiles: [] })
        ).rejects.toThrow(/em andamento/i)

        // Aguarda a primeira terminar para não vazar promises
        await promise1
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário B — operationId consistente em todos os logs da operação', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')
        writeFile(repoPath, 'orphan.ts', 'remnant')
        writeFile(repoPath, 'a.ts', 'v2')

        await restoreService.execute(repoPath, cp1.id, {
          createSafety: true,
          cleanupFiles: ['orphan.ts']
        })

        const actions = fakeActionLog.getActions(repoPath)
        const restoreActions = actions.filter(a => a.operationId)
        // Deve haver logs de backup, restauração e limpeza
        expect(restoreActions.length).toBeGreaterThanOrEqual(3)
        
        // Todos devem compartilhar o mesmo operationId
        const operationIds = new Set(restoreActions.map(a => a.operationId))
        expect(operationIds.size).toBe(1)
        expect(typeof restoreActions[0].operationId).toBe('string')
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário C — planStale com infraestrutura real (fluxo preview → modify → execute)', async () => {
      const repoPath = await createTempGitRepo()
      try {



        writeFile(repoPath, 'a.ts', 'v1')
        const cp1 = await cpService.createCheckpoint(repoPath, 'CP1')
        writeFile(repoPath, 'a.ts', 'v2')

        // 1. Gera o preview (plano congelado)
        const previewResult = await restoreService.preview(repoPath, cp1.id)
        const plan = previewResult.plan

        // 2. Modifica o estado do disco após o preview (invalida o stateHash do plano)
        writeFile(repoPath, 'a.ts', 'v3')

        // 3. Tenta executar com o plano antigo
        const result = await restoreService.execute(repoPath, cp1.id, {
          createSafety: true, // Solicita backup, mas NÃO deve ser criado devido ao planStale
          cleanupFiles: [],
          plan
        })

        // 4. Valida que abortou sem executar
        expect(result.planStale).toBe(true)
        expect(result.restored).toBe(0)
        expect(result.safetyBackupId).toBeUndefined() // Backup não foi criado
        
        // O arquivo no disco permanece v3 (nenhuma escrita ocorreu)
        expect(readFileSync(join(repoPath, 'a.ts'), 'utf-8')).toBe('v3')
        
        // Nenhum log de restauração ou backup foi registrado
        const actions = fakeActionLog.getActions(repoPath)
        expect(actions.some(a => a.actionType === 'checkpoint_created')).toBe(false)
        expect(actions.some(a => a.actionType === 'checkpoint_restored')).toBe(false)
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })
  })

  // ─── PA-R10 — Resumo de Mudanças do Preview ──────────────────────────────
  describe('PA-R10 — Resumo de Mudanças do Preview', () => {
    it('Cenário A — Status e contagens de mudanças (modified, created, unchanged, blocked)', async () => {
      const repoPath = await createTempGitRepo()
      try {



        // Cria arquivos originais para o checkpoint
        writeFile(repoPath, 'a.ts', 'linha1\nlinha2_cp')
        writeFile(repoPath, 'b.ts', 'b1\nb2\nb3')
        writeFile(repoPath, 'c.ts', 'c1\nc2')
        writeFile(repoPath, 'd.ts', 'd_cp')

        const cp = await cpService.createCheckpoint(repoPath, 'CP Full')

        // Modifica arquivos no disco para simular os 4 estados:
        // a.ts: modificado (1 linha entra, 1 linha sai)
        writeFile(repoPath, 'a.ts', 'linha1\nlinha2_disco')
        // b.ts: deletado do disco (será criado com 3 linhas)
        unlinkSync(join(repoPath, 'b.ts'))
        // c.ts: inalterado no disco
        // d.ts: bloqueado por permissão (read-only)
        writeFile(repoPath, 'd.ts', 'd_disco')
        chmodSync(join(repoPath, 'd.ts'), 0o444)

        const result = await restoreService.preview(repoPath, cp.id)
        const changes = result.plan.fileChanges

        expect(changes).toHaveLength(4)

        // a.ts -> modified (1 adicionada, 1 removida)
        const changeA = changes.find(c => c.relativePath === 'a.ts')
        expect(changeA).toEqual({
          relativePath: 'a.ts',
          status: 'modified',
          addedLines: 1,
          removedLines: 1
        })

        // b.ts -> created (3 adicionadas, 0 removidas)
        const changeB = changes.find(c => c.relativePath === 'b.ts')
        expect(changeB).toEqual({
          relativePath: 'b.ts',
          status: 'created',
          addedLines: 3,
          removedLines: 0
        })

        // c.ts -> unchanged (0/0)
        const changeC = changes.find(c => c.relativePath === 'c.ts')
        expect(changeC).toEqual({
          relativePath: 'c.ts',
          status: 'unchanged',
          addedLines: 0,
          removedLines: 0
        })

        // d.ts -> blocked (permissão negada)
        const changeD = changes.find(c => c.relativePath === 'd.ts')
        expect(changeD).toEqual({
          relativePath: 'd.ts',
          status: 'blocked',
          addedLines: null,
          removedLines: null,
          reason: 'permissão negada'
        })
      } finally {
        if (existsSync(join(repoPath, 'd.ts'))) {
          chmodSync(join(repoPath, 'd.ts'), 0o644)
        }

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário B — Teto de segurança para arquivos com mais de 200.000 caracteres', async () => {
      const repoPath = await createTempGitRepo()
      try {



        // Conteúdo grande (> 200.000 chars)
        const largeCpContent = 'a'.repeat(210_000)
        const largeDiskContent = 'b'.repeat(210_000)

        writeFile(repoPath, 'large.ts', largeCpContent)
        const cp = await cpService.createCheckpoint(repoPath, 'CP Large')

        writeFile(repoPath, 'large.ts', largeDiskContent)

        const result = await restoreService.preview(repoPath, cp.id)
        const changeLarge = result.plan.fileChanges.find(c => c.relativePath === 'large.ts')

        expect(changeLarge).toBeDefined()
        expect(changeLarge?.status).toBe('modified')
        expect(changeLarge?.addedLines).toBeNull()
        expect(changeLarge?.removedLines).toBeNull()
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })

    it('Cenário C — Checkpoint inexistente retorna plan com fileChanges vazio', async () => {
      const repoPath = await createTempGitRepo()
      try {



        const result = await restoreService.preview(repoPath, 'cp_inexistente')
        expect(result.plan.fileChanges).toEqual([])
      } finally {

        await cleanupTempRepo(repoPath)
      }
    })
  })
})
