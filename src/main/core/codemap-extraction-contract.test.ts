/*
-T ---
*/

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { getParser, getLanguageForExtension } from './language-adapter'
import { classifyElement, readStructure } from './structure-reader'
import { CssStructureExtractor } from './extraction/css-extractor'
import type { CodeMapElement } from '../../shared/types'

describe('CodeMap — Cobertura Estrutural e Classificação', () => {
  it('deve carregar os módulos structure-reader e language-adapter sem erro', () => {
    // Teste de sanidade: verifica que a suite está corretamente integrada ao Vitest
    expect(getParser).toBeDefined()
    expect(getLanguageForExtension).toBeDefined()
    expect(classifyElement).toBeDefined()
  })

  it('deve reconhecer linguagens suportadas (typescript, tsx, javascript, jsx)', () => {
    expect(getLanguageForExtension('.ts')).toBe('typescript')
    expect(getLanguageForExtension('.tsx')).toBe('typescript-react')
    expect(getLanguageForExtension('.js')).toBe('javascript')
    expect(getLanguageForExtension('.jsx')).toBe('javascript-react')
  })

  it('deve classificar kinds estruturais como recuperáveis', () => {
    const structuralKinds = ['class', 'function', 'method', 'interface', 'typeAlias', 'enum', 'variable', 'constant']
    for (const kind of structuralKinds) {
      const result = classifyElement(kind as any)
      expect(result.granularity).toBe('structural')
      expect(result.retrievable).toBe(true)
    }
  })

  it('deve classificar import/export como syntax não recuperável', () => {
    const syntaxKinds = ['import', 'export']
    for (const kind of syntaxKinds) {
      const result = classifyElement(kind as any)
      expect(result.granularity).toBe('syntax')
      expect(result.retrievable).toBe(false)
    }
  })

  it('deve classificar os novos kinds member como recuperáveis', () => {
    const memberKinds = ['property', 'parameter', 'enumMember', 'cssRule', 'cssCustomProperty']
    for (const kind of memberKinds) {
      const result = classifyElement(kind as any)
      expect(result.granularity).toBe('member')
      expect(result.retrievable).toBe(true)
    }
  })

  it('deve classificar cssAtRule como structural recuperável', () => {
    const result = classifyElement('cssAtRule')
    expect(result.granularity).toBe('structural')
    expect(result.retrievable).toBe(true)
  })
})

