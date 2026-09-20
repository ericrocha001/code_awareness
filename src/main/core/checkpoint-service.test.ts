/*
-T ---
*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { CheckpointService } from './checkpoint-service'
import { GitService } from './git-service'
import { FakeCheckpointCatalogPort } from './fake-ports'
import {
  createTempGitRepo,
  cleanupTempRepo,
  writeFile,
  stageAll,
  commit
} from './git-test-helpers'
import type { CheckpointData, Campaign } from '../../shared/types'

/**
 * Calcula o hash SHA-256 de uma string em utf-8 e retorna o hex.
 * Espelha exatamente o oráculo usado por checkpoint-service.ts na criação do snapshot.
 */
function computeSha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

/**
 * Lê o JSON de um checkpoint do disco em code_checkpoints/<id>.json.
 * Retorna o objeto parseado ou null se o arquivo não existir ou estiver corrompido.
 */
function readCheckpointJson(repoPath: string, checkpointId: string): CheckpointData | null {
  const filePath = join(repoPath, 'code_checkpoints', checkpointId + '.json')
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as CheckpointData
  } catch {
    return null
  }
}

/**
 * Cria um arquivo binário com byte nulo nos primeiros 4096 bytes.
 * Usado pela PA-02 para testar exclusão de binários.
 */
function writeBinaryFile(repoPath: string, relativePath: string, size: number = 10000): void {
  const buffer = Buffer.alloc(size, 0)
  writeFileSync(join(repoPath, relativePath), buffer)
}

/**
 * Cria um arquivo com tamanho específico em bytes.
 * Usado pela PA-02 para testar fronteira de 2MB.
 */
function writeLargeFile(repoPath: string, relativePath: string, sizeBytes: number): void {
  const content = 'x'.repeat(sizeBytes)
  writeFileSync(join(repoPath, relativePath), content, 'utf-8')
}

/**
 * Cria um arquivo JSON de checkpoint diretamente no disco (simular legado pré-banco).
 * O helper writeFile do git-test-helpers já cria diretórios intermediários (code_checkpoints/).
 */
function writeLegacyCheckpoint(repoPath: string, id: string, name: string, createdAt?: string): void {
  const data: CheckpointData = {
    id,
    name,
    createdAt: createdAt || new Date().toISOString(),
    files: { 'test.ts': { content: 'legacy content\n', hash: 'abc123', size: 15 } }
  }
  writeFile(repoPath, `code_checkpoints/${id}.json`, JSON.stringify(data))
}

