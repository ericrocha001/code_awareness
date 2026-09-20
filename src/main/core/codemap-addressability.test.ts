/*
-T ---
*/

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getParser, getLanguageForExtension } from './language-adapter'
import { readStructure, StructureExtractionError } from './structure-reader'
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

  it('extrai um elemento localizado depois da antiga fronteira de 32 KiB', () => {
    const prefix = '// padding\n'.repeat(4_000)
    const source = 'function afterOldBufferLimit(value: string): string { return `ação:${value}` }'
    const code = `${prefix}${source}\nexport const neighbor = true\n`

    const result = readStructure(repoId, 'large.ts', '.ts', code)
    const element = result.elements.find(
      (candidate) => candidate.name === 'afterOldBufferLimit' && candidate.kind === 'function'
    )

    expect(element).toMatchObject({ kind: 'function', retrievable: true })
    expect(element!.id).toBeTruthy()
    expect(element!.location.start.byte).toBe(Buffer.byteLength(prefix, 'utf8'))
    expect(element!.location.start.byte).toBeGreaterThan(32 * 1024)
    expect(element!.location.end.byte).toBe(Buffer.byteLength(prefix + source, 'utf8'))
  })

  it('distingue falha técnica de parsing de uma extração válida sem elementos', () => {
    const parser = getParser('typescript')!
    const parse = vi.spyOn(parser, 'parse').mockImplementationOnce(() => {
      throw new Error('capacity failure')
    })

    expect(() => readStructure(repoId, 'failed.ts', '.ts', 'export const value = 1')).toThrowError(
      StructureExtractionError
    )
    parse.mockRestore()
  })
})