describe('CodeMap — Cobertura Estrutural TS (Cenários 1–3)', () => {
  const repoId = 'coverage-repo'

  it('Cenário 1 — const a = 1, b = 2 produz duas unidades com ranges isolados', () => {
    const code = 'const a = 1, b = 2;\n'
    const result = readStructure(repoId, 'multi.ts', '.ts', code)

    const a = result.elements.find((e) => e.name === 'a' && e.kind === 'constant')
    const b = result.elements.find((e) => e.name === 'b' && e.kind === 'constant')

    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a!.retrievable).toBe(true)
    expect(b!.retrievable).toBe(true)

    const content = Buffer.from(code, 'utf-8')
    const aCode = content.subarray(a!.location.start.byte, a!.location.end.byte).toString('utf-8')
    const bCode = content.subarray(b!.location.start.byte, b!.location.end.byte).toString('utf-8')

    // O range do primeiro inclui o keyword const
    expect(aCode).toContain('const')
    expect(aCode).toContain('a = 1')
    // O range do segundo NÃO contém `a = 1`
    expect(bCode).not.toContain('a = 1')
    expect(bCode).toContain('b = 2')
    // IDs distintos
    expect(a!.id).not.toBe(b!.id)
  })

  it('Cenário 2 — const/let top-level é structural; aninhado em função é member; ambos recuperáveis', () => {
    const code = [
      'const topLevel = 1;',
      'let topLevelLet = 2;',
      'function wrap() {',
      '  const nested = 3;',
      '  let nestedLet = 4;',
      '}'
    ].join('\n')

    const result = readStructure(repoId, 'ctx.ts', '.ts', code)

    const topLevel = result.elements.find((e) => e.name === 'topLevel')
    const topLevelLet = result.elements.find((e) => e.name === 'topLevelLet')
    const nested = result.elements.find((e) => e.name === 'nested')
    const nestedLet = result.elements.find((e) => e.name === 'nestedLet')

    expect(topLevel).toBeDefined()
    expect(topLevel!.granularity).toBe('structural')
    expect(topLevel!.retrievable).toBe(true)

    expect(topLevelLet).toBeDefined()
    expect(topLevelLet!.granularity).toBe('structural')
    expect(topLevelLet!.retrievable).toBe(true)

    expect(nested).toBeDefined()
    expect(nested!.granularity).toBe('member')
    expect(nested!.retrievable).toBe(true)

    expect(nestedLet).toBeDefined()
    expect(nestedLet!.granularity).toBe('member')
    expect(nestedLet!.retrievable).toBe(true)
  })

  it('Cenário 3 — propriedade, membro de interface, membro de enum e parâmetro são member; constructor é method structural', () => {
    const code = [
      'class Widget {',
      '  private label: string = "w";',
      '  constructor(size: number) {}',
      '  render(count: number): void {}',
      '}',
      'interface Config {',
      '  name: string;',
      '  apply(value: string): void;',
      '}',
      'enum Color {',
      '  Red = 1,',
      '  Green',
      '}'
    ].join('\n')

    const result = readStructure(repoId, 'members.ts', '.ts', code)

    // Propriedade de classe
    const label = result.elements.find((e) => e.name === 'label')
    expect(label).toBeDefined()
    expect(label!.kind).toBe('property')
    expect(label!.granularity).toBe('member')
    expect(label!.retrievable).toBe(true)

    // Constructor como method structural
    const ctor = result.elements.find((e) => e.name === 'constructor')
    expect(ctor).toBeDefined()
    expect(ctor!.kind).toBe('method')
    expect(ctor!.granularity).toBe('structural')
    expect(ctor!.retrievable).toBe(true)

    // Parâmetro do método
    const count = result.elements.find((e) => e.name === 'count' && e.kind === 'parameter')
    expect(count).toBeDefined()
    expect(count!.granularity).toBe('member')
    expect(count!.retrievable).toBe(true)

    // Propriedade de interface
    const name = result.elements.find((e) => e.name === 'name' && e.kind === 'property')
    expect(name).toBeDefined()
    expect(name!.granularity).toBe('member')
    expect(name!.retrievable).toBe(true)

    // Method signature sob interface = member
    const apply = result.elements.find((e) => e.name === 'apply' && e.kind === 'method')
    expect(apply).toBeDefined()
    expect(apply!.granularity).toBe('member')
    expect(apply!.retrievable).toBe(true)

    // Membros de enum
    const red = result.elements.find((e) => e.name === 'Red' && e.kind === 'enumMember')
    const green = result.elements.find((e) => e.name === 'Green' && e.kind === 'enumMember')
    expect(red).toBeDefined()
    expect(red!.granularity).toBe('member')
    expect(red!.retrievable).toBe(true)
    expect(green).toBeDefined()
    expect(green!.granularity).toBe('member')
    expect(green!.retrievable).toBe(true)
  })
})

