/*
-T ---
*/

import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createAndIndexRepo, cleanupTempRepo, createTempRepo } from './test-helpers'
import { RepositoryModel, createRepositoryModel } from './repository-model'
import { closeRepositoryDatabase } from './repository-database'

describe('CodeMap — Grafo e Resolução', () => {
  let model: RepositoryModel
  let repoPath: string

  afterEach(async () => {
    if (model && repoPath) {
      closeRepositoryDatabase(repoPath)
      await cleanupTempRepo(repoPath)
    }
  })

  it('deve resolver import relativo (element→file) com import interno', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'import { a } from "./a";\n'
    }))

    const rels = model.getRelationships()
    const rel = rels.find((r) => r.type === 'imports')
    expect(rel).toBeDefined()
    expect(rel!.sourceKind).toBe('element')
    expect(rel!.targetKind).toBe('file')
  })

  it('deve resolver import via index (./folder) quando existe index.ts', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'dir/index.ts': 'export const x = 1;\n',
      'app.ts': 'import { x } from "./dir";\n'
    }))

    const rel = model.getRelationships().find((r) => r.type === 'imports')
    expect(rel).toBeDefined()
    // target é a única file 'dir/index.ts'
    const files = model.getFiles()
    const targetFile = files.find((f) => f.relativePath === 'dir/index.ts')
    expect(rel!.targetId).toBe(targetFile!.id)
  })

  it('não deve criar aresta interna falsa para pacote externo (react)', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'app.tsx': 'import React from "react";\nexport const C = () => <div />;\n'
    }))

    const rels = model.getRelationships()
    const imports = rels.filter((r) => r.type === 'imports')
    // Não deve haver aresta de import para 'react' (externo)
    expect(imports).toHaveLength(0)
  })

  it('deve resolver alias interno via tsconfig paths', async () => {
    repoPath = createTempRepo()
    mkdirSync(join(repoPath, 'core'), { recursive: true })
    writeFileSync(join(repoPath, 'core', 'x.ts'), 'export const v = 1;\n', 'utf-8')
    writeFileSync(join(repoPath, 'app.ts'), 'import { v } from "core/x";\n', 'utf-8')
    writeFileSync(
      join(repoPath, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { 'core/*': ['core/*'] } } }),
      'utf-8'
    )
    model = createRepositoryModel(repoPath)
    await model.indexRepository()

    const rel = model.getRelationships().find((r) => r.type === 'imports')
    expect(rel).toBeDefined()
    const targetFile = model.getFiles().find((f) => f.relativePath === 'core/x.ts')
    expect(rel!.targetId).toBe(targetFile!.id)
  })

  it('herança ambígua: liga à Base importada; sem import, omite a aresta', async () => {
    repoPath = createTempRepo()
    mkdirSync(join(repoPath, 'm1'), { recursive: true })
    mkdirSync(join(repoPath, 'm2'), { recursive: true })
    // Base em dois módulos distintos
    writeFileSync(join(repoPath, 'm1', 'base.ts'), 'export class Base {}\n', 'utf-8')
    writeFileSync(join(repoPath, 'm2', 'base.ts'), 'export class Base {}\n', 'utf-8')

    // Sub importa m1/base e estende Base → liga à m1
    writeFileSync(join(repoPath, 'sub.ts'), 'import { Base } from "./m1/base";\nexport class Sub extends Base {}\n', 'utf-8')
    model = createRepositoryModel(repoPath)
    await model.indexRepository()

    const extendsR = model.getRelationships().filter((r) => r.type === 'extends')
    expect(extendsR).toHaveLength(1)
    const targetEl = model.getElementsByRepository().find((e) => e.id === extendsR[0].targetId)
    expect(targetEl!.fileId).toBe(model.getFiles().find((f) => f.relativePath === 'm1/base.ts')!.id)

    // Ambiguidade sem import: dois arquivos com class Base, Sub2 extends Base sem import
    writeFileSync(join(repoPath, 'sub2.ts'), 'export class Sub2 extends Base {}\n', 'utf-8')
    await model.updateFileContent('sub2.ts')
    const extendsR2 = model.getRelationships().filter((r) => r.type === 'extends' && r.sourceId === model.getElementsByRepository().find((e) => e.name === 'Sub2')!.id)
    expect(extendsR2).toHaveLength(0)
  })

  it('CSS FILE→FILE é íntegro: verifyIntegrity retorna healthy', async () => {
    repoPath = createTempRepo()
    writeFileSync(join(repoPath, 'reset.css'), '* { margin: 0; }\n', 'utf-8')
    writeFileSync(join(repoPath, 'main.css'), '@import "./reset.css";\nbody { color: red; }\n', 'utf-8')
    model = createRepositoryModel(repoPath)
    await model.indexRepository()

    const rel = model.getRelationships().find((r) => r.type === 'imports')
    expect(rel).toBeDefined()
    expect(rel!.sourceKind).toBe('file')
    expect(rel!.targetKind).toBe('file')

    const result = await model.verifyIntegrity({ autoRepair: false })
    expect(result.invalidRelationships).toBe(0)
    expect(result.status).toBe('healthy')
  })
})
