/*
-T ---
*/

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { getParser, getLanguageForExtension } from './language-adapter'
import { readStructure } from './structure-reader'
import { createHash } from 'crypto'

describe('CodeMap — Identidade, Ranges e Unicidade', () => {
  const repoId = 'test-repo'

  it('deve carregar os módulos structure-reader e repository-database sem erro', () => {
    expect(getParser).toBeDefined()
    expect(getLanguageForExtension).toBeDefined()
    expect(readStructure).toBeDefined()
  })

  it('Teste 1 — três overloads de foo coexistem com IDs distintos', () => {
    const code = [
      'export function foo(a: string): void {}',
      'export function foo(a: number): void {}',
      'export function foo(a: boolean): void {}'
    ].join('\n')

    const result = readStructure(repoId, 'test.ts', '.ts', code)
    const foos = result.elements.filter(e => e.name === 'foo' && e.kind === 'function')

    expect(foos.length).toBe(3)
    const ids = new Set(foos.map(e => e.id))
    expect(ids.size).toBe(3) // Todos os IDs devem ser distintos
  })

  it('Teste 2 — dois const value em blocos irmãos coexistem', () => {
    const code = [
      'function a() {',
      '  const value = 1;',
      '}',
      'function b() {',
      '  const value = 2;',
      '}'
    ].join('\n')

    const result = readStructure(repoId, 'test.ts', '.ts', code)
    const values = result.elements.filter(e => e.name === 'value' && e.kind === 'constant')

    expect(values.length).toBe(2)
    const ids = new Set(values.map(e => e.id))
    expect(ids.size).toBe(2)
  })

  it('Teste 3 — inserir const value = 0 antes de const value = 1 não altera o ID do segundo', () => {
    const codeBefore = [
      'const value = 1;'
    ].join('\n')

    const codeAfter = [
      'const value = 0;',
      'const value = 1;'
    ].join('\n')

    const resultBefore = readStructure(repoId, 'test.ts', '.ts', codeBefore)
    const resultAfter = readStructure(repoId, 'test.ts', '.ts', codeAfter)

    // Seleciona o SEGUNDO (value = 1) pelo range, conforme a intenção do teste.
    // find() ingênuo pegaria o primeiro 'value' (que é o inserido, value = 0).
    const pickSecond = (elements) => elements.find((e) => {
      if (e.name !== 'value' || e.kind !== 'constant') return false
      const text = codeAfter.substring(e.location.start.byte, e.location.end.byte)
      return text.includes('value = 1')
    })
    const valueBefore = resultBefore.elements.find(e => e.name === 'value' && e.kind === 'constant')
    const valueAfter = pickSecond(resultAfter.elements)

    expect(valueBefore).toBeDefined()
    expect(valueAfter).toBeDefined()
    // Inicializadores diferentes → grupos de gêmeos distintos → ID do segundo preservado
    expect(valueAfter!.id).toBe(valueBefore!.id)
  })

  it('Teste 3b — gêmeos exatos coexistem via twinIndex e permanecem estáveis sob inserção de unidade diferente', () => {
    // Gêmeos exatos: mesmo kind, nome e inicializador, em blocos irmãos (funções distintas)
    const codeBefore = [
      'function blockA() {',
      '  const value = 1;',
      '}',
      'function blockB() {',
      '  const value = 1;',
      '}'
    ].join('\n')

    // Insere uma unidade DIFERENTE (outro nome) antes — não pode deslocar os gêmeos
    const codeAfter = [
      'const other = 99;',
      'function blockA() {',
      '  const value = 1;',
      '}',
      'function blockB() {',
      '  const value = 1;',
      '}'
    ].join('\n')

    const before = readStructure(repoId, 'twins.ts', '.ts', codeBefore)
    const after = readStructure(repoId, 'twins.ts', '.ts', codeAfter)

    const twinsBefore = before.elements.filter(e => e.name === 'value' && e.kind === 'constant')
    const twinsAfter = after.elements.filter(e => e.name === 'value' && e.kind === 'constant')

    // Coexistem com IDs distintos (twinIndex 0 e 1)
    expect(twinsBefore.length).toBe(2)
    expect(twinsAfter.length).toBe(2)
    expect(twinsBefore[0].id).not.toBe(twinsBefore[1].id)

    // Estáveis sob inserção de unidade diferente
    expect(twinsAfter[0].id).toBe(twinsBefore[0].id)
    expect(twinsAfter[1].id).toBe(twinsBefore[1].id)
  })

  it('Teste 3c — const dentro de if/for top-level é member; top-level direto é structural', () => {
    const code = [
      'const direct = 1;',
      'if (true) {',
      '  const insideIf = 2;',
      '}',
      'for (let i = 0; i < 3; i++) {',
      '  const insideFor = 3;',
      '}'
    ].join('\n')

    const result = readStructure(repoId, 'scope.ts', '.ts', code)

    const direct = result.elements.find(e => e.name === 'direct')
    const insideIf = result.elements.find(e => e.name === 'insideIf')
    const insideFor = result.elements.find(e => e.name === 'insideFor')

    expect(direct).toBeDefined()
    expect(direct!.granularity).toBe('structural')
    expect(direct!.retrievable).toBe(true)

    expect(insideIf).toBeDefined()
    expect(insideIf!.granularity).toBe('member')
    expect(insideIf!.retrievable).toBe(true)

    expect(insideFor).toBeDefined()
    expect(insideFor!.granularity).toBe('member')
    expect(insideFor!.retrievable).toBe(true)
  })

  it('Teste 4 — editar apenas o corpo de um método preserva o ID após reindex', () => {
    const codeBefore = [
      'export class Service {',
      '  execute(): void {',
      '    console.log("before");',
      '  }',
      '}'
    ].join('\n')

    const codeAfter = [
      'export class Service {',
      '  execute(): void {',
      '    console.log("after");',
      '  }',
      '}'
    ].join('\n')

    const resultBefore = readStructure(repoId, 'test.ts', '.ts', codeBefore)
    const resultAfter = readStructure(repoId, 'test.ts', '.ts', codeAfter)

    const execBefore = resultBefore.elements.find(e => e.name === 'execute' && e.kind === 'method')
    const execAfter = resultAfter.elements.find(e => e.name === 'execute' && e.kind === 'method')

    expect(execBefore).toBeDefined()
    expect(execAfter).toBeDefined()
    // Editar o corpo não deve mudar o ID (a assinatura é a mesma)
    expect(execAfter!.id).toBe(execBefore!.id)
  })

  it('Teste 5 — renomear elemento muda o ID', () => {
    const codeBefore = 'export function hello() {}\n'
    const codeAfter = 'export function world() {}\n'

    const resultBefore = readStructure(repoId, 'test.ts', '.ts', codeBefore)
    const resultAfter = readStructure(repoId, 'test.ts', '.ts', codeAfter)

    const funcBefore = resultBefore.elements.find(e => e.name === 'hello')
    const funcAfter = resultAfter.elements.find(e => e.name === 'world')

    expect(funcBefore).toBeDefined()
    expect(funcAfter).toBeDefined()
    // Renomear muda o ID
    expect(funcAfter!.id).not.toBe(funcBefore!.id)
  })
})
