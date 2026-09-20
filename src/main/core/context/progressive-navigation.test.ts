import { describe, expect, it, vi } from 'vitest'
import type { CodeMapElement, CodeMapFile, CodeMapRelationship } from '../../../shared/types'
import { ContextEngine } from './context-engine'
import { createFullTargetId, parseCodeTargetId } from './code-target'
import { serializeDiscovery, serializeInspectFiles, serializeReferences, serializeRelationships, serializeSymbolDependencies, serializeSymbolHierarchy } from './context-navigation-serializer'
import type { PersistedSymbolReference } from '../symbol-reference-resolver'

function element(id: number, kind: CodeMapElement['kind'], name: string, parent: number | null = null, fileId = 'a'): CodeMapElement {
  return {
    id: id.toString(16).padStart(16, '0'), repositoryId: 'repo', fileId, kind, name,
    parentElementId: parent === null ? null : parent.toString(16).padStart(16, '0'),
    location: { start: { byte: id, line: 1, column: 0 }, end: { byte: id + 1, line: 1, column: 1 } },
    sizeLines: 1, sizeBytes: 1, visibility: null, modifiers: [], returnType: null,
    baseClass: null, hasDocumentation: false, parameterCount: 0, granularity: 'structural',
    retrievable: kind !== 'import' && kind !== 'export'
  }
}

function setup() {
  const files = [
    ['a', 'src/a.ts'], ['b', 'src/deep/b.ts'], ['c', 'tests/c.ts'], ['d', 'src/deep/d.ts'], ['p', 'package.json']
  ].map(([id, relativePath]) => ({ id, relativePath } as CodeMapFile))
  const elements = [element(1, 'import', 'b'), element(2, 'class', 'A'), element(3, 'method', 'run', 2),
    element(4, 'parameter', 'input', 3), element(5, 'constant', 'local', 3), element(6, 'property', 'state', 2),
    element(7, 'export', 'public'), element(8, 'function', 'entry', 7), element(9, 'variable', 'mutable'),
    element(10, 'constant', 'CONFIG'), element(11, 'cssRule', 'body'), element(12, 'function', 'nested', 8),
    element(13, 'interface', 'Contract'), element(14, 'method', 'execute', 13), element(15, 'enum', 'State'), element(16, 'typeAlias', 'Id'),
    element(17, 'class', 'BaseService', null, 'b'), element(18, 'class', 'Service', null, 'a'),
    element(19, 'interface', 'ServicePort', null, 'b'), element(20, 'class', 'CachedService', null, 'c'),
    element(21, 'class', 'EmptyService', null, 'd')]
  elements[2].returnType = 'string'
  elements[2].parameterCount = 1
  const edge = (sourceId: string, targetId: string, sourceKind: 'element' | 'file' = 'file', type: CodeMapRelationship['type'] = 'imports'): CodeMapRelationship => ({
    id: sourceId + targetId, repositoryId: 'repo', sourceId, targetId, sourceKind, targetKind: 'file', type
  })
  const hierarchy = (id: string, sourceId: string, targetId: string, type: 'extends' | 'implements'): CodeMapRelationship => ({
    id, repositoryId: 'repo', sourceId, targetId, sourceKind: 'element', targetKind: 'element', type
  })
  const relationships = [
    edge(elements[0].id, 'b', 'element'), edge(elements[0].id, 'b', 'element'), edge('c', 'a'), edge('b', 'd'),
    edge('a', 'a'), edge('a', 'missing'), edge('missing', 'a'), edge('a', 'd', 'file', 'extends'),
    hierarchy('h1', elements[17].id, elements[16].id, 'extends'),
    hierarchy('h2', elements[17].id, elements[18].id, 'implements'),
    hierarchy('h3', elements[19].id, elements[18].id, 'implements'),
    hierarchy('h4', elements[17].id, elements[18].id, 'implements')
  ]
  const reference = (id: string, sourceFileId: string, sourceElementId: string | null, kind: PersistedSymbolReference['kind'], line: number, byte: number, targetElementId = elements[1].id): PersistedSymbolReference => ({
    id, repositoryId: 'repo', sourceFileId, sourceElementId, targetElementId, kind,
    location: { start: { line, column: 0, byte }, end: { line, column: 1, byte: byte + 1 } }
  })
  const references = [
    reference('r2', 'c', null, 'reference', 7, 70),
    reference('r1', 'a', elements[7].id, 'instantiation', 2, 20),
    reference('r3', 'a', elements[7].id, 'type', 2, 21),
    reference('r4', 'a', elements[7].id, 'call', 3, 30, elements[11].id),
    reference('r5', 'a', elements[7].id, 'call', 4, 40, elements[11].id),
    reference('r6', 'a', elements[7].id, 'call', 5, 50, elements[11].id),
    reference('r7', 'a', elements[7].id, 'reference', 6, 60, elements[9].id),
    reference('r8', 'a', elements[17].id, 'type', 8, 80, elements[16].id)
  ]
  const port = {
    awaitSnapshot: vi.fn(async () => {}), getFiles: vi.fn(() => files), getElements: vi.fn(() => elements),
    getRelationships: vi.fn(() => relationships),
    getHierarchyRelationshipsBySourceElement: vi.fn((_repoPath: string, elementId: string) => relationships.filter((relationship) => relationship.sourceId === elementId && (relationship.type === 'extends' || relationship.type === 'implements'))),
    getHierarchyRelationshipsByTargetElement: vi.fn((_repoPath: string, elementId: string) => relationships.filter((relationship) => relationship.targetId === elementId && (relationship.type === 'extends' || relationship.type === 'implements'))),
    getSymbolReferencesByTargetElement: vi.fn((_repoPath: string, targetElementId: string) => references.filter((reference) => reference.targetElementId === targetElementId)),
    getSymbolReferencesBySourceElement: vi.fn((_repoPath: string, sourceElementId: string) => references.filter((reference) => reference.sourceElementId === sourceElementId)),
    getElementExactSources: vi.fn(async () => new Map())
  }
  return { engine: new ContextEngine(port), port, files, elements }
}

