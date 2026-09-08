/*
-T ---
*/

import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import {
  createAndIndexRepo,
  cleanupTempRepo,
  verifyInvariant
} from './test-helpers'
import { RepositoryModel } from './repository-model'
import { closeRepositoryDatabase } from './repository-database'

describe('Sprint 4 — AST Sempre Atualizado', () => {
  let model: RepositoryModel
  let repoPath: string

  // BUGFIX (Windows): cleanupTempRepo é async para contornar lock do WAL do SQLite.
  afterEach(async () => {
    if (model && repoPath) {
      closeRepositoryDatabase(repoPath)
      await cleanupTempRepo(repoPath)
    }
  })

  it('Teste 1 — deve extrair classe e método com IDs estáveis e localizações precisas', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/sample.ts': 'export class Foo {\n  bar(): void {}\n}\n'
    }))

    const elements = model.getElementsByRepository()
    // O extrator inclui export elements além de class e method; verificamos mínimo de 2.
    expect(elements.length).toBeGreaterThanOrEqual(2)

    const classEl = elements.find((e) => e.kind === 'class')
    const methodEl = elements.find((e) => e.kind === 'method')

    expect(classEl).toBeDefined()
    expect(classEl!.name).toBe('Foo')
    expect(classEl!.location.start.line).toBeGreaterThanOrEqual(1)

    expect(methodEl).toBeDefined()
    expect(methodEl!.name).toBe('bar')
    // Método deve referenciar a classe pai
    expect(methodEl!.parentElementId).toBe(classEl!.id)

    // IDs devem ser strings não vazias (determinísticos)
    expect(classEl!.id).toBeTruthy()
    expect(methodEl!.id).toBeTruthy()
    expect(classEl!.id).not.toBe(methodEl!.id)

    const invariant = await verifyInvariant(model, repoPath)
    expect(invariant.passed).toBe(true)
  })

  it('Teste 2 — deve refletir adição de função após reindexação', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/sample.ts': '// empty\n'
    }))

    expect(model.getElementsByRepository().length).toBe(0)

    writeFileSync(join(repoPath, 'src/sample.ts'), 'export function hello(): void {}\n', 'utf-8')
    await model.updateFileContent('src/sample.ts')

    const elements = model.getElementsByRepository()
    const fn = elements.find((e) => e.kind === 'function')
    expect(fn).toBeDefined()
    expect(fn!.name).toBe('hello')

    const invariant = await verifyInvariant(model, repoPath)
    expect(invariant.passed).toBe(true)
  })

  it('Teste 3 — deve refletir remoção de função após reindexação', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/sample.ts': 'export function hello(): void {}\n'
    }))

    expect(model.getElementsByRepository().length).toBeGreaterThan(0)

    writeFileSync(join(repoPath, 'src/sample.ts'), '// empty\n', 'utf-8')
    await model.updateFileContent('src/sample.ts')

    expect(model.getElementsByRepository().length).toBe(0)

    const invariant = await verifyInvariant(model, repoPath)
    expect(invariant.passed).toBe(true)
  })

  it('Teste 4 — deve refletir renomeação de classe (ID muda com o nome)', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/sample.ts': 'export class Foo {}\n'
    }))

    const elementsBefore = model.getElementsByRepository()
    const fooEl = elementsBefore.find((e) => e.name === 'Foo')
    expect(fooEl).toBeDefined()
    const originalId = fooEl!.id

    writeFileSync(join(repoPath, 'src/sample.ts'), 'export class Bar {}\n', 'utf-8')
    await model.updateFileContent('src/sample.ts')

    const elementsAfter = model.getElementsByRepository()
    // Elemento antigo desapareceu
    expect(elementsAfter.find((e) => e.name === 'Foo')).toBeUndefined()
    // Elemento novo apareceu com ID diferente (ID inclui nome)
    const barEl = elementsAfter.find((e) => e.name === 'Bar')
    expect(barEl).toBeDefined()
    expect(barEl!.id).not.toBe(originalId)

    const invariant = await verifyInvariant(model, repoPath)
    expect(invariant.passed).toBe(true)
  })

  it('Teste 5 — deve criar relacionamento extends após reindexação', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/base.ts': 'export class Base {}\n',
      'src/child.ts': 'export class Child {}\n'
    }))

    const relsBefore = model.getRelationships().filter((r) => r.type === 'extends')
    expect(relsBefore.length).toBe(0)

    writeFileSync(join(repoPath, 'src/child.ts'), 'import { Base } from \'./base\'\nexport class Child extends Base {}\n', 'utf-8')
    await model.updateFileContent('src/child.ts')

    const relsAfter = model.getRelationships().filter((r) => r.type === 'extends')
    expect(relsAfter.length).toBe(1)

    const elements = model.getElementsByRepository()
    // Filtra por kind para evitar confusão com export elements que têm o mesmo nome
    const childEl = elements.find((e) => e.name === 'Child' && e.kind === 'class')
    const baseEl = elements.find((e) => e.name === 'Base' && e.kind === 'class')
    expect(childEl).toBeDefined()
    expect(baseEl).toBeDefined()
    expect(relsAfter[0].sourceId).toBe(childEl!.id)
    expect(relsAfter[0].targetId).toBe(baseEl!.id)

    const invariant = await verifyInvariant(model, repoPath)
    expect(invariant.passed).toBe(true)
  })

  it('Teste 6 — deve remover relacionamento extends após reindexação', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/base.ts': 'export class Base {}\n',
      'src/child.ts': 'import { Base } from \'./base\'\nexport class Child extends Base {}\n'
    }))

    const relsBefore = model.getRelationships().filter((r) => r.type === 'extends')
    expect(relsBefore.length).toBe(1)

    writeFileSync(join(repoPath, 'src/child.ts'), 'export class Child {}\n', 'utf-8')
    await model.updateFileContent('src/child.ts')

    const relsAfter = model.getRelationships().filter((r) => r.type === 'extends')
    expect(relsAfter.length).toBe(0)

    // Ambos elementos ainda existem (apenas o relacionamento foi removido)
    const elements = model.getElementsByRepository()
    expect(elements.find((e) => e.name === 'Base')).toBeDefined()
    expect(elements.find((e) => e.name === 'Child')).toBeDefined()

    const invariant = await verifyInvariant(model, repoPath)
    expect(invariant.passed).toBe(true)
  })

  it('Teste 7 — reindexação seletiva deve preservar relacionamento cross-file', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/a.ts': 'export class A {}\n',
      'src/b.ts': 'import { A } from \'./a\'\nexport class B extends A {}\n'
    }))

    const relsInitial = model.getRelationships().filter((r) => r.type === 'extends')
    expect(relsInitial.length).toBe(1)
    const extendsRelId = relsInitial[0].id

    // Reindexação seletiva de a.ts — adiciona método a A, sem tocar em b.ts
    writeFileSync(join(repoPath, 'src/a.ts'), 'export class A {\n  newMethod(): void {}\n}\n', 'utf-8')
    await model.updateFileContent('src/a.ts')

    // Relacionamento extends de B → A deve permanecer intacto
    const relsAfter = model.getRelationships().filter((r) => r.type === 'extends')
    expect(relsAfter.length).toBe(1)
    expect(relsAfter[0].id).toBe(extendsRelId)

    // Novo método deve aparecer em A
    const elements = model.getElementsByRepository()
    expect(elements.find((e) => e.name === 'newMethod' && e.kind === 'method')).toBeDefined()

    const invariant = await verifyInvariant(model, repoPath)
    expect(invariant.passed).toBe(true)
  })

  it('Teste 8 — falha de parse não deve quebrar indexação dos demais arquivos', async () => {
    ;({ model, repoPath } = await createAndIndexRepo({
      'src/valid1.ts': 'export const a = 1\n',
      'src/broken.ts': 'export class {{{ broken\n',
      'src/valid2.ts': 'export const b = 2\n'
    }))

    const files = model.getFiles()
    expect(files.length).toBe(3)

    const valid1 = files.find((f) => f.relativePath === 'src/valid1.ts')
    const broken = files.find((f) => f.relativePath === 'src/broken.ts')
    const valid2 = files.find((f) => f.relativePath === 'src/valid2.ts')

    expect(valid1).toBeDefined()
    expect(broken).toBeDefined()
    expect(valid2).toBeDefined()

    // Arquivos válidos têm elementos; arquivo quebrado tem 0 (parse failure não quebra pipeline)
    expect(model.getElementsByFile(valid1!.id).length).toBeGreaterThan(0)
    expect(model.getElementsByFile(broken!.id).length).toBe(0)
    expect(model.getElementsByFile(valid2!.id).length).toBeGreaterThan(0)

    // Oráculo validando apenas arquivos com status indexed — expectFullySynced: false
    // para tolerar que broken.ts possa ter sido marcado de forma diferente
    const invariant = await verifyInvariant(model, repoPath, { expectFullySynced: false })
    expect(invariant.passed).toBe(true)
  })
})