describe('CheckpointService', () => {
  let repoPath: string
  let fakeCatalog: FakeCheckpointCatalogPort

  beforeEach(() => {
    fakeCatalog = new FakeCheckpointCatalogPort()
  })

  afterEach(async () => {
    if (repoPath) await cleanupTempRepo(repoPath)
    repoPath = ''
  })

  // ─── PA-01 — Captura Íntegra do Snapshot ─────────────────────────────────
  describe('PA-01 — Captura Íntegra do Snapshot', () => {
    const seedContents: Record<string, string> = {
      'a.ts': 'export const a = 1\n',
      'src/b.ts': 'export const b = 2\n',
      'src/utils/c.ts': 'export const c = 3\n'
    }

    it('loadCheckpoint retorna exatamente os arquivos capturados com conteúdo e hash corretos', async () => {
      repoPath = await createTempGitRepo()
      for (const [relative, content] of Object.entries(seedContents)) {
        writeFile(repoPath, relative, content)
      }
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'Captura Inicial')

      expect(typeof result.id).toBe('string')
      expect(result.id.length).toBeGreaterThan(0)
      expect(result.name).toBe('Captura Inicial')
      expect(Object.keys(result.files).length).toBe(3)

      for (const [relative, content] of Object.entries(seedContents)) {
        const entry = result.files[relative]
        expect(entry).toBeDefined()
        expect(entry.content).toBe(content)
        expect(entry.hash).toBe(computeSha256(content))
        expect(entry.size).toBeGreaterThan(0)
      }

      const loaded = await service.loadCheckpoint(repoPath, result.id)
      expect(loaded).not.toBeNull()
      expect(loaded!.name).toBe('Captura Inicial')
      expect(Object.keys(loaded!.files).length).toBe(3)

      for (const [relative, content] of Object.entries(seedContents)) {
        expect(loaded!.files[relative].content).toBe(content)
        expect(loaded!.files[relative].hash).toBe(computeSha256(content))
      }
    })
  })

  // ─── PA-17 — Imutabilidade do Snapshot ───────────────────────────────────
  describe('PA-17 — Imutabilidade do Snapshot', () => {
    it('mudanças no disco após a captura não afetam o snapshot carregado', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'a.ts', 'v1')
      writeFile(repoPath, 'b.ts', 'v1')
      writeFile(repoPath, 'c.ts', 'v1')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const created = await service.createCheckpoint(repoPath, 'Snapshot Imutável')

      // Modifica o disco após a captura
      writeFile(repoPath, 'a.ts', 'v2-modificado')
      writeFile(repoPath, 'b.ts', 'v2-modificado')
      writeFile(repoPath, 'd.ts', 'arquivo novo')
      unlinkSync(join(repoPath, 'c.ts'))

      const loaded = await service.loadCheckpoint(repoPath, created.id)
      expect(loaded).not.toBeNull()

      // Exatamente os 3 arquivos originais permanecem no snapshot
      expect(Object.keys(loaded!.files).length).toBe(3)
      expect(loaded!.files['a.ts'].content).toBe('v1')
      expect(loaded!.files['b.ts'].content).toBe('v1')
      expect(loaded!.files['c.ts'].content).toBe('v1')
      expect('d.ts' in loaded!.files).toBe(false)

      // Hashes permanecem os originais
      expect(loaded!.files['a.ts'].hash).toBe(computeSha256('v1'))
      expect(loaded!.files['b.ts'].hash).toBe(computeSha256('v1'))
      expect(loaded!.files['c.ts'].hash).toBe(computeSha256('v1'))
    })
  })

  // ─── PA-04 — Integridade do JSON Persistido ──────────────────────────────
  describe('PA-04 — Integridade do JSON Persistido', () => {
    it('JSON válido é gravado no disco com os campos esperados', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const t = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'JSON Válido')

      const json = readCheckpointJson(repoPath, result.id)
      expect(json).not.toBeNull()
      expect(json!.id).toBe(result.id)
      expect(json!.name).toBe('JSON Válido')
      expect(json!.files['test.ts']).toBeDefined()
      expect(json!.files['test.ts'].content).toBe('export const t = 1\n')
      expect(typeof json!.createdAt).toBe('string')
      // ISO 8601 válida (Date.parse não produz NaN)
      expect(Number.isNaN(Date.parse(json!.createdAt))).toBe(false)
    })

    it('JSON corrompido nunca retorna dados parciais', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const t = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'JSON Corrompido')

      // Corrompe o JSON no disco (truncado)
      writeFileSync(join(repoPath, 'code_checkpoints', result.id + '.json'), '{"broken": true', 'utf-8')

      const loaded = await service.loadCheckpoint(repoPath, result.id)
      expect(loaded).toBeNull()
    })
  })

  // ─── PA-14 — Unicidade do ID ──────────────────────────────────────────────
  describe('PA-14 — Unicidade do ID', () => {
    it('50 checkpoints criados em sequência rápida produzem IDs únicos', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const t = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const ids: string[] = []
      for (let i = 1; i <= 50; i++) {
        const cp = await service.createCheckpoint(repoPath, `CP ${i}`)
        expect(cp.id.length).toBeGreaterThan(0)
        ids.push(cp.id)
      }

      expect(new Set(ids).size).toBe(50)
    }, 20000)
  })

  // ─── PA-05 — Banco como Fonte Autoritativa de Metadados ─────────────────
  describe('PA-05 — Banco como Fonte Autoritativa de Metadados', () => {
    it('metadados no banco prevalecem sobre o JSON congelado e atualizações não reescrevem o JSON', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const x = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'Checkpoint Original', {
        instructions: 'v1',
        agentSummary: 'resumo-v1'
      })

      const jsonBefore = readCheckpointJson(repoPath, result.id)
      expect(jsonBefore).not.toBeNull()
      expect(jsonBefore!.instructions).toBe('v1')
      expect(jsonBefore!.agentSummary).toBe('resumo-v1')

      const updated = await service.updateCheckpointMetadata(repoPath, result.id, {
        instructions: 'v2',
        agentSummary: 'resumo-v2'
      })
      expect(updated).toBe(true)

      const jsonAfter = readCheckpointJson(repoPath, result.id)
      expect(jsonAfter).not.toBeNull()
      expect(jsonAfter!.instructions).toBe('v1')
      expect(jsonAfter!.agentSummary).toBe('resumo-v1')

      const loaded = await service.loadCheckpoint(repoPath, result.id)
      expect(loaded).not.toBeNull()
      expect(loaded!.instructions).toBe('v2')
      expect(loaded!.agentSummary).toBe('resumo-v2')

      const catalogList = await service.listCheckpoints(repoPath)
      const catalogRecord = catalogList.find(cp => cp.id === result.id)
      expect(catalogRecord).toBeDefined()
      expect(catalogRecord!.instructions).toBe('v2')
      expect(catalogRecord!.agentSummary).toBe('resumo-v2')
    })
  })

  // ─── PA-06 — Best-Effort do Banco no Load ────────────────────────────────
  describe('PA-06 — Best-Effort do Banco no Load', () => {
    it('quando o registro no banco está ausente, loadCheckpoint retorna os dados congelados do JSON sem lançar erro', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const x = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'CP Test', {
        instructions: 'instrução original'
      })

      fakeCatalog.deleteCheckpointCatalog(repoPath, result.id)

      const loaded = await service.loadCheckpoint(repoPath, result.id)
      expect(loaded).not.toBeNull()
      expect(loaded!.files['test.ts']).toBeDefined()
      expect(loaded!.files['test.ts'].content).toBe('export const x = 1\n')
      expect(loaded!.instructions).toBe('instrução original')
    })
  })

  // ─── PA-10 — Renomeação com Validação ────────────────────────────────────
  describe('PA-10 — Renomeação com Validação', () => {
    it('Cenário A — rejeita nome vazio', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const x = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const cp = await service.createCheckpoint(repoPath, 'Original')

      await expect(service.renameCheckpoint(repoPath, cp.id, '')).rejects.toThrow(/não pode estar vazio/)
    })

    it('Cenário B — rejeita nome duplicado', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const x = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      await service.createCheckpoint(repoPath, 'Checkpoint A')
      const cpB = await service.createCheckpoint(repoPath, 'Checkpoint B')

      await expect(service.renameCheckpoint(repoPath, cpB.id, 'Checkpoint A')).rejects.toThrow(/Já existe/)
    })

    it('Cenário C — sucesso atualiza apenas o banco e preserva o JSON congelado', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const x = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const cp = await service.createCheckpoint(repoPath, 'Original')

      const jsonBefore = readCheckpointJson(repoPath, cp.id)
      expect(jsonBefore!.name).toBe('Original')

      const result = await service.renameCheckpoint(repoPath, cp.id, 'Renomeado')
      expect(result).toBe(true)

      const jsonAfter = readCheckpointJson(repoPath, cp.id)
      expect(jsonAfter!.name).toBe('Original')

      const loaded = await service.loadCheckpoint(repoPath, cp.id)
      expect(loaded!.name).toBe('Renomeado')
    })

    it('Cenário D — renomear para o mesmo nome não é considerado duplicata e retorna true', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const x = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const cp = await service.createCheckpoint(repoPath, 'Mesmo Nome')

      const result = await service.renameCheckpoint(repoPath, cp.id, 'Mesmo Nome')
      expect(result).toBe(true)
    })
  })

  // ─── PA-11 — Vínculos de Campanha ────────────────────────────────────────
  describe('PA-11 — Vínculos de Campanha', () => {
    it('Cenário A — normaliza e deduplica os IDs de campanha', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const x = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const cp = await service.createCheckpoint(repoPath, 'CP Campaign')

      const camp1Id = 'camp_1'
      const camp2Id = 'camp_2'

      const inputIds = [camp1Id, camp1Id, '', camp2Id, null as any, 42 as any]
      const result = await service.setCheckpointCampaigns(repoPath, cp.id, inputIds)
      expect(result).toBe(true)

      const list = await service.listCheckpoints(repoPath)
      const summary = list.find(item => item.id === cp.id)
      expect(summary).toBeDefined()
      expect(summary!.campaignIds).toHaveLength(2)
      expect(summary!.campaignIds).toEqual([camp1Id, camp2Id])
    })

    it('Cenário B — limpa todos os vínculos enviando array vazio', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const x = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const cp = await service.createCheckpoint(repoPath, 'CP Clean')

      await service.setCheckpointCampaigns(repoPath, cp.id, ['camp_1'])

      const result = await service.setCheckpointCampaigns(repoPath, cp.id, [])
      expect(result).toBe(true)

      const list = await service.listCheckpoints(repoPath)
      const summary = list.find(item => item.id === cp.id)
      expect(summary).toBeDefined()
      expect(summary!.campaignIds).toEqual([])
    })

    it('Cenário C — rejeita path traversal no checkpointId sem lançar', async () => {
      repoPath = await createTempGitRepo()
      const service = new CheckpointService(fakeCatalog, new GitService())

      const result = await service.setCheckpointCampaigns(repoPath, '../../../etc', ['camp1'])
      expect(result).toBe(false)
    })
  })

  // ─── PA-15 — deleteCheckpoint com JSON Ausente ───────────────────────────
  describe('PA-15 — deleteCheckpoint com JSON Ausente', () => {
    it('deleteCheckpoint retorna true e remove do catálogo mesmo quando o JSON já não existe no disco', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const x = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const cp = await service.createCheckpoint(repoPath, 'CP to Delete')

      const jsonBefore = readCheckpointJson(repoPath, cp.id)
      expect(jsonBefore).not.toBeNull()

      const jsonPath = join(repoPath, 'code_checkpoints', cp.id + '.json')
      unlinkSync(jsonPath)

      const deleted = await service.deleteCheckpoint(repoPath, cp.id)
      expect(deleted).toBe(true)

      const list = await service.listCheckpoints(repoPath)
      const found = list.find(item => item.id === cp.id)
      expect(found).toBeUndefined()
    })
  })

  // ─── PA-03 — Defesa Contra Path Traversal ─────────────────────────────────
  describe('PA-03 — Defesa Contra Path Traversal', () => {
    it('Cenário A — loadCheckpoint rejeita path traversal e retorna null sem lançar', async () => {
      repoPath = await createTempGitRepo()
      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.loadCheckpoint(repoPath, '../../../etc/passwd')
      expect(result).toBeNull()
    })

    it('Cenário B — deleteCheckpoint rejeita path traversal e retorna false sem lançar', async () => {
      repoPath = await createTempGitRepo()
      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.deleteCheckpoint(repoPath, '..\\..\\secret')
      expect(result).toBe(false)
    })

    it('Cenário C — updateCheckpointMetadata rejeita path traversal e retorna false sem lançar', async () => {
      repoPath = await createTempGitRepo()
      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.updateCheckpointMetadata(repoPath, '../../../etc', { instructions: 'hack' })
      expect(result).toBe(false)
    })

    it('Cenário D — renameCheckpoint rejeita path traversal e lança Error', async () => {
      repoPath = await createTempGitRepo()
      const service = new CheckpointService(fakeCatalog, new GitService())
      await expect(service.renameCheckpoint(repoPath, '../../../etc', 'Novo Nome')).rejects.toThrow(/inválido/)
    })

    it('Cenário E — setCheckpointCampaigns rejeita path traversal e retorna false sem lançar', async () => {
      repoPath = await createTempGitRepo()
      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.setCheckpointCampaigns(repoPath, '../../../etc', ['camp1'])
      expect(result).toBe(false)
    })

    it('Cenário F — generateDiffBetween rejeita path traversal e retorna mensagem de erro', async () => {
      repoPath = await createTempGitRepo()
      const service = new CheckpointService(fakeCatalog, new GitService())
      const diff = await service.generateDiffBetween(repoPath, '../../../etc', '../../../etc')
      expect(diff).toMatch(/Erro|não encontrado/)
    })

    it('Cenário G — getChangedFiles rejeita path traversal e retorna array vazio', async () => {
      repoPath = await createTempGitRepo()
      const service = new CheckpointService(fakeCatalog, new GitService())
      const files = await service.getChangedFiles(repoPath, '../../../etc', '../../../etc')
      expect(files).toEqual([])
    })
  })

  // ─── PA-02 — Exclusão de Binários e Arquivos Grandes ──────────────────────
  describe('PA-02 — Exclusão de Binários e Arquivos Grandes', () => {
    it('Cenário A — arquivos binários com byte nulo nos primeiros 4096 bytes são excluídos', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'text.ts', 'export const text = "ok"\n')
      writeBinaryFile(repoPath, 'binary.bin', 10000)
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'Binário Excluído')

      expect(result.files['text.ts']).toBeDefined()
      expect(result.files['binary.bin']).toBeUndefined()
    })

    it('Cenário B — arquivos maiores que 2MB são excluídos do snapshot', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'text.ts', 'export const text = "ok"\n')
      writeLargeFile(repoPath, 'large.txt', 3 * 1024 * 1024)
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'Arquivo Grande Excluído')

      expect(result.files['text.ts']).toBeDefined()
      expect(result.files['large.txt']).toBeUndefined()
    })

    it('Cenário C — arquivo com tamanho exato de 2MB é incluído no snapshot', async () => {
      repoPath = await createTempGitRepo()
      writeLargeFile(repoPath, 'exact2mb.txt', 2 * 1024 * 1024)
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'Fronteira 2MB Exata')

      expect(result.files['exact2mb.txt']).toBeDefined()
      expect(result.files['exact2mb.txt'].size).toBe(2 * 1024 * 1024)
    })

    it('Cenário D — arquivo com 2MB + 1 byte é excluído do snapshot', async () => {
      repoPath = await createTempGitRepo()
      writeLargeFile(repoPath, 'over2mb.txt', 2 * 1024 * 1024 + 1)
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'Fronteira 2MB + 1')

      expect(result.files['over2mb.txt']).toBeUndefined()
    })

    it('Cenário E — arquivo com byte nulo após os primeiros 4096 bytes é incluído', async () => {
      repoPath = await createTempGitRepo()
      const textPrefix = Buffer.from('a'.repeat(4096), 'utf-8')
      const binarySuffix = Buffer.alloc(4096, 0)
      const mixedContent = Buffer.concat([textPrefix, binarySuffix])
      writeFileSync(join(repoPath, 'mixed.dat'), mixedContent)
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'Nulo Após 4096')

      expect(result.files['mixed.dat']).toBeDefined()
    })
  })

  // ─── PA-18 — Cenários de getAllFiles ──────────────────────────────────────
  describe('PA-18 — Cenários de getAllFiles', () => {
    it('Cenário A — inclui arquivos tracked', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'tracked.ts', 'export const tracked = true\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'Tracked File')

      expect(result.files['tracked.ts']).toBeDefined()
    })

    it('Cenário B — inclui arquivos untracked', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'tracked.ts', 'export const tracked = true\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      writeFile(repoPath, 'untracked.ts', 'export const untracked = true\n')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'Untracked File')

      expect(result.files['tracked.ts']).toBeDefined()
      expect(result.files['untracked.ts']).toBeDefined()
    })

    it('Cenário C — exclui a pasta code_checkpoints', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'tracked.ts', 'export const tracked = true\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const dummyCheckpoint: CheckpointData = {
        id: 'internal',
        name: 'internal',
        createdAt: new Date().toISOString(),
        files: {}
      }
      writeFile(repoPath, 'code_checkpoints/internal.json', JSON.stringify(dummyCheckpoint))

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'Exclui Checkpoints Dir')

      expect(result.files['tracked.ts']).toBeDefined()
      for (const filePath of Object.keys(result.files)) {
        expect(filePath.startsWith('code_checkpoints')).toBe(false)
      }
    })

    it('Cenário D — exclui a pasta .git', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'tracked.ts', 'export const tracked = true\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      expect(existsSync(join(repoPath, '.git'))).toBe(true)

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'Exclui Git Dir')

      expect(result.files['tracked.ts']).toBeDefined()
      for (const filePath of Object.keys(result.files)) {
        expect(filePath.startsWith('.git')).toBe(false)
      }
    })

    it('Cenário E — exclui arquivos ignorados pelo .gitignore', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, '.gitignore', '*.log\n')
      writeFile(repoPath, 'tracked.ts', 'export const tracked = true\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      writeFile(repoPath, 'debug.log', 'some log content\n')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const result = await service.createCheckpoint(repoPath, 'Exclui Ignored')

      expect(result.files['tracked.ts']).toBeDefined()
      expect(result.files['debug.log']).toBeUndefined()
    })
  })

  // ─── PA-07 — Formato do Diff Consistente com DiffService ───────────────
  describe('PA-07 — Formato do Diff Consistente com DiffService', () => {
    it('Cenário A — exibe arquivo modificado com blocos 🟥 e 🟩 e hunks numerados', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const a = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'v1')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const cpA = await service.createCheckpoint(repoPath, 'Versão 1')

      writeFile(repoPath, 'test.ts', 'export const a = 2\nexport const b = 3\n')
      await stageAll(repoPath)
      await commit(repoPath, 'v2')
      const cpB = await service.createCheckpoint(repoPath, 'Versão 2')

      const diff = await service.generateDiffBetween(repoPath, cpA.id, cpB.id)

      expect(diff).toContain('## 📄 `test.ts` (modificado)')
      expect(diff).toContain('### 🔍 Hunk 1')
      expect(diff).toContain('#### 🟥 [Código Original / Removido]')
      expect(diff).toContain('#### 🟩 [Código Novo / Adicionado]')
      expect(diff).toContain('export const a = 1')
      expect(diff).toContain('export const a = 2')
      expect(diff).toContain('export const b = 3')
    })

    it('Cenário B — exibe arquivo adicionado com bloco 🟩', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'a.ts', 'export const a = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'v1')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const cpA = await service.createCheckpoint(repoPath, 'CP A')

      writeFile(repoPath, 'b.ts', 'export const novo = true\n')
      await stageAll(repoPath)
      await commit(repoPath, 'v2')
      const cpB = await service.createCheckpoint(repoPath, 'CP B')

      const diff = await service.generateDiffBetween(repoPath, cpA.id, cpB.id)

      expect(diff).toContain('## 📄 `b.ts` (adicionado)')
      expect(diff).toContain('#### 🟩 [Código Novo / Adicionado]')
      expect(diff).toContain('export const novo = true')
    })

    it('Cenário C — exibe arquivo excluído com bloco 🟥', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'a.ts', 'export const a = 1\n')
      writeFile(repoPath, 'b.ts', 'export const b = 2\n')
      await stageAll(repoPath)
      await commit(repoPath, 'v1')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const cpA = await service.createCheckpoint(repoPath, 'CP A')

      unlinkSync(join(repoPath, 'b.ts'))
      await stageAll(repoPath)
      await commit(repoPath, 'v2')
      const cpB = await service.createCheckpoint(repoPath, 'CP B')

      const diff = await service.generateDiffBetween(repoPath, cpA.id, cpB.id)

      expect(diff).toContain('## 📄 `b.ts` (excluído)')
      expect(diff).toContain('#### 🟥 [Código Original / Removido]')
      expect(diff).toContain('export const b = 2')
    }, 15000)
  })

  // ─── PA-08 — Primeiro Checkpoint Compara com Disco ───────────────────────
  describe('PA-08 — Primeiro Checkpoint Compara com Disco', () => {
    it('Cenário A — compara o checkpoint com o estado atual do disco quando toCheckpointId === fromCheckpointId', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const v1 = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const cp = await service.createCheckpoint(repoPath, 'Inicial')

      writeFile(repoPath, 'test.ts', 'export const v2 = 2\n')

      const diff = await service.generateDiffBetween(repoPath, cp.id, cp.id)

      expect(diff).toContain('## 📄 `test.ts` (modificado)')
      expect(diff).toContain('export const v1 = 1')
      expect(diff).toContain('export const v2 = 2')
    })

    it('Cenário B — retorna mensagem amigável se não houver alterações no disco', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const v1 = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const cp = await service.createCheckpoint(repoPath, 'Inicial')

      const diff = await service.generateDiffBetween(repoPath, cp.id, cp.id)

      expect(diff).toContain('Nenhuma alteração detectada')
    })
  })

  // ─── PA-09 — Ordenação de getChangedFiles ────────────────────────────────
  describe('PA-09 — Ordenação de getChangedFiles', () => {
    it('Cenário A — ordena arquivos alterados por mtime descendente com deletados no final', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'a.ts', 'content a v1\n')
      writeFile(repoPath, 'b.ts', 'content b v1\n')
      writeFile(repoPath, 'c.ts', 'content c v1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const cpA = await service.createCheckpoint(repoPath, 'CP A')

      // Modifica a.ts primeiro
      writeFile(repoPath, 'a.ts', 'content a v2\n')

      // Pausa para garantir mtime distinto
      await new Promise(resolve => setTimeout(resolve, 150))

      // Modifica b.ts depois (mtime mais recente)
      writeFile(repoPath, 'b.ts', 'content b v2\n')

      // Deleta c.ts do disco
      unlinkSync(join(repoPath, 'c.ts'))

      await stageAll(repoPath)
      await commit(repoPath, 'v2')
      const cpB = await service.createCheckpoint(repoPath, 'CP B')

      const changedFiles = await service.getChangedFiles(repoPath, cpA.id, cpB.id)

      expect(changedFiles).toHaveLength(3)

      // c.ts (deleted) deve ser o último elemento
      expect(changedFiles[2].relativePath).toBe('c.ts')
      expect(changedFiles[2].changeType).toBe('deleted')

      // Os dois primeiros devem ser b.ts (mais recente) e depois a.ts
      expect(changedFiles[0].relativePath).toBe('b.ts')
      expect(changedFiles[1].relativePath).toBe('a.ts')
      expect(changedFiles[0].mtime!).toBeGreaterThan(changedFiles[1].mtime!)
    })

    it('Cenário B — getChangedFiles entre checkpoint e disco respeita a ordenação por mtime descendente', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'a.ts', 'v1\n')
      writeFile(repoPath, 'b.ts', 'v1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const cp = await service.createCheckpoint(repoPath, 'CP Initial')

      writeFile(repoPath, 'a.ts', 'v2\n')
      await new Promise(resolve => setTimeout(resolve, 150))
      writeFile(repoPath, 'b.ts', 'v2\n')

      const changedFiles = await service.getChangedFiles(repoPath, cp.id, cp.id)

      expect(changedFiles).toHaveLength(2)
      expect(changedFiles[0].relativePath).toBe('b.ts')
      expect(changedFiles[1].relativePath).toBe('a.ts')
    })
  })

  // ─── PA-12 — Limite de 100 Checkpoints (Arquivamento) ────────────────────
  describe('PA-12 — Limite de 100 Checkpoints (Arquivamento)', () => {
    it('Cenário A — arquiva o checkpoint mais antigo ao atingir 101 checkpoints', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const content = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const createdCps: CheckpointData[] = []

      // Criar 100 checkpoints em loop
      for (let i = 1; i <= 100; i++) {
        const cp = await service.createCheckpoint(repoPath, `CP ${i}`)
        createdCps.push(cp)
      }

      const list100 = await service.listCheckpoints(repoPath)
      expect(list100).toHaveLength(100)
      expect(list100.every(cp => cp.hasContent === true)).toBe(true)

      // Guardar a referência do 1º checkpoint criado (o mais antigo)
      const firstCpId = createdCps[0].id

      // Criar o 101º checkpoint
      const cp101 = await service.createCheckpoint(repoPath, 'CP 101')
      expect(cp101).toBeDefined()

      const list101 = await service.listCheckpoints(repoPath)
      expect(list101).toHaveLength(101)

      // listCheckpoints retorna ordenado por data descendente (mais recente no índice 0)
      expect(list101[0].name).toBe('CP 101')
      expect(list101[0].hasContent).toBe(true)

      // O mais antigo (no último índice 100) deve ter hasContent === false
      const oldestSummary = list101[100]
      expect(oldestSummary.id).toBe(firstCpId)
      expect(oldestSummary.hasContent).toBe(false)

      // E o arquivo JSON do mais antigo foi deletado do disco
      const jsonDisk = readCheckpointJson(repoPath, firstCpId)
      expect(jsonDisk).toBeNull()
    }, 40000)

    it('Cenário B — arquiva sequencialmente o próximo mais antigo ao atingir 102 checkpoints', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const content = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const createdCps: CheckpointData[] = []

      for (let i = 1; i <= 101; i++) {
        const cp = await service.createCheckpoint(repoPath, `CP ${i}`)
        createdCps.push(cp)
      }

      const cp102 = await service.createCheckpoint(repoPath, 'CP 102')
      expect(cp102).toBeDefined()

      const list102 = await service.listCheckpoints(repoPath)
      expect(list102).toHaveLength(102)

      // Índices 0 e 1 (102º e 101º) têm conteúdo
      expect(list102[0].hasContent).toBe(true)
      expect(list102[1].hasContent).toBe(true)

      // Os 2 mais antigos (últimos índices 101 e 100) estão arquivados
      expect(list102[101].id).toBe(createdCps[0].id)
      expect(list102[101].hasContent).toBe(false)
      expect(list102[100].id).toBe(createdCps[1].id)
      expect(list102[100].hasContent).toBe(false)
    }, 40000)
  })

  // ─── PA-13 — Migração Idempotente e Recuperação ──────────────────────────
  describe('PA-13 — Migração Idempotente e Recuperação', () => {
    it('Cenário A — migra automaticamente JSONs legados do disco para o catálogo do banco', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const t = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      writeLegacyCheckpoint(repoPath, 'cp_leg_1', 'CP Legado 1')
      writeLegacyCheckpoint(repoPath, 'cp_leg_2', 'CP Legado 2')
      writeLegacyCheckpoint(repoPath, 'cp_leg_3', 'CP Legado 3')

      const service = new CheckpointService(fakeCatalog, new GitService())
      const list = await service.listCheckpoints(repoPath)

      expect(list).toHaveLength(3)

      const catalog = fakeCatalog.getCheckpointsCatalog(repoPath)
      expect(catalog).toHaveLength(3)
    })

    it('Cenário B — re-execuções de listCheckpoints são idempotentes e não duplicam registros', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const t = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      writeLegacyCheckpoint(repoPath, 'cp_leg_1', 'CP Legado 1')
      writeLegacyCheckpoint(repoPath, 'cp_leg_2', 'CP Legado 2')
      writeLegacyCheckpoint(repoPath, 'cp_leg_3', 'CP Legado 3')

      const service = new CheckpointService(fakeCatalog, new GitService())
      await service.listCheckpoints(repoPath)

      // Segunda chamada (idempotente)
      const listSecond = await service.listCheckpoints(repoPath)
      expect(listSecond).toHaveLength(3)

      const catalog = fakeCatalog.getCheckpointsCatalog(repoPath)
      expect(catalog).toHaveLength(3)
    })

    it('Cenário C — recupera cadastro incompleto quando a contagem do catálogo é menor que o número de JSONs no disco', async () => {
      repoPath = await createTempGitRepo()
      writeFile(repoPath, 'test.ts', 'export const t = 1\n')
      await stageAll(repoPath)
      await commit(repoPath, 'init')

      const dateStr = new Date().toISOString()
      writeLegacyCheckpoint(repoPath, 'cp_rec_1', 'CP Rec 1', dateStr)
      writeLegacyCheckpoint(repoPath, 'cp_rec_2', 'CP Rec 2', dateStr)
      writeLegacyCheckpoint(repoPath, 'cp_rec_3', 'CP Rec 3', dateStr)

      // Simula crash: insere apenas 2 dos 3 no banco manualmente
      fakeCatalog.insertCheckpointCatalog(repoPath, {
        id: 'cp_rec_1',
        name: 'CP Rec 1',
        createdAt: dateStr,
        instructions: null,
        agentSummary: null,
        restoredAt: null,
        fileCount: 1,
        hasContent: true
      })
      fakeCatalog.insertCheckpointCatalog(repoPath, {
        id: 'cp_rec_2',
        name: 'CP Rec 2',
        createdAt: dateStr,
        instructions: null,
        agentSummary: null,
        restoredAt: null,
        fileCount: 1,
        hasContent: true
      })

      const catalogBefore = fakeCatalog.getCheckpointsCatalog(repoPath)
      expect(catalogBefore).toHaveLength(2)

      const service = new CheckpointService(fakeCatalog, new GitService())
      await service.listCheckpoints(repoPath)

      const catalogAfter = fakeCatalog.getCheckpointsCatalog(repoPath)
      expect(catalogAfter).toHaveLength(3)
    })
  })
})