describe('Progressive navigation', () => {
  it('discovers only immediate children, preserves batch order and ignores unexplored depth', async () => {
    const { engine, port, files } = setup()
    expect(serializeDiscovery(await engine.discoverRepository('repo'))).toBe('[.]\nsrc/\ntests/\npackage.json')
    expect(serializeDiscovery(await engine.discoverRepository('repo', ['src', 'src/deep']))).toBe('[src]\ndeep/\na.ts\n\n[src/deep]\nb.ts\nd.ts')
    files.push({ id: 'extra', relativePath: 'src/deep/hidden/extra.ts' } as CodeMapFile)
    expect(serializeDiscovery(await engine.discoverRepository('repo'))).toBe('[.]\nsrc/\ntests/\npackage.json')
    expect(port.getElements).not.toHaveBeenCalled()
    expect(port.getRelationships).not.toHaveBeenCalled()
    expect(port.getElementExactSources).not.toHaveBeenCalled()
    await expect(engine.discoverRepository('repo', ['absent'])).rejects.toMatchObject({ code: 'UNKNOWN_DIRECTORY' })
    await expect(engine.discoverRepository('repo', ['src', './src/'])).rejects.toMatchObject({ code: 'DUPLICATE_PATH' })
    port.getFiles.mockReturnValue([])
    expect(await engine.discoverRepository('repo')).toEqual({ directories: [{ relativePath: '.', children: [] }] })
  })

  it.each(['/absolute', 'C:/absolute', 'C:relative', '../escape', 'src/../../escape', '\\server\share', 'src\\a.ts', 'src/\nfile'])('rejects unsafe path %s before accessing CodeMap', async (path) => {
    const { engine, port } = setup()
    for (const call of [() => engine.discoverRepository('repo', [path]), () => engine.inspectFiles('repo', [path]), () => engine.getRelationships('repo', [path])]) {
      await expect(call()).rejects.toMatchObject({ code: 'INVALID_PATH' })
    }
    expect(port.awaitSnapshot).not.toHaveBeenCalled()
  })

  it('projects one hop with both endpoint kinds, deduplicates and excludes self and invalid edges', async () => {
    const { engine, port } = setup()
    expect(serializeRelationships(await engine.getRelationships('repo', ['src/a.ts']))).toBe('[src/a.ts]\n\nOUT\nsrc/deep/b.ts\n\nIN\ntests/c.ts')
    expect(serializeRelationships(await engine.getRelationships('repo', ['src/a.ts'], { direction: 'out', details: true }))).toBe('[src/a.ts]\n\nOUT\nsrc/deep/b.ts imports')
    expect(serializeRelationships(await engine.getRelationships('repo', ['src/a.ts'], { direction: 'in' }))).toBe('[src/a.ts]\n\nIN\ntests/c.ts')
    const batch = await engine.getRelationships('repo', ['src/deep/b.ts', 'package.json'])
    expect(batch.files.map((file) => file.relativePath)).toEqual(['src/deep/b.ts', 'package.json'])
    expect(batch.files[0].out).toEqual([{ relativePath: 'src/deep/d.ts' }])
    expect(batch.files[1]).toEqual({ relativePath: 'package.json', in: [], out: [] })
    expect(port.getElementExactSources).not.toHaveBeenCalled()
  })

  it('keeps structural outlines hierarchical, filters implementation details and uses only indexed signatures', async () => {
    const { engine, port, elements } = setup()
    const result = await engine.inspectFiles('repo', ['src/a.ts'])
    expect(result.files[0].elements.map((entry) => [entry.kind, entry.name])).toEqual([
      ['class', 'A'], ['function', 'entry'], ['constant', 'CONFIG'], ['interface', 'Contract'], ['enum', 'State'], ['typeAlias', 'Id'], ['class', 'Service']
    ])
    expect(result.files[0].elements[0].children?.map((entry) => entry.name)).toEqual(['run'])
    expect(result.files[0].elements[3].children?.map((entry) => entry.name)).toEqual(['execute'])
    expect(serializeInspectFiles(result)).not.toMatch(/elementId|location|parameter|local|mutable|nested|state|body|signature/)
    const signatures = await engine.inspectFiles('repo', ['src/a.ts'], { signatures: true })
    expect(signatures.files[0].elements[0].children?.[0].signature).toBe('run(input): string')
    elements.reverse()
    expect(await engine.inspectFiles('repo', ['src/a.ts'])).toEqual(result)
    expect(port.getRelationships).not.toHaveBeenCalled()
    expect(port.getElementExactSources).not.toHaveBeenCalled()
  })

  it('round-trips the complete identity without state and accepts only canonical compact encodings', () => {
    for (const id of ['0000000000000000', 'ffffffffffffffff', '0123456789abcdef']) {
      const target = createFullTargetId(id)
      expect(target).toHaveLength(13)
      expect(parseCodeTargetId(target)).toEqual({ elementId: id, kind: 'full' })
      expect(parseCodeTargetId('target:' + id + ':full')).toEqual(parseCodeTargetId(target))
    }
    for (const target of ['t:AAAAAAAAAAB', 't:AAAAAAAAAAA=', 't:AAA', 'target::full', 'target:x:signature']) expect(parseCodeTargetId(target)).toBeNull()
  })

  it('projects compact deterministic references, preserves target order and keeps empty targets explicit', async () => {
    const { engine, port, elements } = setup()
    const emptyTarget = createFullTargetId(elements[12].id)
    const usedTarget = createFullTargetId(elements[1].id)
    const result = await engine.getReferences('repo', [emptyTarget, usedTarget])

    expect(result.targets.map((entry) => entry.target)).toEqual([emptyTarget, usedTarget])
    expect(result.targets[0].references).toEqual([])
    expect(result.targets[1].references).toEqual([
      { relativePath: 'src/a.ts', kind: 'instantiation', line: 2, sourceTarget: createFullTargetId(elements[7].id) },
      { relativePath: 'src/a.ts', kind: 'type', line: 2, sourceTarget: createFullTargetId(elements[7].id) },
      { relativePath: 'tests/c.ts', kind: 'reference', line: 7 }
    ])
    expect(serializeReferences(result)).toBe([
      `[${emptyTarget}]`, '', 'NONE', '',
      `[${usedTarget}]`, '',
      `src/a.ts:2 instantiation ${createFullTargetId(elements[7].id)}`,
      `src/a.ts:2 type ${createFullTargetId(elements[7].id)}`,
      'tests/c.ts:7 reference'
    ].join('\n'))
    expect(JSON.stringify(result)).not.toMatch(/sourceFileId|sourceElementId|targetElementId|repositoryId|startByte|column|"source":/)
    expect(port.getElementExactSources).not.toHaveBeenCalled()
    expect(port.getRelationships).not.toHaveBeenCalled()
  })

  it('applies readCode target validation and compatibility policy to references', async () => {
    const { engine, elements } = setup()
    const target = createFullTargetId(elements[1].id)
    expect(await engine.getReferences('repo', ['target:' + elements[1].id + ':full'])).toEqual(await engine.getReferences('repo', [target]))
    await expect(engine.getReferences('repo', [])).rejects.toMatchObject({ code: 'EMPTY_TARGETS' })
    await expect(engine.getReferences('repo', [target, 'target:' + elements[1].id + ':full'])).rejects.toMatchObject({ code: 'DUPLICATE_TARGET' })
    await expect(engine.getReferences('repo', ['invalid'])).rejects.toMatchObject({ code: 'INVALID_TARGET' })
    await expect(engine.getReferences('repo', [createFullTargetId(elements[0].id)])).rejects.toMatchObject({ code: 'ELEMENT_NOT_RETRIEVABLE' })
  })

  it('projects direct outbound dependencies, deduplicates occurrences and composes bidirectionally', async () => {
    const { engine, port, elements } = setup()
    const sourceTarget = createFullTargetId(elements[7].id)
    const emptyTarget = createFullTargetId(elements[12].id)
    const targetA = createFullTargetId(elements[1].id)
    const targetNested = createFullTargetId(elements[11].id)
    const targetConfig = createFullTargetId(elements[9].id)
    const result = await engine.getSymbolDependencies('repo', [emptyTarget, sourceTarget])

    expect(result).toEqual({ sources: [
      { source: emptyTarget, dependencies: [] },
      { source: sourceTarget, dependencies: [
        { kind: 'call', target: targetNested, relativePath: 'src/a.ts' },
        { kind: 'instantiation', target: targetA, relativePath: 'src/a.ts' },
        { kind: 'reference', target: targetConfig, relativePath: 'src/a.ts' },
        { kind: 'type', target: targetA, relativePath: 'src/a.ts' }
      ] }
    ] })
    expect(serializeSymbolDependencies(result)).toBe([
      `[${emptyTarget}]`, '', 'NONE', '',
      `[${sourceTarget}]`, '',
      `call ${targetNested} src/a.ts`,
      `instantiation ${targetA} src/a.ts`,
      `reference ${targetConfig} src/a.ts`,
      `type ${targetA} src/a.ts`
    ].join('\n'))
    expect(result.sources[1].dependencies.filter((dependency) => dependency.target === targetNested)).toHaveLength(1)
    expect(result.sources[1].dependencies.filter((dependency) => dependency.target === targetA)).toHaveLength(2)
    expect(JSON.stringify(result)).not.toMatch(/sourceElementId|targetElementId|repositoryId|startByte|line|column|"source":\s*"(?:function|class)/)
    expect(port.getElementExactSources).not.toHaveBeenCalled()
    expect(port.getRelationships).not.toHaveBeenCalled()

    const inbound = await engine.getReferences('repo', [targetA])
    expect(inbound.targets[0].references).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceTarget, kind: 'instantiation' }),
      expect.objectContaining({ sourceTarget, kind: 'type' })
    ]))

    port.getElementExactSources.mockResolvedValue(new Map([[elements[1].id, {
      content: 'A', relativePath: 'src/a.ts', startByte: elements[1].location.start.byte, endByte: elements[1].location.end.byte
    }]]))
    expect(await engine.readCode('repo', [targetA])).toEqual([{ targetId: targetA, relativePath: 'src/a.ts', source: 'A' }])

    await expect(engine.getSymbolDependencies('repo', [])).rejects.toMatchObject({ code: 'EMPTY_TARGETS' })
    await expect(engine.getSymbolDependencies('repo', [sourceTarget, 'target:' + elements[7].id + ':full'])).rejects.toMatchObject({ code: 'DUPLICATE_TARGET' })
    await expect(engine.getSymbolDependencies('repo', ['invalid'])).rejects.toMatchObject({ code: 'INVALID_TARGET' })
  })

  it('projects direct symbol hierarchy in both directions with batch, deduplication and graph composition', async () => {
    const { engine, port, elements } = setup()
    const base = createFullTargetId(elements[16].id)
    const service = createFullTargetId(elements[17].id)
    const contract = createFullTargetId(elements[18].id)
    const cached = createFullTargetId(elements[19].id)
    const empty = createFullTargetId(elements[20].id)

    const up = await engine.getSymbolHierarchy('repo', [service], { direction: 'up' })
    expect(up).toEqual({ targets: [{ target: service, up: [
      { kind: 'extends', target: base, relativePath: 'src/deep/b.ts' },
      { kind: 'implements', target: contract, relativePath: 'src/deep/b.ts' }
    ] }] })
    expect(serializeSymbolHierarchy(up)).toBe(`[${service}]\n\nUP\nextends ${base} src/deep/b.ts\nimplements ${contract} src/deep/b.ts`)

    const down = await engine.getSymbolHierarchy('repo', [contract], { direction: 'down' })
    expect(down.targets[0].down).toEqual([
      { kind: 'implements', target: service, relativePath: 'src/a.ts' },
      { kind: 'implements', target: cached, relativePath: 'tests/c.ts' }
    ])

    const batch = await engine.getSymbolHierarchy('repo', [empty, service])
    expect(batch.targets.map((entry) => entry.target)).toEqual([empty, service])
    expect(batch.targets[0]).toEqual({ target: empty, up: [], down: [] })
    expect(serializeSymbolHierarchy(batch)).toContain(`[${empty}]\n\nNONE`)
    expect(batch.targets[1].up).toHaveLength(2)
    expect(batch.targets[1].down).toEqual([])
    expect(port.getElementExactSources).not.toHaveBeenCalled()
    expect(port.getRelationships).not.toHaveBeenCalled()

    const dependencies = await engine.getSymbolDependencies('repo', [service])
    expect(dependencies.sources[0].dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: base, kind: 'type' })
    ]))
    const references = await engine.getReferences('repo', [base])
    expect(references.targets[0].references).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceTarget: service, kind: 'type' })
    ]))
    expect((await engine.getSymbolHierarchy('repo', [base], { direction: 'up' })).targets[0].up).toEqual([])

    await expect(engine.getSymbolHierarchy('repo', [])).rejects.toMatchObject({ code: 'EMPTY_TARGETS' })
    await expect(engine.getSymbolHierarchy('repo', [service, 'target:' + elements[17].id + ':full'])).rejects.toMatchObject({ code: 'DUPLICATE_TARGET' })
    await expect(engine.getSymbolHierarchy('repo', ['invalid'])).rejects.toMatchObject({ code: 'INVALID_TARGET' })
    await expect(engine.getSymbolHierarchy('repo', [service], { direction: 'sideways' as 'up' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('fails closed for absent, mismatched and non-retrievable source', async () => {
    const { engine, port, elements } = setup()
    const target = createFullTargetId(elements[1].id)
    await expect(engine.readCode('repo', [target, 'target:' + elements[1].id + ':full'])).rejects.toMatchObject({ code: 'DUPLICATE_TARGET' })
    await expect(engine.readCode('repo', [target])).rejects.toMatchObject({ code: 'EXACT_SOURCE_UNAVAILABLE' })
    port.getElementExactSources.mockResolvedValue(new Map([[elements[1].id, { content: 'x', relativePath: 'wrong.ts', startByte: 2, endByte: 3 }]]))
    await expect(engine.readCode('repo', [target])).rejects.toMatchObject({ code: 'EXACT_SOURCE_UNAVAILABLE' })
    await expect(engine.readCode('repo', [createFullTargetId(elements[0].id)])).rejects.toMatchObject({ code: 'ELEMENT_NOT_RETRIEVABLE' })
  })

  it('excludes nested callback parameters from function and method signatures based on parameterCount', async () => {
    const files = [{ id: 'f1', relativePath: 'src/callbacks.ts' } as CodeMapFile]
    const func = element(1, 'function', 'externalFunc', null, 'f1')
    func.parameterCount = 2
    func.returnType = 'void'
    const paramA = element(2, 'parameter', 'a', 1, 'f1')
    const paramB = element(3, 'parameter', 'b', 1, 'f1')
    const callbackParam = element(4, 'parameter', 'entry', 1, 'f1')

    const cls = element(5, 'class', 'Worker', null, 'f1')
    cls.baseClass = 'BaseWorker'
    const method = element(6, 'method', 'externalMethod', 5, 'f1')
    method.parameterCount = 1
    method.returnType = 'boolean'
    const methodParam = element(7, 'parameter', 'param1', 6, 'f1')
    const methodCallbackParam = element(8, 'parameter', 'item', 6, 'f1')

    const elements = [func, paramA, paramB, callbackParam, cls, method, methodParam, methodCallbackParam]
    const port = {
      awaitSnapshot: vi.fn(async () => {}),
      getFiles: vi.fn(() => files),
      getElements: vi.fn(() => elements),
      getRelationships: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    }
    const engine = new ContextEngine(port)

    const result = await engine.inspectFiles('repo', ['src/callbacks.ts'], { signatures: true })
    const file = result.files[0]

    const funcOutline = file.elements.find((e) => e.name === 'externalFunc')
    expect(funcOutline?.signature).toBe('externalFunc(a, b): void')
    expect(funcOutline?.signature).not.toContain('entry')

    const classOutline = file.elements.find((e) => e.name === 'Worker')
    expect(classOutline?.signature).toBe('Worker extends BaseWorker')
    const methodOutline = classOutline?.children?.find((e) => e.name === 'externalMethod')
    expect(methodOutline?.signature).toBe('externalMethod(param1): boolean')
    expect(methodOutline?.signature).not.toContain('item')
  })

  it('uses canonical declarationSignature directly as single source of truth, ignoring noisy children', async () => {
    const files = [{ id: 'f1', relativePath: 'src/canonical.ts' } as CodeMapFile]
    const func = element(1, 'function', 'doWork', null, 'f1')
    func.declarationSignature = 'doWork(target: string): void'
    const noisyParam = element(2, 'parameter', 'CORRUPTED_PARAM', 1, 'f1')

    const cls = element(3, 'class', 'AppService', null, 'f1')
    cls.declarationSignature = 'AppService extends BaseService'
    const method = element(4, 'method', 'handle', 3, 'f1')
    method.declarationSignature = 'handle(req, res): Promise<void>'
    const methodNoise = element(5, 'parameter', 'NOISY_PARAM', 4, 'f1')

    const elements = [func, noisyParam, cls, method, methodNoise]
    const port = {
      awaitSnapshot: vi.fn(async () => {}),
      getFiles: vi.fn(() => files),
      getElements: vi.fn(() => elements),
      getRelationships: vi.fn(() => []),
      getSymbolReferencesByTargetElement: vi.fn(() => []),
      getSymbolReferencesBySourceElement: vi.fn(() => []),
      getElementExactSources: vi.fn(async () => new Map())
    }
    const engine = new ContextEngine(port)

    const result = await engine.inspectFiles('repo', ['src/canonical.ts'], { signatures: true })
    const file = result.files[0]

    const funcOutline = file.elements.find((e) => e.name === 'doWork')
    expect(funcOutline?.signature).toBe('doWork(target: string): void')

    const classOutline = file.elements.find((e) => e.name === 'AppService')
    expect(classOutline?.signature).toBe('AppService extends BaseService')

    const methodOutline = classOutline?.children?.find((e) => e.name === 'handle')
    expect(methodOutline?.signature).toBe('handle(req, res): Promise<void>')
  })
})
