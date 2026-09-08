/*
-T ---
*/

import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { getParser, getLanguageForExtension } from './language-adapter'
import { createRepositoryModel, RepositoryModel } from './repository-model'
import { closeRepositoryDatabase } from './repository-database'
import { createTempRepo, cleanupTempRepo } from './test-helpers'

describe('CodeMap — Recuperação Exata', () => {
  let model: RepositoryModel
  let repoPath: string

  afterEach(async () => {
    if (model && repoPath) {
      closeRepositoryDatabase(repoPath)
      await cleanupTempRepo(repoPath)
    }
  })

  it('deve carregar o módulo repository-model sem erro', () => {
    // Teste de sanidade: verifica que a suite está corretamente integrada ao Vitest
    expect(getParser).toBeDefined()
    expect(getLanguageForExtension).toBeDefined()
    expect(createRepositoryModel).toBeDefined()
  })

  it('deve recuperar unidade member (propriedade de classe) via getElementExactSource', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)

    const { writeFileSync } = await import('fs')
    const { join } = await import('path')
    writeFileSync(join(repoPath, 'widget.ts'), 'export class Widget {\n  private label: string = "w";\n}\n', 'utf-8')
    await model.indexRepository()

    const file = model.getFiles().find((f) => f.relativePath === 'widget.ts')
    const elements = model.getElementsByFile(file!.id)

    const label = elements.find((e) => e.name === 'label' && e.kind === 'property')
    expect(label).toBeDefined()
    expect(label!.retrievable).toBe(true)

    const result = await model.getElementExactSource(label!.id)
    expect(result).not.toBeNull()
    expect(result!.content).toContain('label')
  })

  it('deve isolar irmãos em multi-declarator: getElementExactSource retorna apenas a unidade pedida', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)

    const { writeFileSync } = await import('fs')
    const { join } = await import('path')
    writeFileSync(join(repoPath, 'multi.ts'), 'const alpha = 111, beta = 222;\n', 'utf-8')
    await model.indexRepository()

    const file = model.getFiles().find((f) => f.relativePath === 'multi.ts')
    const elements = model.getElementsByFile(file!.id)

    const alpha = elements.find((e) => e.name === 'alpha' && e.kind === 'constant')
    const beta = elements.find((e) => e.name === 'beta' && e.kind === 'constant')
    expect(alpha).toBeDefined()
    expect(beta).toBeDefined()

    const alphaResult = await model.getElementExactSource(alpha!.id)
    const betaResult = await model.getElementExactSource(beta!.id)

    expect(alphaResult).not.toBeNull()
    expect(betaResult).not.toBeNull()

    // Isolamento: o range de beta não contém alpha
    expect(betaResult!.content).not.toContain('alpha')
    expect(betaResult!.content).toContain('beta')
    expect(alphaResult!.content).toContain('alpha')
  })

  it('deve recusar recuperação exata para import/export (retrievable=false)', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)

    const { writeFileSync } = await import('fs')
    const { join } = await import('path')
    writeFileSync(join(repoPath, 'mod.ts'), 'import { helper } from "./helper";\nexport const ready = true;\n', 'utf-8')
    await model.indexRepository()

    const file = model.getFiles().find((f) => f.relativePath === 'mod.ts')
    const elements = model.getElementsByFile(file!.id)

    const imp = elements.find((e) => e.kind === 'import')
    const exp = elements.find((e) => e.kind === 'export')
    expect(imp).toBeDefined()
    expect(exp).toBeDefined()
    expect(imp!.retrievable).toBe(false)
    expect(exp!.retrievable).toBe(false)

    const impResult = await model.getElementExactSource(imp!.id)
    const expResult = await model.getElementExactSource(exp!.id)
    expect(impResult).toBeNull()
    expect(expResult).toBeNull()

    // Unidade recuperável no mesmo arquivo continua funcionando
    const ready = elements.find((e) => e.name === 'ready' && e.kind === 'constant')
    expect(ready).toBeDefined()
    const readyResult = await model.getElementExactSource(ready!.id)
    expect(readyResult).not.toBeNull()
    expect(readyResult!.content).toContain('ready')
  })

  it('Matriz TS/JS — igualdade estrita buffer[startByte:endByte] === recuperado', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)

    const content = [
      '// comentario com acentuacao e emoji antes',
      'const target = 42;',
      'export function greet(nome: string): string {',
      '  return "ola " + nome;',
      '}',
      'export function after(): void {}'
    ].join('\n')

    writeFileSync(join(repoPath, 'matrix.ts'), content, 'utf-8')
    await model.indexRepository()

    const file = model.getFiles().find(f => f.relativePath === 'matrix.ts')
    const elements = model.getElementsByFile(file!.id)
    const buffer = Buffer.from(content, 'utf-8')

    for (const el of elements) {
      if (!el.retrievable) continue
      const expected = buffer.subarray(el.location.start.byte, el.location.end.byte).toString('utf-8')
      const result = await model.getElementExactSource(el.id)
      expect(result).not.toBeNull()
      expect(result!.content).toBe(expected)
    }

    const target = elements.find(e => e.name === 'target' && e.kind === 'constant')
    expect(target).toBeDefined()
    expect((await model.getElementExactSource(target!.id))!.content).toBe('const target = 42;')
  })

  it('Matriz CRLF e ausencia de newline final', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)

    const content = 'const a = 1;\r\nconst target = 2;\r\nexport function last() {}\r\nexport function tail() {}'
    writeFileSync(join(repoPath, 'crlf.ts'), content, 'utf-8')
    await model.indexRepository()

    const file = model.getFiles().find(f => f.relativePath === 'crlf.ts')
    const elements = model.getElementsByFile(file!.id)
    const buffer = Buffer.from(content, 'utf-8')

    const target = elements.find(e => e.name === 'target' && e.kind === 'constant')
    expect(target).toBeDefined()
    const expected = buffer.subarray(target!.location.start.byte, target!.location.end.byte).toString('utf-8')
    expect((await model.getElementExactSource(target!.id))!.content).toBe(expected)
    expect(expected).toBe('const target = 2;')

    const last = elements.find(e => e.name === 'tail' && e.kind === 'function')
    expect(last).toBeDefined()
    const lastExp = buffer.subarray(last!.location.start.byte, last!.location.end.byte).toString('utf-8')
    expect((await model.getElementExactSource(last!.id))!.content).toBe(lastExp)
  })
  
  it('Elementos consecutivos e nested', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)
    const content = [
      'export class Service {',
      '  run(): void {}',
      '  stop(): void {}',
      '}'
    ].join('\n')
    writeFileSync(join(repoPath, 'nested.ts'), content, 'utf-8')
    await model.indexRepository()
    const file = model.getFiles().find(f => f.relativePath === 'nested.ts')
    const elements = model.getElementsByFile(file!.id)
    const buffer = Buffer.from(content, 'utf-8')
    const run = elements.find(e => e.name === 'run' && e.kind === 'method')
    const stop = elements.find(e => e.name === 'stop' && e.kind === 'method')
    expect(run).toBeDefined()
    expect(stop).toBeDefined()
    const stopResult = await model.getElementExactSource(stop!.id)
    expect(stopResult!.content).not.toContain('run')
    expect(stopResult!.content).toContain('stop')
    const runExp = buffer.subarray(run!.location.start.byte, run!.location.end.byte).toString('utf-8')
    expect((await model.getElementExactSource(run!.id))!.content).toBe(runExp)
  })

  it('CSS - recuperacao exata de cssRule, cssCustomProperty e cssAtRule', async () => {
    repoPath = createTempRepo()
    model = createRepositoryModel(repoPath)
    const css = [
      ':root {',
      '  --brand-color: #ff00ff;',
      '}',
      '.botao { color: red; }',
      '@media (max-width: 600px) {',
      '  .mobile { display: none; }',
      '}'
    ].join('\n')
    writeFileSync(join(repoPath, 'styles.css'), css, 'utf-8')
    await model.indexRepository()
    const file = model.getFiles().find(f => f.relativePath === 'styles.css')
    const elements = model.getElementsByFile(file!.id)
    const buffer = Buffer.from(css, 'utf-8')
    const root = elements.find(e => e.kind === 'cssRule' && e.name === ':root')
    expect(root).toBeDefined()
    const rootExp = buffer.subarray(root!.location.start.byte, root!.location.end.byte).toString('utf-8')
    expect((await model.getElementExactSource(root!.id))!.content).toBe(rootExp)
    expect(rootExp).toContain('--brand-color')
    const brand = elements.find(e => e.kind === 'cssCustomProperty' && e.name === '--brand-color')
    expect(brand).toBeDefined()
    const brandExp = buffer.subarray(brand!.location.start.byte, brand!.location.end.byte).toString('utf-8')
    expect((await model.getElementExactSource(brand!.id))!.content).toBe(brandExp)
    const media = elements.find(e => e.kind === 'cssAtRule' && e.name === '@media')
    expect(media).toBeDefined()
    const mediaExp = buffer.subarray(media!.location.start.byte, media!.location.end.byte).toString('utf-8')
    expect((await model.getElementExactSource(media!.id))!.content).toBe(mediaExp)
    expect(mediaExp).toContain('.mobile')
    const botao = elements.find(e => e.kind === 'cssRule' && e.name === '.botao')
    expect((await model.getElementExactSource(botao!.id))!.content).not.toContain('@media')
  })
})