describe('CodeMap — Cobertura Estrutural CSS (Cenário 4)', () => {
  const repoId = 'css-repo'
  const extractor = new CssStructureExtractor()

  it('Cenário 4 — rule, custom property, @media aninhado e @keyframes com ranges em bytes', () => {
    // Fixture com acento e emoji em comentário/seletor para validar UTF-8
    const css = [
      '/* comentário com acentoção 🎨 e { chaves } para tokenizer */',
      ':root {',
      '  --brand-color: #ff00ff;',
      '}',
      '.botão { color: red; }',
      '@media (max-width: 600px) {',
      '  .mobile { display: none; }',
      '}',
      '@keyframes fade {',
      '  from { opacity: 0; }',
      '  to { opacity: 1; }',
      '}'
    ].join('\n')

    expect(extractor.supports('.css')).toBe(true)
    const result = extractor.extract({ repositoryId: repoId, relativePath: 'styles.css', extension: '.css', content: css })

    const content = Buffer.from(css, 'utf-8')
    const rangeOf = (el: CodeMapElement): string => content.subarray(el.location.start.byte, el.location.end.byte).toString('utf-8')

    // Rule raiz :root
    const root = result.elements.find((e) => e.kind === 'cssRule' && e.name === ':root')
    expect(root).toBeDefined()
    expect(root!.granularity).toBe('member')
    expect(root!.retrievable).toBe(true)
    expect(root!.parentElementId).toBeNull()
    expect(rangeOf(root!)).toContain('--brand-color')

    // Custom property dentro de :root
    const brand = result.elements.find((e) => e.kind === 'cssCustomProperty' && e.name === '--brand-color')
    expect(brand).toBeDefined()
    expect(brand!.granularity).toBe('member')
    expect(brand!.retrievable).toBe(true)
    // Parentesco: custom property é filha de :root
    expect(brand!.parentElementId).toBe(root!.id)

    // Rule com acento no seletor
    const botao = result.elements.find((e) => e.kind === 'cssRule' && e.name === '.botão')
    expect(botao).toBeDefined()
    expect(rangeOf(botao!)).toContain('color: red')

    // @media
    const media = result.elements.find((e) => e.kind === 'cssAtRule' && e.name === '@media')
    expect(media).toBeDefined()
    expect(media!.granularity).toBe('structural')
    expect(media!.retrievable).toBe(true)
    expect(rangeOf(media!)).toContain('@media')
    expect(rangeOf(media!)).toContain('display: none')

    // Rule aninhada em @media com parentesco
    const mobile = result.elements.find((e) => e.kind === 'cssRule' && e.name === '.mobile')
    expect(mobile).toBeDefined()
    expect(mobile!.parentElementId).toBe(media!.id)

    // @keyframes com rules aninhadas (from/to)
    const keyframes = result.elements.find((e) => e.kind === 'cssAtRule' && e.name === '@keyframes')
    expect(keyframes).toBeDefined()
    const from = result.elements.find((e) => e.kind === 'cssRule' && e.name === 'from')
    const to = result.elements.find((e) => e.kind === 'cssRule' && e.name === 'to')
    expect(from).toBeDefined()
    expect(from!.parentElementId).toBe(keyframes!.id)
    expect(to).toBeDefined()
    expect(to!.parentElementId).toBe(keyframes!.id)

    // Validação de ranges em bytes: o range de cada elemento recorta trecho válido
    for (const el of result.elements) {
      const text = rangeOf(el)
      expect(text.length).toBeGreaterThan(0)
      if (el.kind === 'cssRule' || el.kind === 'cssAtRule') {
        expect(text.trim().startsWith('{')).toBe(false)
      }
    }
  })

  it('Cenário 4b — @import continua gerando apenas relação FILE→FILE (sem elemento cssAtRule)', () => {
    const css = '@import "./theme.css";\n.rule { color: blue; }\n'
    const result = extractor.extract({ repositoryId: repoId, relativePath: 'main.css', extension: '.css', content: css })

    // Nenhum elemento cssAtRule para @import
    const importAtRule = result.elements.find((e) => e.kind === 'cssAtRule' && e.name === '@import')
    expect(importAtRule).toBeUndefined()

    // Relação imports presente
    const imports = result.relationships.filter((r) => r.type === 'imports')
    expect(imports.length).toBe(1)
    expect(imports[0].targetId).toBeDefined()
  })
})
