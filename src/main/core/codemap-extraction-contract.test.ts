/*
-T ---
*/

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { getParser, getLanguageForExtension } from './language-adapter'
import { classifyElement, readStructure } from './structure-reader'
import { CssStructureExtractor } from './extraction/css-extractor'
import type { CodeMapElement } from '../../shared/types'
import { resolveSymbolReferences, type SymbolReferenceFile } from './symbol-reference-resolver'

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

describe('CodeMap — Symbol References sintáticas', () => {
  const sourceAt = (content: string, location: CodeMapElement['location']): string =>
    Buffer.from(content, 'utf-8').subarray(location.start.byte, location.end.byte).toString('utf-8')

  it('extrai somente bindings de imports nomeados e preserva aliases e ranges', () => {
    const code = [
      "import Default, { Foo } from './foo'",
      "import { Original as Alias } from './alias'",
      "import * as ns from './namespace'"
    ].join('\n')

    const result = readStructure('symbols-repo', 'imports.ts', '.ts', code)

    expect(result.importBindings.map(({ sourceModule, importedName, localName }) => ({
      sourceModule,
      importedName,
      localName
    }))).toEqual([
      { sourceModule: './foo', importedName: 'Foo', localName: 'Foo' },
      { sourceModule: './alias', importedName: 'Original', localName: 'Alias' }
    ])
    expect(result.importBindings.map((binding) => sourceAt(code, binding.location))).toEqual(['Foo', 'Alias'])
    expect(result.symbolReferences).toEqual([])
  })

  it('extrai calls, instantiations, tipos e referências com o ancestral estrutural mais próximo', () => {
    const code = [
      '// café 🧭',
      "import { Foo, Original as Bar } from './symbols'",
      'function start(value: Foo): Promise<Bar> {',
      '  const selected: Foo = Foo',
      '  const callback = () => new Bar()',
      '  run()',
      '  service.run()',
      '  return selected',
      '}',
      'class Child extends Foo implements Bar {',
      '  method(): Foo[] {',
      '    return Foo',
      '  }',
      '}'
    ].join('\r\n')

    const result = readStructure('symbols-repo', 'uses.ts', '.ts', code)
    const start = result.elements.find((element) => element.kind === 'function' && element.name === 'start')!
    const child = result.elements.find((element) => element.kind === 'class' && element.name === 'Child')!
    const method = result.elements.find((element) => element.kind === 'method' && element.name === 'method')!

    expect(result.symbolReferences.filter((reference) => reference.kind === 'instantiation')).toMatchObject([
      { name: 'Bar', sourceElementId: start.id }
    ])
    expect(result.symbolReferences.filter((reference) => reference.kind === 'call')).toMatchObject([
      { name: 'run', sourceElementId: start.id },
      { name: 'run', sourceElementId: start.id, receiver: 'identifier', receiverName: 'service' }
    ])
    expect(result.symbolReferences.some((reference) => reference.kind === 'call' && reference.name === 'service.run')).toBe(false)

    const typeReferences = result.symbolReferences.filter((reference) => reference.kind === 'type')
    expect(typeReferences.map((reference) => reference.name)).toEqual([
      'Foo', 'Promise', 'Bar', 'Foo', 'Foo', 'Bar', 'Foo'
    ])
    expect(typeReferences.slice(0, 4).every((reference) => reference.sourceElementId === start.id)).toBe(true)
    expect(typeReferences.slice(4, 6).every((reference) => reference.sourceElementId === child.id)).toBe(true)
    expect(typeReferences[6].sourceElementId).toBe(method.id)

    expect(result.symbolReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Foo', kind: 'reference', sourceElementId: start.id }),
      expect.objectContaining({ name: 'service', kind: 'reference', sourceElementId: start.id }),
      expect.objectContaining({ name: 'selected', kind: 'reference', sourceElementId: start.id }),
      expect.objectContaining({ name: 'Foo', kind: 'reference', sourceElementId: method.id })
    ]))
    expect(result.symbolReferences.every((reference) => sourceAt(code, reference.location) === reference.name)).toBe(true)

    const occurrenceKeys = result.symbolReferences.map((reference) =>
      `${reference.location.start.byte}:${reference.location.end.byte}`
    )
    expect(new Set(occurrenceKeys).size).toBe(occurrenceKeys.length)
  })

  it('captura somente chamadas this.method com receiver e source method explícitos', () => {
    const code = [
      'class Service {',
      '  start() {',
      '    this.execute()',
      '    this.execute()',
      '    this.service.execute()',
      '    service.execute()',
      '    this[name]()',
      '  }',
      '  execute() {}',
      '}'
    ].join('\n')

    const result = readStructure('member-repo', 'service.ts', '.ts', code)
    const start = result.elements.find((element) => element.kind === 'method' && element.name === 'start')!
    const calls = result.symbolReferences.filter((reference) => reference.receiver === 'this')

    expect(calls).toHaveLength(2)
    expect(calls).toEqual([
      expect.objectContaining({ name: 'execute', receiver: 'this', sourceElementId: start.id }),
      expect.objectContaining({ name: 'execute', receiver: 'this', sourceElementId: start.id })
    ])
    expect(calls.every((reference) => sourceAt(code, reference.location) === 'execute')).toBe(true)
    expect(result.symbolReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'execute', receiver: 'identifier', receiverName: 'service', sourceElementId: start.id })
    ]))
  })

  it('captura this.method com os mesmos fatos estruturais em JavaScript', () => {
    const code = 'class Service { start() { this.execute() } execute() {} }'
    const result = readStructure('member-js-repo', 'service.js', '.js', code)
    const start = result.elements.find((element) => element.kind === 'method' && element.name === 'start')!

    expect(result.symbolReferences.filter((reference) => reference.receiver === 'this')).toEqual([
      expect.objectContaining({ name: 'execute', kind: 'call', sourceElementId: start.id })
    ])
  })

  it('preserva binding e tipo simples de parâmetros em member calls TypeScript', () => {
    const code = [
      'class Service { execute() {} }',
      'function run(service: Service, untyped, union: Service | null) {',
      '  service.execute()',
      '  untyped.execute()',
      '  union.execute()',
      '  arbitrary.execute()',
      '  service.inner.execute()',
      '  service["execute"]()',
      '}',
      'function generic<T extends Service>(service: T) { service.execute() }',
      'function optional(service?: Service) { service?.execute() }'
    ].join('\n')

    const result = readStructure('typed-member-repo', 'typed.ts', '.ts', code)
    const memberCalls = result.symbolReferences.filter((reference) => reference.receiver === 'identifier')

    expect(memberCalls).toEqual([
      expect.objectContaining({ name: 'execute', receiverName: 'service', receiverTypeName: 'Service' }),
      expect.objectContaining({ name: 'execute', receiverName: 'untyped' }),
      expect.objectContaining({ name: 'execute', receiverName: 'union' }),
      expect.objectContaining({ name: 'execute', receiverName: 'arbitrary' }),
      expect.objectContaining({ name: 'execute', receiverName: 'service' }),
      expect.objectContaining({ name: 'execute', receiverName: 'service', receiverTypeName: 'Service' })
    ])
    expect(memberCalls.filter((reference) => reference.receiverTypeName === 'Service')).toHaveLength(2)
    expect(memberCalls.some((reference) => reference.receiverName === 'union' && reference.receiverTypeName)).toBe(false)
    expect(memberCalls.some((reference) => reference.receiverName === 'service' && reference.location.start.line === 10 && reference.receiverTypeName)).toBe(false)
  })

  it('vincula parâmetros tipados ao método e ao construtor que contêm a chamada', () => {
    const code = [
      'class Service { execute() {} }',
      'class Controller {',
      '  constructor(service: Service) { service.execute() }',
      '  run(service: Service) { service.execute() }',
      '}'
    ].join('\n')

    const result = readStructure('typed-member-scopes-repo', 'controller.ts', '.ts', code)
    const constructor = result.elements.find((element) => element.kind === 'method' && element.name === 'constructor')!
    const run = result.elements.find((element) => element.kind === 'method' && element.name === 'run')!
    const calls = result.symbolReferences.filter((reference) =>
      reference.receiver === 'identifier' && reference.name === 'execute'
    )

    expect(calls).toEqual([
      expect.objectContaining({ receiverName: 'service', receiverTypeName: 'Service', sourceElementId: constructor.id }),
      expect.objectContaining({ receiverName: 'service', receiverTypeName: 'Service', sourceElementId: run.id })
    ])
  })

  it('fecha shadowing de callback, função aninhada e variável local', () => {
    const code = [
      'class Service { execute() {} }',
      'class Other { execute() {} }',
      'function outer(service: Service) {',
      '  service.execute()',
      '  items.map(service => service.execute())',
      '  function inner(service: Other) { service.execute() }',
      '  function closure() { service.execute() }',
      '  function shadowed() { const service = value; service.execute() }',
      '}'
    ].join('\n')

    const result = readStructure('shadow-member-repo', 'shadow.ts', '.ts', code)
    const calls = result.symbolReferences.filter((reference) => reference.receiver === 'identifier' && reference.name === 'execute')

    expect(calls.map((reference) => ({ line: reference.location.start.line, type: reference.receiverTypeName ?? null }))).toEqual([
      { line: 4, type: 'Service' },
      { line: 5, type: null },
      { line: 6, type: 'Other' },
      { line: 7, type: 'Service' },
      { line: 8, type: null }
    ])
  })

  it('vincula const com new direto em funções, métodos, callbacks e classes genéricas', () => {
    const code = [
      'class Service { execute() {} }',
      'class Repository<T> { save() {} }',
      'function run() {',
      '  const service = new Service()',
      '  service.execute()',
      '  items.map(() => { const nested = new Service(); nested.execute() })',
      '}',
      'class Controller {',
      '  execute() { const repo = new Repository<Model>(); repo.save() }',
      '}'
    ].join('\n')

    const result = readStructure('const-new-member-repo', 'const-new.ts', '.ts', code)
    const calls = result.symbolReferences.filter((reference) =>
      reference.receiver === 'identifier' && reference.receiverBindingKind === 'const-new'
    )

    expect(calls).toEqual([
      expect.objectContaining({ name: 'execute', receiverName: 'service', receiverTypeName: 'Service' }),
      expect.objectContaining({ name: 'execute', receiverName: 'nested', receiverTypeName: 'Service' }),
      expect.objectContaining({ name: 'save', receiverName: 'repo', receiverTypeName: 'Repository' })
    ])
  })

  it('respeita bloco, callback shadowing e ordem da declaração para const-new', () => {
    const code = [
      'class A { execute() {} }',
      'class B { execute() {} }',
      'const service = new A()',
      'function run() {',
      '  service.execute()',
      '  { const service = new B(); service.execute() }',
      '  service.execute()',
      '  items.map(service => service.execute())',
      '  late.execute()',
      '  const late = new A()',
      '}'
    ].join('\n')

    const result = readStructure('const-new-scope-repo', 'scope.ts', '.ts', code)
    const calls = result.symbolReferences.filter((reference) =>
      reference.receiver === 'identifier' && reference.name === 'execute'
    )

    expect(calls.map((reference) => ({
      line: reference.location.start.line,
      type: reference.receiverTypeName ?? null,
      binding: reference.receiverBindingKind ?? null
    }))).toEqual([
      { line: 5, type: 'A', binding: 'const-new' },
      { line: 6, type: 'B', binding: 'const-new' },
      { line: 7, type: 'A', binding: 'const-new' },
      { line: 8, type: null, binding: 'parameter' },
      { line: 9, type: null, binding: null }
    ])
  })

  it('mantém let, factory, conditional, namespace e destructuring sem tipo de receiver', () => {
    const code = [
      'function run() {',
      '  let mutable = new Service(); mutable.execute()',
      '  const factory = createService(); factory.execute()',
      '  const conditional = flag ? new A() : new B(); conditional.execute()',
      '  const namespaced = new ns.Service(); namespaced.execute()',
      '  const { service } = container; service.execute()',
      '  arbitrary.inner.execute()',
      '}'
    ].join('\n')

    const result = readStructure('const-new-negative-repo', 'negative.ts', '.ts', code)
    const calls = result.symbolReferences.filter((reference) => reference.receiver === 'identifier')

    expect(calls).toHaveLength(5)
    expect(calls.every((reference) => reference.receiverTypeName === undefined)).toBe(true)
    expect(calls.every((reference) => reference.receiverBindingKind === undefined)).toBe(true)
  })

  it('mantém shadowing como fato sintático sem vincular candidatos a imports', () => {
    const code = [
      "import { Foo } from './foo'",
      'function invoke(Foo: Something) {',
      '  Foo()',
      '}'
    ].join('\n')

    const result = readStructure('symbols-repo', 'shadow.ts', '.ts', code)
    const invoke = result.elements.find((element) => element.kind === 'function' && element.name === 'invoke')!
    const shadowingParameter = result.elements.find((element) => element.kind === 'parameter' && element.name === 'Foo')!

    expect(result.importBindings).toHaveLength(1)
    expect(shadowingParameter.parentElementId).toBe(invoke.id)
    expect(result.symbolReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Something', kind: 'type', sourceElementId: invoke.id }),
      expect.objectContaining({ name: 'Foo', kind: 'call', sourceElementId: invoke.id })
    ]))
    expect(Object.keys(result.symbolReferences[0])).not.toContain('targetElementId')
  })

  it('extrai fatos equivalentes em JavaScript e referências locais simples', () => {
    const code = [
      "import { Factory as LocalFactory } from './factory.js'",
      'const localValue = 1',
      'function create() {',
      '  use(localValue)',
      '  service.use()',
      '  return new LocalFactory()',
      '}'
    ].join('\n')

    const result = readStructure('symbols-repo', 'uses.js', '.js', code)
    const create = result.elements.find((element) => element.kind === 'function' && element.name === 'create')!

    expect(result.importBindings).toMatchObject([
      { sourceModule: './factory.js', importedName: 'Factory', localName: 'LocalFactory' }
    ])
    expect(result.symbolReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'use', kind: 'call', sourceElementId: create.id }),
      expect.objectContaining({ name: 'localValue', kind: 'reference', sourceElementId: create.id }),
      expect.objectContaining({ name: 'LocalFactory', kind: 'instantiation', sourceElementId: create.id })
    ]))
    expect(result.symbolReferences.filter((reference) => reference.kind === 'call' && reference.name === 'use')).toHaveLength(2)
    expect(result.symbolReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'use', receiver: 'identifier', receiverName: 'service' })
    ]))
  })
})

