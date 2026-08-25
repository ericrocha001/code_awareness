/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Provar que verifyIntegrity atua como juiz da integridade do Code Map.
2. Validar a detecção de inconsistências (hash divergente e arquivo inesperado no disco).
3. Validar a reparação automática com autoRepair e a convergência para estado íntegro.
4. Validar a detecção de arquivo deletado via Função-Oráculo do Invariante Central.

Mapa de Relacionamentos do Script

1. repository-model.ts
   - Tipo: Dependência Direta
   - Relação: Exercita verifyIntegrity e getFiles como juiz real sobre banco SQLite.
   - Criticidade: Alta

2. test-helpers.ts
   - Tipo: Dependência Direta
   - Relação: Fornece isolamento de repositórios temporários e a Função-Oráculo verifyInvariant.
   - Criticidade: Alta

3. repository-database.ts
   - Tipo: Dependência Direta
   - Relação: Fecha conexões de banco no teardown.
   - Criticidade: Média

Invariantes do Script

1. Cada teste cria repositório temporário isolado e o remove no afterEach.
2. Todos os cenários usam instâncias reais de RepositoryModel — nada é mockado.
3. O cenário de arquivo deletado usa verifyInvariant, pois a reconciliação de verifyIntegrity removê-la-ia do índice antes da detecção.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { createAndIndexRepo, cleanupTempRepo, verifyInvariant, FIXTURE_SIMPLE_FUNCTION } from './test-helpers'
import { RepositoryModel } from './repository-model'
import { closeRepositoryDatabase } from './repository-database'

describe('Sprint 2 — Integridade como Oráculo', () => {
  let model: RepositoryModel
  let repoPath: string

  beforeEach(() => {
    // Setup individual é feito dentro de cada it() via createAndIndexRepo
  })

  // DEPENDE: cleanupTempRepo deve permanecer async (ver BUGFIX Windows em test-helpers.ts).
  // O lock do WAL do SQLite segura um handle por um instante no Windows após close().
  afterEach(async () => {
    if (model && repoPath) {
      closeRepositoryDatabase(repoPath)
      await cleanupTempRepo(repoPath)
    }
  })

  it('deve retornar healthy quando repositório está íntegro', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/sample.ts': FIXTURE_SIMPLE_FUNCTION }))

    const result = await model.verifyIntegrity({ autoRepair: false })

    expect(result.status).toBe('healthy')
    expect(result.hashesMismatched).toBe(0)
    expect(result.filesMissing).toBe(0)
    expect(result.filesUnexpected).toBe(0)
    expect(result.orphanElements).toBe(0)
    expect(result.invalidRelationships).toBe(0)
  })

  it('deve detectar hash divergente sem reparar', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/sample.ts': 'export const x = 1\n' }))

    writeFileSync(join(repoPath, 'src/sample.ts'), 'export const x = 999\n', 'utf-8')

    const result = await model.verifyIntegrity({ autoRepair: false })

    expect(result.status).toBe('inconsistent')
    expect(result.hashesMismatched).toBe(1)
    expect(result.details.some((d) => d.type === 'hash_mismatch' && d.target === 'src/sample.ts')).toBe(true)
  })

  it('deve reparar hash divergente com autoRepair e convergir para healthy', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/sample.ts': 'export const x = 1\n' }))

    const newContent = 'export const x = 999\n'
    writeFileSync(join(repoPath, 'src/sample.ts'), newContent, 'utf-8')
    const expectedHash = createHash('sha256').update(newContent, 'utf-8').digest('hex')

    const result = await model.verifyIntegrity({ autoRepair: true })

    expect(result.repairResult).toBeDefined()
    expect(result.repairResult!.status).toBe('success')
    expect(result.repairResult!.issuesFixed).toBe(1)
    expect(result.repairResult!.revalidation.status).toBe('healthy')

    const files = model.getFiles()
    expect(files[0].contentHash).toBe(expectedHash)
  })

  it('deve detectar arquivo deletado do disco via Função-Oráculo', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/sample.ts': 'export class Foo {}\n' }))

    unlinkSync(join(repoPath, 'src/sample.ts'))

    const result = await verifyInvariant(model, repoPath)

    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.type === 'file_missing_on_disk' && v.target === 'src/sample.ts')).toBe(true)
  })

  it('deve detectar arquivo inesperado no disco', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({ 'src/existing.ts': 'export const a = 1\n' }))

    writeFileSync(join(repoPath, 'src/unexpected.ts'), 'export const b = 2\n', 'utf-8')

    const result = await model.verifyIntegrity({ autoRepair: false, scanForUnexpectedFiles: true })

    expect(result.status).toBe('inconsistent')
    expect(result.filesUnexpected).toBe(1)
    expect(result.details.some((d) => d.type === 'file_unexpected' && d.target === 'src/unexpected.ts')).toBe(true)
  })
})