describe('Text document addressability', () => {
  it('indexes documents, persists targets and reads exact bytes without source reads during inspect', async () => {
    const fs = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { createRepositoryModel } = await import('./repository-model')
    const { ContextEngine } = await import('./context/context-engine')
    const { serializeInspectFiles } = await import('./context/context-navigation-serializer')
    const root = await fs.mkdtemp(join(tmpdir(), 'codemap-documents-'))
    let model = createRepositoryModel(root)
    const documents = new Map([
      ['notes.unknown', '\uFEFF  início 😀\r\n\t中 e\u0301\nfinal  '],
      ['empty.txt', ''],
      ['LICENSE', 'permission\r\n'], ['boundary.txt', 'a'.repeat(4095) + '😀\n']
    ])
    try {
      for (const [path, source] of documents) await fs.writeFile(join(root, path), source)
      await fs.writeFile(join(root, 'image.png'), 'looks textual')
      await fs.writeFile(join(root, 'binary.unknown'), Buffer.from([65, 0, 66]))
      await fs.writeFile(join(root, 'invalid.unknown'), Buffer.from([0xff, 0xfe]))
      await fs.writeFile(join(root, 'late.unknown'), Buffer.concat([Buffer.alloc(5000, 65), Buffer.from([0])]))
      await fs.writeFile(join(root, 'main.ts'), 'export function run() { return 1 }')
      await fs.writeFile(join(root, 'style.css'), 'body { color: red; }')
      await model.indexRepository()
      const originalElements = model.getElementsByRepository()
      expect(model.getFiles().map(file => file.relativePath)).not.toEqual(expect.arrayContaining(['binary.unknown']))
      expect(model.getFiles().some(file => ['image.png', 'invalid.unknown', 'late.unknown'].includes(file.relativePath))).toBe(false)
      for (const path of ['main.ts', 'style.css']) {
        const file = model.getFiles().find(file => file.relativePath === path)!
        expect(model.getElementsByFile(file.id).length).toBeGreaterThan(0)
        expect(model.getElementsByFile(file.id).some(element => element.kind === 'document')).toBe(false)
      }
      model.close()
      model = createRepositoryModel(root)
      expect(model.getElementsByRepository().sort((a, b) => a.id.localeCompare(b.id))).toEqual(originalElements.slice().sort((a, b) => a.id.localeCompare(b.id)))
      const { createRepositoryDatabase } = await import('./repository-database')
      const database = createRepositoryDatabase(model.getRepoPath())
      const legacyFile = model.getFiles().find(file => file.relativePath === 'empty.txt')!
      database.deleteElementsByFile(legacyFile.id)
      await model.backfillTextDocuments()
      expect(model.getElementsByRepository().sort((a, b) => a.id.localeCompare(b.id))).toEqual(originalElements.slice().sort((a, b) => a.id.localeCompare(b.id)))
      const port = {
        awaitSnapshot: async () => {}, getFiles: () => model.getFiles(),
        getElements: () => model.getElementsByRepository(), getRelationships: () => model.getRelationships(),
        getElementExactSources: vi.fn(async (_path: string, ids: string[]) => model.getElementExactSources(ids))
      }
      const engine = new ContextEngine(port)
      expect((await engine.discoverRepository(root)).directories[0].children).toEqual(expect.arrayContaining([...documents.keys()]))
      const unavailable = join(root, 'code_awareness', 'unavailable')
      await fs.mkdir(unavailable)
      for (const path of documents.keys()) await fs.rename(join(root, path), join(unavailable, path))
      const targets: string[] = []
      for (const [path, source] of documents) {
        const inspected = await engine.inspectFiles(root, [path])
        expect(inspected.files[0].elements).toHaveLength(1)
        const document = inspected.files[0].elements[0]
        expect(document).toEqual({ kind: 'document', name: path, target: expect.stringMatching(/^t:/) })
        expect(serializeInspectFiles(inspected)).toBe('[' + path + ']\n\ndocument ' + path + ' ' + document.target)
        targets.push(document.target!)
        const file = model.getFiles().find(file => file.relativePath === path)!
        const element = model.getElementsByFile(file.id)[0]
        expect(element.location.start).toEqual({ byte: 0, line: 1, column: 0 })
        expect(element.location.end.byte).toBe(Buffer.byteLength(source))
      }
      expect(port.getElementExactSources).not.toHaveBeenCalled()
      for (const path of documents.keys()) await fs.rename(join(unavailable, path), join(root, path))
      const read = await engine.readCode(root, targets)
      expect(read.map(result => result.relativePath)).toEqual([...documents.keys()])
      for (const result of read) expect(Buffer.from(result.source)).toEqual(Buffer.from(documents.get(result.relativePath)!))
      await model.indexRepository()
      expect(model.getElementsByRepository().sort((a, b) => a.id.localeCompare(b.id))).toEqual(originalElements.slice().sort((a, b) => a.id.localeCompare(b.id)))
      await fs.writeFile(join(root, 'notes.unknown'), 'updated\r\n😀')
      await model.updateFileContent('notes.unknown')
      expect((await engine.inspectFiles(root, ['notes.unknown'])).files[0].elements[0].target).toBe(targets[0])
      expect((await engine.readCode(root, [targets[0]]))[0].source).toBe('updated\r\n😀')
      await fs.writeFile(join(root, 'notes.unknown'), Buffer.from([0]))
      await model.updateFileContent('notes.unknown')
      expect(model.getFiles().some(file => file.relativePath === 'notes.unknown')).toBe(false)
    } finally {
      vi.restoreAllMocks()
      model.close()
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 30_000)
})

describe('JSON document addressability', () => {
  it('persists and updates top-level sections through the real CodeScope flow', async () => {
    const fs = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { createRepositoryModel } = await import('./repository-model')
    const { ContextEngine } = await import('./context/context-engine')
    const { serializeInspectFiles } = await import('./context/context-navigation-serializer')
    const root = await fs.mkdtemp(join(tmpdir(), 'codemap-json-'))
    const packagePath = join(root, 'package.json')
    const initial = '\uFEFF{\r\n  "name": "code-awareness",\r\n  "scripts": {\r\n    "test": "vitest"\r\n  },\r\n  "dependencies": {\r\n    "react": "latest"\r\n  },\r\n  "devDependencies": {},\r\n  "files": []\r\n}\r\n'
    let model = createRepositoryModel(root)
    try {
      await fs.writeFile(packagePath, initial)
      await model.indexRepository()

      const createEngine = (): InstanceType<typeof ContextEngine> => new ContextEngine({
        awaitSnapshot: async () => {},
        getFiles: () => model.getFiles(),
        getElements: () => model.getElementsByRepository(),
        getRelationships: () => model.getRelationships(),
        getElementExactSources: (_repoPath: string, ids: string[]) => model.getElementExactSources(ids)
      })
      let engine = createEngine()
      expect((await engine.discoverRepository(root)).directories[0].children).toContain('package.json')
      const inspected = await engine.inspectFiles(root, ['package.json'])
      const document = inspected.files[0].elements[0]
      expect(document).toMatchObject({ kind: 'document', name: 'package.json', target: expect.stringMatching(/^t:/) })
      expect(document.children?.map((section) => section.name)).toEqual(['name', 'scripts', 'dependencies', 'devDependencies', 'files'])
      expect(await engine.inspectFiles(root, ['package.json'], { signatures: true })).toEqual(inspected)
      expect(serializeInspectFiles(inspected)).toBe([
        '[package.json]',
        '',
        `document package.json ${document.target}`,
        ...document.children!.map((section) => `  section ${section.name} ${section.target}`)
      ].join('\n'))

      const scriptsTarget = document.children!.find((section) => section.name === 'scripts')!.target!
      const dependenciesTarget = document.children!.find((section) => section.name === 'dependencies')!.target!
      expect((await engine.readCode(root, [scriptsTarget]))[0].source).toBe('"scripts": {\r\n    "test": "vitest"\r\n  }')
      const originalIds = new Map(model.getElementsByRepository().map((element) => [element.name, element.id]))

      const packageFile = model.getFiles().find((file) => file.relativePath === 'package.json')!
      const indexedDocument = model.getElementsByFile(packageFile.id).find((element) => element.kind === 'document')!
      const database = model['db']
      database.deleteElementsByFile(packageFile.id)
      database.saveElements([indexedDocument])
      await model.backfillTextDocuments()
      expect(model.getElementsByFile(packageFile.id).map((element) => element.kind)).toEqual([
        'document', 'section', 'section', 'section', 'section', 'section'
      ])

      model.close()
      model = createRepositoryModel(root)
      engine = createEngine()
      expect(new Map(model.getElementsByRepository().map((element) => [element.name, element.id]))).toEqual(originalIds)

      const updated = '{\n  "name": "renamed",\n  "scripts": {"test": "vitest --run"},\n  "files": []\n}\n'
      await fs.writeFile(packagePath, updated)
      await model.updateFileContent('package.json')
      const updatedInspect = await engine.inspectFiles(root, ['package.json'])
      const updatedDocument = updatedInspect.files[0].elements[0]
      expect(updatedDocument.children?.map((section) => section.name)).toEqual(['name', 'scripts', 'files'])
      expect(updatedDocument.children?.find((section) => section.name === 'scripts')?.target).toBe(scriptsTarget)
      await expect(engine.readCode(root, [dependenciesTarget])).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' })
      expect((await engine.readCode(root, [scriptsTarget]))[0].source).toBe('"scripts": {"test": "vitest --run"}')

      await fs.writeFile(packagePath, '{"name": invalid}')
      await model.updateFileContent('package.json')
      const invalidInspect = await engine.inspectFiles(root, ['package.json'])
      expect(invalidInspect.files[0].elements).toEqual([
        { kind: 'document', name: 'package.json', target: document.target }
      ])
      expect((await engine.readCode(root, [document.target!]))[0].source).toBe('{"name": invalid}')
    } finally {
      model.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('extrai, persiste, atualiza e restaura canonical indexed signatures', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'codemap-canon-sig-'))
    const { createRepositoryModel } = await import('./repository-model')
    const { ContextEngine } = await import('./context/context-engine')
    const { serializeInspectFiles } = await import('./context/context-navigation-serializer')

    let model = createRepositoryModel(root)
    const createEngine = () => {
      const port = {
        awaitSnapshot: async () => {},
        getFiles: () => model.getFiles(),
        getElements: () => model.getElementsByRepository(),
        getRelationships: () => model.getRelationships(),
        getElementExactSources: vi.fn(async (_path: string, ids: string[]) => model.getElementExactSources(ids))
      }
      return { engine: new ContextEngine(port), port }
    }

    try {
      const code = [
        'export class BaseWorker {}',
        'export class HeavyWorker extends BaseWorker {',
        '  constructor(name: string, priority: number) {}',
        '  process(task: string, count: number): boolean {',
        '    const list = [1, 2].map((x) => x * 2);',
        '    return true;',
        '  }',
        '}',
        'export function standalone(a: string, b: number): void {}',
        'export function overload(x: string): string;',
        'export function overload(x: number): number;',
        'export function overload(x: string | number): string | number { return x; }'
      ].join('\n')

      await fs.writeFile(join(root, 'worker.ts'), code, 'utf-8')
      await model.indexRepository()

      let { engine, port } = createEngine()
      const inspected = await engine.inspectFiles(root, ['worker.ts'], { signatures: true })
      const workerFile = inspected.files[0]

      const heavyWorker = workerFile.elements.find((e) => e.name === 'HeavyWorker')!
      expect(heavyWorker.signature).toBe('HeavyWorker extends BaseWorker')

      const ctor = heavyWorker.children?.find((e) => e.name === 'constructor')!
      expect(ctor.signature).toBe('constructor(name, priority)')

      const proc = heavyWorker.children?.find((e) => e.name === 'process')!
      expect(proc.signature).toBe('process(task, count): boolean')

      const standaloneFn = workerFile.elements.find((e) => e.name === 'standalone')!
      expect(standaloneFn.signature).toBe('standalone(a, b): void')

      // Zero source reads
      expect(port.getElementExactSources).not.toHaveBeenCalled()

      // SQLite Persistence & Reopen
      const originalSigs = new Map(
        model.getElementsByRepository().map((e) => [e.name, e.declarationSignature])
      )
      model.close()
      model = createRepositoryModel(root)
      const reopenedSigs = new Map(
        model.getElementsByRepository().map((e) => [e.name, e.declarationSignature])
      )
      expect(reopenedSigs).toEqual(originalSigs)

      // Backfill verification
      const file = model.getFiles().find((f) => f.relativePath === 'worker.ts')!
      const elements = model.getElementsByFile(file.id)
      const procElement = elements.find((e) => e.name === 'process')!
      model['db'].saveElement({
        ...procElement,
        declarationSignature: null
      })
      expect(model.getElementsByFile(file.id).find((e) => e.name === 'process')?.declarationSignature).toBeNull()

      await model.backfillDeclarationSignatures()
      expect(model.getElementsByFile(file.id).find((e) => e.name === 'process')?.declarationSignature).toBe('process(task, count): boolean')

      // Update content
      const updatedCode = code.replace(
        'process(task: string, count: number): boolean {',
        'process(task: string, count: number, timeout: number): boolean {'
      )
      await fs.writeFile(join(root, 'worker.ts'), updatedCode, 'utf-8')
      await model.updateFileContent('worker.ts')

      const updatedInspect = (await engine.inspectFiles(root, ['worker.ts'], { signatures: true })).files[0]
      const updatedProc = updatedInspect.elements.find((e) => e.name === 'HeavyWorker')?.children?.find((e) => e.name === 'process')
      expect(updatedProc?.signature).toBe('process(task, count, timeout): boolean')
    } finally {
      model.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('Markdown document addressability', () => {
  it('persists and updates heading sections through the real CodeScope flow', async () => {
    const fs = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { createRepositoryModel } = await import('./repository-model')
    const { ContextEngine } = await import('./context/context-engine')
    const { serializeInspectFiles } = await import('./context/context-navigation-serializer')
    const root = await fs.mkdtemp(join(tmpdir(), 'codemap-markdown-'))
    const documentPath = join(root, 'AGENTS.md')
    const initial = [
      '\uFEFF---',
      'title: Agent Guide',
      '# ignored in frontmatter',
      '---',
      'Preamble.',
      '',
      '# Architecture',
      'Architecture prose.',
      '',
      '## Testing',
      'Testing prose.',
      '',
      '```md',
      '# Not a heading',
      '```',
      '',
      '### Regression Policy',
      'Keep exact ranges.',
      '',
      '# Deployment',
      'Deploy safely.',
      ''
    ].join('\r\n')
    let model = createRepositoryModel(root)
    try {
      await fs.writeFile(documentPath, initial)
      await model.indexRepository()

      const createEngine = (): InstanceType<typeof ContextEngine> => new ContextEngine({
        awaitSnapshot: async () => {},
        getFiles: () => model.getFiles(),
        getElements: () => model.getElementsByRepository(),
        getRelationships: () => model.getRelationships(),
        getElementExactSources: (_repoPath: string, ids: string[]) => model.getElementExactSources(ids)
      })
      let engine = createEngine()
      expect((await engine.discoverRepository(root)).directories[0].children).toContain('AGENTS.md')
      const inspected = await engine.inspectFiles(root, ['AGENTS.md'])
      const document = inspected.files[0].elements[0]
      const architecture = document.children![0]
      const deployment = document.children![1]
      const testing = architecture.children![0]
      const regression = testing.children![0]

      expect(document).toMatchObject({ kind: 'document', name: 'AGENTS.md', target: expect.stringMatching(/^t:/) })
      expect([architecture.name, deployment.name]).toEqual(['Architecture', 'Deployment'])
      expect(testing.name).toBe('Testing')
      expect(regression.name).toBe('Regression Policy')
      expect(await engine.inspectFiles(root, ['AGENTS.md'], { signatures: true })).toEqual(inspected)
      expect(serializeInspectFiles(inspected)).toBe([
        '[AGENTS.md]',
        '',
        `document AGENTS.md ${document.target}`,
        `  section Architecture ${architecture.target}`,
        `    section Testing ${testing.target}`,
        `      section Regression Policy ${regression.target}`,
        `  section Deployment ${deployment.target}`
      ].join('\n'))

      expect((await engine.readCode(root, [document.target!]))[0].source).toBe(initial)
      const expectedTesting = initial.slice(initial.indexOf('## Testing'), initial.indexOf('# Deployment'))
      expect((await engine.readCode(root, [testing.target!]))[0].source).toBe(expectedTesting)
      const originalIds = new Map(model.getElementsByRepository().map((element) => [element.name, element.id]))

      const file = model.getFiles().find((candidate) => candidate.relativePath === 'AGENTS.md')!
      const indexedDocument = model.getElementsByFile(file.id).find((element) => element.kind === 'document')!
      const database = model['db']
      database.deleteElementsByFile(file.id)
      database.saveElements([indexedDocument])
      await model.backfillTextDocuments()
      expect(model.getElementsByFile(file.id).filter((element) => element.kind === 'section')).toHaveLength(4)

      model.close()
      model = createRepositoryModel(root)
      engine = createEngine()
      expect(new Map(model.getElementsByRepository().map((element) => [element.name, element.id]))).toEqual(originalIds)

      const updated = '# Architecture\nUpdated.\n\n# Deployment Guide\nChanged heading.\n'
      await fs.writeFile(documentPath, updated)
      await model.updateFileContent('AGENTS.md')
      const updatedDocument = (await engine.inspectFiles(root, ['AGENTS.md'])).files[0].elements[0]
      expect(updatedDocument.children?.map((section) => section.name)).toEqual(['Architecture', 'Deployment Guide'])
      expect(updatedDocument.children?.[0].target).toBe(architecture.target)
      await expect(engine.readCode(root, [testing.target!])).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' })
      await expect(engine.readCode(root, [deployment.target!])).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' })
      expect((await engine.readCode(root, [document.target!]))[0].source).toBe(updated)
    } finally {
      model.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