describe('CodeMap — Symbol References resolvidas', () => {
  const repositoryId = 'resolved-symbols-repo'

  function extractedFile(relativePath: string, content: string): SymbolReferenceFile {
    const extension = relativePath.slice(relativePath.lastIndexOf('.'))
    const result = readStructure(repositoryId, relativePath, extension, content)
    const fileId = createHash('sha256').update(`${repositoryId}:${relativePath}`).digest('hex').substring(0, 16)
    for (const element of result.elements) element.fileId = fileId
    return {
      fileId,
      relativePath,
      elements: result.elements,
      importBindings: result.importBindings,
      exportedConstNewBindings: result.exportedConstNewBindings,
      exportedConstCallBindings: result.exportedConstCallBindings,
      symbolReferences: result.symbolReferences
    }
  }

  it('resolve uma fixture multi-file com IDs reais e zero falsas resoluções', () => {
    const serviceSource = [
      'export class Service {}',
      'export function execute() {}'
    ].join('\n')
    const typesSource = [
      'export interface ServiceConfig { endpoint: string }',
      'export type ServiceId = string'
    ].join('\n')
    const appSource = [
      "import { Service, execute } from './service'",
      "import { Service as DataService } from './service'",
      "import { ServiceConfig, ServiceId } from './types'",
      'new Service()',
      'new DataService()',
      'execute()',
      'const config: ServiceConfig = {} as ServiceConfig',
      "const id: ServiceId = 'id'",
      'function load(input: ServiceConfig): Promise<ServiceConfig[]> {',
      '  return config',
      '}'
    ].join('\n')

    const service = extractedFile('src/service.ts', serviceSource)
    const types = extractedFile('src/types.ts', typesSource)
    const app = extractedFile('src/app.ts', appSource)
    const resolved = resolveSymbolReferences('.', [service, types, app])

    const serviceClass = service.elements.find((element) => element.kind === 'class' && element.name === 'Service')!
    const executeFunction = service.elements.find((element) => element.kind === 'function' && element.name === 'execute')!
    const serviceConfig = types.elements.find((element) => element.kind === 'interface' && element.name === 'ServiceConfig')!
    const serviceId = types.elements.find((element) => element.kind === 'typeAlias' && element.name === 'ServiceId')!
    const config = app.elements.find((element) => element.kind === 'constant' && element.name === 'config')!
    const expectedTargets = new Map([
      ['Service', serviceClass.id],
      ['DataService', serviceClass.id],
      ['execute', executeFunction.id],
      ['ServiceConfig', serviceConfig.id],
      ['ServiceId', serviceId.id],
      ['config', config.id]
    ])
    const candidatesByRange = new Map(app.symbolReferences.map((candidate) => [
      `${candidate.location.start.byte}:${candidate.location.end.byte}`,
      candidate
    ]))
    const falseResolutions = resolved.filter((reference) => {
      const candidate = candidatesByRange.get(`${reference.location.start.byte}:${reference.location.end.byte}`)
      return !candidate || expectedTargets.get(candidate.name) !== reference.targetElementId
    })
    const metrics = {
      candidates: app.symbolReferences.length,
      resolved: resolved.length,
      intentionallyUnresolved: app.symbolReferences.length - resolved.length,
      falseResolutions: falseResolutions.length
    }

    expect(metrics).toEqual({
      candidates: 10,
      resolved: 9,
      intentionallyUnresolved: 1,
      falseResolutions: 0
    })
    expect(resolved.every((reference) => reference.sourceFileId === app.fileId)).toBe(true)
    expect(resolved.filter((reference) => reference.targetElementId === serviceClass.id)).toHaveLength(2)
    expect(resolved.some((reference) => reference.targetElementId === executeFunction.id && reference.kind === 'call')).toBe(true)
    expect(resolved.filter((reference) => reference.targetElementId === serviceConfig.id)).toHaveLength(4)
    expect(resolved.some((reference) => reference.targetElementId === serviceId.id && reference.kind === 'type')).toBe(true)
    expect(resolved.some((reference) => reference.targetElementId === config.id && reference.kind === 'reference')).toBe(true)
  })

  it('mantém callback JavaScript potencialmente sombreado como unresolved', () => {
    const target = extractedFile('src/foo.js', 'export function Foo() {}')
    const app = extractedFile('src/app.js', [
      "import { Foo } from './foo'",
      'function outer() {',
      '  const callback = (Foo) => Foo()',
      '  return callback',
      '}'
    ].join('\n'))

    const fooCall = app.symbolReferences.find((candidate) => candidate.name === 'Foo' && candidate.kind === 'call')!
    expect(fooCall).toBeDefined()
    expect(resolveSymbolReferences('.', [target, app]).some((reference) =>
      reference.location.start.byte === fooCall.location.start.byte &&
      reference.location.end.byte === fooCall.location.end.byte
    )).toBe(false)
  })

  it('resolve corpus Tier 3 local, importado, alias, herança e override sem falsos positivos', () => {
    const target = extractedFile('src/services.ts', [
      'export class Service { execute() {} }',
      'export class Base { execute() {} }',
      'export class Child extends Base {}',
      'export class Overridden extends Base { execute() {} }'
    ].join('\n'))
    const app = extractedFile('src/const-new.ts', [
      "import { Service, Service as DataService, Child, Overridden } from './services'",
      'class LocalService { execute() {} }',
      'export function run() {',
      '  const local = new LocalService(); local.execute()',
      '  const direct = new Service(); direct.execute()',
      '  const alias = new DataService(); alias.execute()',
      '  const child = new Child(); child.execute()',
      '  const overridden = new Overridden(); overridden.execute()',
      '  let mutable = new Service(); mutable.execute()',
      '  const factory = createService(); factory.execute()',
      '}'
    ].join('\n'))

    const resolved = resolveSymbolReferences('.', [target, app])
    const tier3 = app.symbolReferences.filter((candidate) => candidate.receiverBindingKind === 'const-new')
    const resolvedByRange = new Map(resolved.map((reference) => [
      `${reference.location.start.byte}:${reference.location.end.byte}`,
      reference
    ]))
    const tier3Resolved = tier3.map((candidate) => resolvedByRange.get(
      `${candidate.location.start.byte}:${candidate.location.end.byte}`
    )).filter((reference) => reference !== undefined)
    const owners = new Map(target.elements
      .filter((element) => element.kind === 'class')
      .map((element) => [element.name, element]))
    const method = (owner: string) => [...target.elements, ...app.elements].find((element) =>
      element.kind === 'method' && element.name === 'execute' &&
      element.parentElementId === (owners.get(owner) ?? app.elements.find((candidate) => candidate.name === owner))?.id
    )!

    expect(tier3).toHaveLength(5)
    expect(tier3Resolved.map((reference) => reference!.targetElementId)).toEqual([
      method('LocalService').id,
      method('Service').id,
      method('Service').id,
      method('Base').id,
      method('Overridden').id
    ])
    expect({
      occurrences: 7,
      candidates: tier3.length,
      resolved: tier3Resolved.length,
      intentionallyUnresolved: 2,
      falseResolutions: tier3Resolved.filter((reference) =>
        ![method('LocalService').id, method('Service').id, method('Base').id, method('Overridden').id]
          .includes(reference!.targetElementId)
      ).length
    }).toEqual({ occurrences: 7, candidates: 5, resolved: 5, intentionallyUnresolved: 2, falseResolutions: 0 })
  })

  it('resolve corpus Tier 4 local, importado, alias, herança e override sem falsos positivos', () => {
    const target = extractedFile('src/property-services.ts', [
      'export class Service { execute() {} }',
      'export interface ServicePort { execute(): void }',
      'export class Base { execute() {} }',
      'export class Child extends Base {}',
      'export class Overridden extends Base { execute() {} }'
    ].join('\n'))
    const app = extractedFile('src/typed-properties.ts', [
      "import { Service as DataService, ServicePort, Child, Overridden } from './property-services'",
      'class LocalService { execute() {} }',
      'class Controller<T> {',
      '  private service: DataService',
      '  readonly child!: Child',
      '  public local: LocalService',
      '  port: ServicePort',
      '  union: DataService | Child',
      '  generic: T',
      '  inferred = new DataService()',
      '  constructor(private parameter: DataService) {}',
      '  get getter(): DataService { return new DataService() }',
      '  run(service: LocalService) {',
      '    this.service.execute()',
      '    this.child.execute()',
      '    this.local.execute()',
      '    this.port.execute()',
      '    this.union.execute()',
      '    this.generic.execute()',
      '    this.inferred.execute()',
      '    this.parameter.execute()',
      '    this.getter.execute()',
      '    this.service.client.execute()',
      '    this["service"].execute()',
      '  }',
      '}',
      'class OverrideController {',
      '  service: Overridden',
      '  run() { this.service.execute() }',
      '}'
    ].join('\n'))

    const tier4 = app.symbolReferences.filter((candidate) =>
      candidate.receiver === 'this-property' && candidate.receiverPropertyOrigin !== 'constructor-parameter-property'
    )
    const resolved = resolveSymbolReferences('.', [target, app])
    const resolvedByRange = new Map(resolved.map((reference) => [
      `${reference.location.start.byte}:${reference.location.end.byte}`,
      reference
    ]))
    const tier4Resolved = tier4.map((candidate) => resolvedByRange.get(
      `${candidate.location.start.byte}:${candidate.location.end.byte}`
    )).filter((reference) => reference !== undefined)
    const allElements = [...target.elements, ...app.elements]
    const owner = (name: string) => allElements.find((element) => element.kind === 'class' && element.name === name)!
    const method = (ownerName: string) => allElements.find((element) =>
      element.kind === 'method' && element.name === 'execute' && element.parentElementId === owner(ownerName).id
    )!
    const interfaceOwner = allElements.find((element) => element.kind === 'interface' && element.name === 'ServicePort')!
    const interfaceMethod = allElements.find((element) =>
      element.kind === 'method' && element.name === 'execute' && element.parentElementId === interfaceOwner.id
    )!

    expect(app.elements.filter((element) => element.kind === 'property').map((property) => ({
      name: property.name,
      signature: property.declarationSignature
    }))).toEqual(expect.arrayContaining([
      { name: 'service', signature: 'service: DataService' },
      { name: 'child', signature: 'child: Child' },
      { name: 'local', signature: 'local: LocalService' },
      { name: 'union', signature: null },
      { name: 'generic', signature: null },
      { name: 'inferred', signature: null }
    ]))
    expect(tier4.map((candidate) => ({
      property: candidate.receiverPropertyName,
      type: candidate.receiverTypeName ?? null
    }))).toEqual([
      { property: 'service', type: 'DataService' },
      { property: 'child', type: 'Child' },
      { property: 'local', type: 'LocalService' },
      { property: 'port', type: 'ServicePort' },
      { property: 'union', type: null },
      { property: 'generic', type: null },
      { property: 'inferred', type: null },
      { property: 'getter', type: null },
      { property: 'service', type: 'Overridden' }
    ])
    expect(tier4Resolved.map((reference) => reference!.targetElementId)).toEqual([
      method('Service').id,
      method('Base').id,
      method('LocalService').id,
      interfaceMethod.id,
      method('Overridden').id
    ])
    expect({
      occurrences: tier4.length,
      candidates: tier4.filter((candidate) => candidate.receiverTypeName).length,
      resolved: tier4Resolved.length,
      intentionallyUnresolved: tier4.length - tier4Resolved.length,
      falseResolutions: tier4Resolved.filter((reference) =>
        ![method('Service').id, method('Base').id, method('LocalService').id, interfaceMethod.id, method('Overridden').id]
          .includes(reference!.targetElementId)
      ).length
    }).toEqual({ occurrences: 9, candidates: 5, resolved: 5, intentionallyUnresolved: 4, falseResolutions: 0 })
  })

  it('resolve corpus Tier 5 de constructor parameter properties sem confundir parâmetros comuns', () => {
    const target = extractedFile('src/parameter-property-services.ts', [
      'export class Service { execute() {} }',
      'export interface ServicePort { execute(): void }',
      'export class Base { execute() {} }',
      'export class Child extends Base {}',
      'export class Overridden extends Base { execute() {} }',
      'export class OtherService { execute() {} }'
    ].join('\n'))
    const app = extractedFile('src/constructor-properties.ts', [
      "import { Service as DataService, ServicePort, Child, Overridden, OtherService } from './parameter-property-services'",
      'class LocalService { execute() {} }',
      'class PrivateController { constructor(private service: DataService) {} run(service: OtherService) { this.service.execute() } }',
      'class ProtectedController { constructor(protected service: Child) {} run() { this.service.execute() } }',
      'class PublicController { constructor(public service: LocalService) {} run() { this.service.execute() } }',
      'class ReadonlyController { constructor(readonly service: DataService) {} run() { this.service.execute() } }',
      'class PrivateReadonlyController { constructor(private readonly service: Overridden) {} run() { this.service.execute() } }',
      'class DefaultController { constructor(private service: DataService = new DataService()) {} run() { this.service.execute() } }',
      'class NegativeController<T> {',
      '  constructor(service: DataService, private port: ServicePort, private union: DataService | Child, private generic: T, private inferred = new DataService(), private optional?: DataService) {}',
      '  get getter(): DataService { return new DataService() }',
      '  run() {',
      '    this.service.execute(); this.port.execute(); this.union.execute(); this.generic.execute(); this.inferred.execute(); this.optional.execute(); this.getter.execute()',
      '    this.port.client.execute(); this["port"].execute()',
      '  }',
      '}',
      'class ParameterBase { constructor(protected inherited: DataService) {} }',
      'class ParameterChild extends ParameterBase { run() { this.inherited.execute() } }',
      'class AmbiguousController { service: DataService; constructor(private service: DataService) {} run() { this.service.execute() } }'
    ].join('\n'))

    const tier5 = app.symbolReferences.filter((candidate) =>
      candidate.receiver === 'this-property' && candidate.receiverPropertyOrigin === 'constructor-parameter-property'
    )
    const resolved = resolveSymbolReferences('.', [target, app])
    const resolvedByRange = new Map(resolved.map((reference) => [
      `${reference.location.start.byte}:${reference.location.end.byte}`,
      reference
    ]))
    const tier5Resolved = tier5.map((candidate) => resolvedByRange.get(
      `${candidate.location.start.byte}:${candidate.location.end.byte}`
    )).filter((reference) => reference !== undefined)
    const allElements = [...target.elements, ...app.elements]
    const owner = (name: string) => allElements.find((element) => element.kind === 'class' && element.name === name)!
    const method = (ownerName: string) => allElements.find((element) =>
      element.kind === 'method' && element.name === 'execute' && element.parentElementId === owner(ownerName).id
    )!
    const interfaceOwner = allElements.find((element) => element.kind === 'interface' && element.name === 'ServicePort')!
    const interfaceMethod = allElements.find((element) =>
      element.kind === 'method' && element.name === 'execute' && element.parentElementId === interfaceOwner.id
    )!
    const parameterProperties = app.elements.filter((element) =>
      element.kind === 'parameter' && element.modifiers.length > 0
    )

    expect(parameterProperties.map((element) => ({
      name: element.name,
      modifiers: element.modifiers,
      signature: element.declarationSignature
    }))).toEqual(expect.arrayContaining([
      { name: 'service', modifiers: ['private'], signature: 'service: DataService' },
      { name: 'service', modifiers: ['protected'], signature: 'service: Child' },
      { name: 'service', modifiers: ['public'], signature: 'service: LocalService' },
      { name: 'service', modifiers: ['readonly'], signature: 'service: DataService' },
      { name: 'service', modifiers: ['private', 'readonly'], signature: 'service: Overridden' }
    ]))
    expect(tier5.map((candidate) => ({
      property: candidate.receiverPropertyName,
      type: candidate.receiverTypeName ?? null
    }))).toEqual([
      { property: 'service', type: 'DataService' },
      { property: 'service', type: 'Child' },
      { property: 'service', type: 'LocalService' },
      { property: 'service', type: 'DataService' },
      { property: 'service', type: 'Overridden' },
      { property: 'service', type: 'DataService' },
      { property: 'port', type: 'ServicePort' },
      { property: 'union', type: null },
      { property: 'generic', type: null },
      { property: 'inferred', type: null },
      { property: 'optional', type: null }
    ])
    expect(tier5Resolved.map((reference) => reference!.targetElementId)).toEqual([
      method('Service').id,
      method('Base').id,
      method('LocalService').id,
      method('Service').id,
      method('Overridden').id,
      method('Service').id,
      interfaceMethod.id
    ])
    const unresolvedNames = ['service', 'inherited', 'getter']
    for (const propertyName of unresolvedNames) {
      const candidates = app.symbolReferences.filter((candidate) =>
        candidate.receiver === 'this-property' &&
        candidate.receiverPropertyName === propertyName &&
        candidate.receiverPropertyOrigin !== 'constructor-parameter-property'
      )
      expect(candidates.some((candidate) => !resolvedByRange.has(
        `${candidate.location.start.byte}:${candidate.location.end.byte}`
      ))).toBe(true)
    }
    expect({
      occurrences: tier5.length,
      candidates: tier5.filter((candidate) => candidate.receiverTypeName).length,
      resolved: tier5Resolved.length,
      intentionallyUnresolved: tier5.length - tier5Resolved.length,
      falseResolutions: tier5Resolved.filter((reference) =>
        ![method('Service').id, method('Base').id, method('LocalService').id, interfaceMethod.id, method('Overridden').id]
          .includes(reference!.targetElementId)
      ).length
    }).toEqual({ occurrences: 11, candidates: 7, resolved: 7, intentionallyUnresolved: 4, falseResolutions: 0 })
  })

  it('resolve corpus Tier 6 para contrato direto sem dispatch concreto e preserva negativos', () => {
    const contracts = extractedFile('src/contracts.ts', [
      'export interface ServicePort { execute(): void }',
      'export interface OverloadedPort { execute(value: string): void; execute(value: number): void }',
      'export interface BasePort { inherited(): void }',
      'export interface ChildPort extends BasePort {}',
      'export class ServiceA implements ServicePort { execute() {} }',
      'export class ServiceB implements ServicePort { execute() {} }'
    ].join('\n'))
    const app = extractedFile('src/interface-contracts.ts', [
      "import { ServicePort, ServicePort as Port, OverloadedPort, ChildPort } from './contracts'",
      'interface LocalPort { execute(): void }',
      'export interface ExportedPort { execute(): void }',
      'export function parameters(local: LocalPort, exported: ExportedPort, service: ServicePort, alias: Port) {',
      '  local.execute(); exported.execute(); service.execute(); alias.execute()',
      '}',
      'export class Controller<T> {',
      '  service: ServicePort',
      '  constructor(private client: Port) {}',
      '  run(overloaded: OverloadedPort, child: ChildPort, union: ServicePort | LocalPort, generic: T) {',
      '    this.service.execute(); this.client.execute()',
      '    overloaded.execute("value"); child.inherited(); union.execute(); generic.execute()',
      '    this.service?.execute(); serviceOptional(this.service)',
      '  }',
      '}',
      'function serviceOptional(service: ServicePort) { service.execute?.() }'
    ].join('\n'))

    const resolved = resolveSymbolReferences('.', [contracts, app])
    const allElements = [...contracts.elements, ...app.elements]
    const interfaceMethods = new Set(allElements.filter((element) => {
      if (element.kind !== 'method' || !element.parentElementId) return false
      return allElements.some((parent) => parent.id === element.parentElementId && parent.kind === 'interface')
    }).map((element) => element.id))
    const contractCalls = resolved.filter((reference) =>
      reference.kind === 'call' && interfaceMethods.has(reference.targetElementId)
    )
    const concreteMethods = new Set(contracts.elements.filter((element) => {
      if (element.kind !== 'method' || !element.parentElementId) return false
      return contracts.elements.some((parent) =>
        parent.id === element.parentElementId && parent.kind === 'class' && ['ServiceA', 'ServiceB'].includes(parent.name)
      )
    }).map((element) => element.id))
    const optionalCalls = app.symbolReferences.filter((candidate) => candidate.optional)

    expect(contractCalls).toHaveLength(6)
    expect(new Set(contractCalls.map((reference) => reference.targetElementId)).size).toBe(3)
    expect(resolved.some((reference) => concreteMethods.has(reference.targetElementId))).toBe(false)
    expect(optionalCalls).toHaveLength(2)
    expect(optionalCalls.every((candidate) => !resolved.some((reference) =>
      reference.location.start.byte === candidate.location.start.byte &&
      reference.location.end.byte === candidate.location.end.byte
    ))).toBe(true)
    expect(app.symbolReferences.filter((candidate) =>
      ['overloaded', 'child', 'union', 'generic'].includes(candidate.receiverName ?? '')
    ).every((candidate) => !resolved.some((reference) =>
      reference.location.start.byte === candidate.location.start.byte &&
      reference.location.end.byte === candidate.location.end.byte
    ))).toBe(true)
    expect(contractCalls.every((reference) => reference.kind === 'call')).toBe(true)
  })

  it('resolve Tier 7 por export const new estrutural, aliases, herança e override sem falsos positivos', () => {
    const services = extractedFile('src/services.ts', [
      'export class Service { execute() {} }',
      'export class Base { execute() {} }',
      'export class Child extends Base {}',
      'export class Overridden extends Base { execute() {} }'
    ].join('\n'))
    const runtime = extractedFile('src/runtime.ts', [
      "import { Service as InternalService, Child, Overridden } from './services'",
      'class LocalService { execute() {} }',
      'export const local = new LocalService()',
      'export const imported = new InternalService()',
      'export const inherited = new Child()',
      'export const overridden = new Overridden()',
      'export const factory = createService()',
      'export const singleton = InternalService.getInstance()',
      'export const conditional = flag ? new InternalService() : new Child()',
      'export let mutable = new InternalService()',
      'export const array = [new InternalService()]',
      'export const object = { service: new InternalService() }',
      'export const namespaced = new namespace.Service()'
    ].join('\n'))
    const app = extractedFile('src/app.ts', [
      "import { local, imported as service, inherited, overridden, factory, singleton, conditional, mutable, array, object, namespaced } from './runtime'",
      "import { external } from 'external-package'",
      'export function run() {',
      '  local.execute(); service.execute(); inherited.execute(); overridden.execute()',
      '  factory.execute(); singleton.execute(); conditional.execute(); mutable.execute()',
      '  array.execute(); object.execute(); namespaced.execute(); external.execute()',
      '}',
      'export function shadowed() { const service = unknown; service.execute() }'
    ].join('\n'))

    expect(runtime.exportedConstNewBindings.map((binding) => ({
      exportedName: binding.exportedName,
      constructorName: binding.constructorName
    }))).toEqual([
      { exportedName: 'local', constructorName: 'LocalService' },
      { exportedName: 'imported', constructorName: 'InternalService' },
      { exportedName: 'inherited', constructorName: 'Child' },
      { exportedName: 'overridden', constructorName: 'Overridden' }
    ])

    const resolved = resolveSymbolReferences('.', [services, runtime, app])
    const tier7Calls = resolved.filter((reference) =>
      reference.sourceFileId === app.fileId && reference.kind === 'call'
    )
    const allElements = [...services.elements, ...runtime.elements]
    const owner = (name: string) => allElements.find((element) => element.kind === 'class' && element.name === name)!
    const method = (ownerName: string) => allElements.find((element) =>
      element.kind === 'method' && element.name === 'execute' && element.parentElementId === owner(ownerName).id
    )!

    expect(tier7Calls.map((reference) => reference.targetElementId)).toEqual([
      method('LocalService').id,
      method('Service').id,
      method('Base').id,
      method('Overridden').id
    ])
    expect({
      occurrences: 13,
      candidates: runtime.exportedConstNewBindings.length,
      resolved: tier7Calls.length,
      intentionallyUnresolved: 9,
      falseResolutions: tier7Calls.filter((reference) => ![
        method('LocalService').id,
        method('Service').id,
        method('Base').id,
        method('Overridden').id
      ].includes(reference.targetElementId)).length
    }).toEqual({ occurrences: 13, candidates: 4, resolved: 4, intentionallyUnresolved: 9, falseResolutions: 0 })
  })

  it('resolve Tier 8 por singleton export const com return type explícito (8A) e classe importada static (8B)', () => {
    const services = extractedFile('src/services.ts', [
      'export class SettingsService {',
      '  static getInstance(): SettingsService { return new SettingsService() }',
      '  save() {}',
      '}',
      'export class DevToolsManager {',
      '  static toggle() {}',
      '  instanceMethod() {}',
      '}'
    ].join('\n'))
    const runtime = extractedFile('src/runtime.ts', [
      "import { SettingsService, DevToolsManager } from './services'",
      'export const settingsService = SettingsService.getInstance()',
      'export const factoryNoType = (() => new SettingsService())()',
    ].join('\n'))
    const app = extractedFile('src/app.ts', [
      "import { settingsService, factoryNoType } from './runtime'",
      "import { DevToolsManager } from './services'",
      'export function run() {',
      '  settingsService.save()',
      '  factoryNoType.save()',
      '  DevToolsManager.toggle()',
      '  DevToolsManager.instanceMethod()',
      '}'
    ].join('\n'))

    expect(runtime.exportedConstCallBindings).toEqual([
      {
        declarationElementId: runtime.elements.find((e) => e.name === 'settingsService' && e.kind === 'constant')!.id,
        exportedName: 'settingsService',
        calleeKind: 'member',
        calleeName: 'getInstance',
        calleeReceiverName: 'SettingsService'
      }
    ])

    const resolved = resolveSymbolReferences('.', [services, runtime, app])
    const appCalls = resolved.filter((r) => r.sourceFileId === app.fileId && r.kind === 'call')

    const saveMethod = services.elements.find((e) => e.name === 'save' && e.kind === 'method')!
    const toggleMethod = services.elements.find((e) => e.name === 'toggle' && e.kind === 'method')!

    expect(appCalls.map((r) => r.targetElementId)).toEqual([
      saveMethod.id,
      toggleMethod.id
    ])
    expect(appCalls).toHaveLength(2)
  })
})
