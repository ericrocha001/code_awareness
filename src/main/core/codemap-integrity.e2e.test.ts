/*
-T ---
*/

import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { getParser, getLanguageForExtension } from './language-adapter'
import { createRepositoryModel, RepositoryModel } from './repository-model'
import { closeRepositoryDatabase } from './repository-database'
import { createTempRepo, cleanupTempRepo } from './test-helpers'

describe('CodeMap — Detecção, Reparação e Atomicidade', () => {
  let model: RepositoryModel
  let repoPath: string

  afterEach(async () => {
    if (model && repoPath) {
      closeRepositoryDatabase(repoPath)
      await cleanupTempRepo(repoPath)
    }
  })

  it('deve carregar o módulo repository-model sem erro', () => {
    expect(getParser).toBeDefined()
    expect(getLanguageForExtension).toBeDefined()
    expect(createRepositoryModel).toBeDefined()
  })

  it('Rollback: falha injetada na substituição atômica preserva o estado anterior íntegro', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)
    const contentV1 = 'export class Widget {\n  greet(): string { return "v1"; }\n}\n'
    writeFileSync(join(repoPath, 'widget.ts'), contentV1, 'utf-8')
    await model.indexRepository()

    // Estado v1: elementos íntegros e recuperáveis
    const file = model.getFiles().find((f) => f.relativePath === 'widget.ts')
    expect(file).toBeDefined()
    const elementsV1 = model.getElementsByFile(file!.id)
    expect(elementsV1.length).toBeGreaterThan(0)
    const greetV1 = elementsV1.find((e) => e.name === 'greet' && e.kind === 'method')
    expect(greetV1).toBeDefined()
    const v1Source = await model.getElementExactSource(greetV1!.id)
    expect(v1Source).not.toBeNull()

    // Injeção de falha: substituição atômica com elemento envenenado (kind inválido)
    // O mapper domainToElementRow (com validateEnum) roda DENTRO da transação → rollback total
    const poisonedElement = { ...elementsV1[0], kind: 'not_a_real_kind' as any }
    const fileRecordV2: any = { ...file!, mtime: file!.mtime + 1 }

    expect(() => {
      ;(model as any)['db'].replaceIndexedFileState(fileRecordV2, [poisonedElement], [], [])
    }).toThrow()

    // Estado anterior permanece íntegro: elementos v1 preservados e legíveis
    const elementsAfter = model.getElementsByFile(file!.id)
    expect(elementsAfter.length).toBe(elementsV1.length)
    const greetAfter = elementsAfter.find((e) => e.name === 'greet' && e.kind === 'method')
    expect(greetAfter).toBeDefined()
    expect(greetAfter!.id).toBe(greetV1!.id)
    const v1SourceAfter = await model.getElementExactSource(greetV1!.id)
    expect(v1SourceAfter).not.toBeNull()
    expect(v1SourceAfter!.content).toBe(v1Source!.content)
  })

  it('Deep Integrity: alteração com mtime restaurado é detectada e reparada', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)
    const path = join(repoPath, 'target.ts')
    writeFileSync(path, 'export const value = 1;\n', 'utf-8')
    await model.indexRepository()

    // mtime original (antes da modificação)
    const fileBefore = model.getFiles().find((f) => f.relativePath === 'target.ts')
    expect(fileBefore).toBeDefined()

    // Altera o conteúdo
    writeFileSync(path, 'export const value = 999;\n', 'utf-8')

    // Restaura mtime artificial (simula ferramenta que preserva timestamps)
    utimesSync(path, fileBefore!.mtime / 1000, fileBefore!.mtime / 1000)

    // Deep integrity detecta a divergência (hasheia mesmo com mtime restaurado)
    const deepResult = await model.verifyIntegrity({ deep: true, autoRepair: false })
    expect(deepResult.hashesMismatched).toBe(1)

    // Com autoRepair: reindexa e revalida healthy
    const repairResult = await model.verifyIntegrity({ deep: true, autoRepair: true })
    expect(repairResult.status).toBe('healthy')
    expect(repairResult.repairResult).toBeDefined()

    // Conteúdo novo está no índice e recuperável
    const fileAfter = model.getFiles().find((f) => f.relativePath === 'target.ts')
    const elements = model.getElementsByFile(fileAfter!.id)
    const valueEl = elements.find((e) => e.name === 'value' && e.kind === 'constant')
    expect(valueEl).toBeDefined()
    const source = await model.getElementExactSource(valueEl!.id)
    expect(source).not.toBeNull()
    expect(source!.content).toContain('999')
  })

  it('Deep Integrity: CSS FILE→FILE permanece healthy', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)
    writeFileSync(join(repoPath, 'reset.css'), '* { margin: 0; }\n', 'utf-8')
    writeFileSync(join(repoPath, 'main.css'), '@import "./reset.css";\nbody { color: red; }\n', 'utf-8')
    await model.indexRepository()

    const result = await model.verifyIntegrity({ deep: true, autoRepair: false })
    expect(result.status).toBe('healthy')
    expect(result.invalidRelationships).toBe(0)
  })
})
