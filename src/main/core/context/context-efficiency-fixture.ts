import type { CodeMapElement, CodeMapFile, CodeMapRelationship } from '../../../shared/types'
import type { ExactElementSource } from '../repository-model'
import { ContextEngine } from './context-engine'
import type { CodeMapNavigationPort } from './context-navigation-port'
import type { PersistedSymbolReference } from '../symbol-reference-resolver'

export const FIXTURE_FILES = Object.freeze({
  'src/app.ts': [
    "import { DataService } from './service'",
    '',
    'export function startApp(config: string): boolean {',
    '  const service = new DataService()',
    '  return service.execute(config)',
    '}',
    ''
  ].join('\n'),
  'src/service.ts': [
    "import type { ServiceConfig, ExecutionResult } from './types'",
    '',
    'export class DataService {',
    '  execute(config: ServiceConfig): ExecutionResult {',
    '    const active = true',
    '    return { success: active, message: config }',
    '  }',
    '}',
    ''
  ].join('\n'),
  'src/types.ts': [
    'export interface ServiceConfig {',
    '  name: string',
    '}',
    '',
    'export type ExecutionResult = {',
    '  success: boolean',
    '  message: unknown',
    '}',
    ''
  ].join('\n'),
  'src/unused.ts': [
    'export function standaloneHelper(): void {',
    '  const unusedValue = 42',
    '}',
    ''
  ].join('\n')
})

function computeLocation(content: string, startByte: number, endByte: number) {
  const beforeStart = content.slice(0, startByte)
  const linesBefore = beforeStart.split('\n')
  const startLine = linesBefore.length
  const startColumn = linesBefore[linesBefore.length - 1].length

  const beforeEnd = content.slice(0, endByte)
  const linesEnd = beforeEnd.split('\n')
  const endLine = linesEnd.length
  const endColumn = linesEnd[linesEnd.length - 1].length

  return {
    start: { byte: startByte, line: startLine, column: startColumn },
    end: { byte: endByte, line: endLine, column: endColumn }
  }
}

export interface EfficiencyFixture {
  readonly repoPath: string
  readonly files: typeof FIXTURE_FILES
  readonly port: CodeMapNavigationPort
  readonly engine: ContextEngine
  readonly getSourceReadsCount: () => number
}

export function createEfficiencyFixture(repoPath = '/fixture-repo'): EfficiencyFixture {
  const fileEntries: Array<{ id: string; relativePath: keyof typeof FIXTURE_FILES }> = [
    { id: 'f000000000000001', relativePath: 'src/app.ts' },
    { id: 'f000000000000002', relativePath: 'src/service.ts' },
    { id: 'f000000000000003', relativePath: 'src/types.ts' },
    { id: 'f000000000000004', relativePath: 'src/unused.ts' }
  ]

  const files: CodeMapFile[] = fileEntries.map(({ id, relativePath }) => ({
    id,
    repositoryId: repoPath,
    relativePath,
    language: 'typescript',
    status: 'indexed',
    lastModified: 1000,
    sizeBytes: Buffer.byteLength(FIXTURE_FILES[relativePath]),
    lineCount: FIXTURE_FILES[relativePath].split('\n').length
  }))

  const elements: CodeMapElement[] = []
  const exactSources = new Map<string, ExactElementSource>()

  let elementSeq = 0
  function nextId(): string {
    elementSeq++
    return elementSeq.toString(16).padStart(16, '0')
  }

  function addElement(
    fileId: string,
    relativePath: keyof typeof FIXTURE_FILES,
    kind: CodeMapElement['kind'],
    name: string,
    substring: string,
    parentElementId: string | null = null,
    retrievable = true,
    returnType: string | null = null,
    parameterCount = 0
  ): string {
    const content = FIXTURE_FILES[relativePath]
    const startByte = content.indexOf(substring)
    if (startByte < 0) throw new Error(`Substring "${substring}" not found in ${relativePath}`)
    const endByte = startByte + Buffer.byteLength(substring)
    const id = nextId()
    const location = computeLocation(content, startByte, endByte)

    const element: CodeMapElement = {
      id,
      repositoryId: repoPath,
      fileId,
      kind,
      name,
      parentElementId,
      location,
      sizeLines: location.end.line - location.start.line + 1,
      sizeBytes: endByte - startByte,
      visibility: 'public',
      modifiers: [],
      returnType,
      baseClass: null,
      hasDocumentation: false,
      parameterCount,
      granularity: 'structural',
      retrievable
    }

    elements.push(element)

    if (retrievable) {
      exactSources.set(id, {
        content: substring,
        relativePath,
        startByte,
        endByte
      })
    }

    return id
  }

  // src/app.ts
  const appFile = fileEntries[0]
  const appContent = FIXTURE_FILES['src/app.ts']
  const startAppSnippet = appContent.slice(
    appContent.indexOf('export function startApp'),
    appContent.indexOf('}\n') + 1
  )
  const startAppId = addElement(appFile.id, 'src/app.ts', 'function', 'startApp', startAppSnippet, null, true, 'boolean', 1)
  addElement(appFile.id, 'src/app.ts', 'parameter', 'config', 'config: string', startAppId, false)
  addElement(appFile.id, 'src/app.ts', 'variable', 'service', 'const service = new DataService()', startAppId, false)

  // src/service.ts
  const serviceFile = fileEntries[1]
  const serviceContent = FIXTURE_FILES['src/service.ts']
  const dataServiceSnippet = serviceContent.slice(
    serviceContent.indexOf('export class DataService'),
    serviceContent.lastIndexOf('}\n') + 1
  )
  const dataServiceId = addElement(serviceFile.id, 'src/service.ts', 'class', 'DataService', dataServiceSnippet, null, true)
  const executeSnippet = serviceContent.slice(
    serviceContent.indexOf('execute(config: ServiceConfig)'),
    serviceContent.indexOf('  }\n') + 3
  )
  const executeId = addElement(serviceFile.id, 'src/service.ts', 'method', 'execute', executeSnippet, dataServiceId, true, 'ExecutionResult', 1)
  addElement(serviceFile.id, 'src/service.ts', 'parameter', 'config', 'config: ServiceConfig', executeId, false)
  addElement(serviceFile.id, 'src/service.ts', 'constant', 'active', 'const active = true', executeId, false)

  // src/types.ts
  const typesFile = fileEntries[2]
  const typesContent = FIXTURE_FILES['src/types.ts']
  const serviceConfigSnippet = typesContent.slice(
    typesContent.indexOf('export interface ServiceConfig'),
    typesContent.indexOf('}\n\n') + 1
  )
  const serviceConfigId = addElement(typesFile.id, 'src/types.ts', 'interface', 'ServiceConfig', serviceConfigSnippet, null, true)
  const executionResultSnippet = typesContent.slice(
    typesContent.indexOf('export type ExecutionResult'),
    typesContent.lastIndexOf('}\n') + 1
  )
  const executionResultId = addElement(typesFile.id, 'src/types.ts', 'typeAlias', 'ExecutionResult', executionResultSnippet, null, true)

  // src/unused.ts
  const unusedFile = fileEntries[3]
  const unusedContent = FIXTURE_FILES['src/unused.ts']
  const standaloneHelperSnippet = unusedContent.slice(
    unusedContent.indexOf('export function standaloneHelper'),
    unusedContent.indexOf('}\n') + 1
  )
  const standaloneHelperId = addElement(unusedFile.id, 'src/unused.ts', 'function', 'standaloneHelper', standaloneHelperSnippet, null, true, 'void')
  addElement(unusedFile.id, 'src/unused.ts', 'constant', 'unusedValue', 'const unusedValue = 42', standaloneHelperId, false)

  // Relationships: app -> service, service -> types
  const relationships: CodeMapRelationship[] = [
    {
      id: 'rel:app->service',
      repositoryId: repoPath,
      sourceId: appFile.id,
      targetId: serviceFile.id,
      sourceKind: 'file',
      targetKind: 'file',
      type: 'imports'
    },
    {
      id: 'rel:service->types',
      repositoryId: repoPath,
      sourceId: serviceFile.id,
      targetId: typesFile.id,
      sourceKind: 'file',
      targetKind: 'file',
      type: 'imports'
    },
    {
      id: 'rel:data-service->service-config',
      repositoryId: repoPath,
      sourceId: dataServiceId,
      targetId: serviceConfigId,
      sourceKind: 'element',
      targetKind: 'element',
      type: 'implements'
    }
  ]

  function symbolReference(
    id: string,
    sourceFileId: string,
    sourceElementId: string | null,
    targetElementId: string,
    kind: PersistedSymbolReference['kind'],
    relativePath: keyof typeof FIXTURE_FILES,
    occurrence: string
  ): PersistedSymbolReference {
    const content = FIXTURE_FILES[relativePath]
    const startByte = content.lastIndexOf(occurrence)
    const location = computeLocation(content, startByte, startByte + Buffer.byteLength(occurrence))
    return { id, repositoryId: repoPath, sourceFileId, sourceElementId, targetElementId, kind, location }
  }

  const symbolReferences = [
    symbolReference('ref:data-service', appFile.id, startAppId, dataServiceId, 'instantiation', 'src/app.ts', 'DataService()'),
    symbolReference('ref:service-config', serviceFile.id, executeId, serviceConfigId, 'type', 'src/service.ts', 'ServiceConfig'),
    symbolReference('ref:execution-result', serviceFile.id, executeId, executionResultId, 'type', 'src/service.ts', 'ExecutionResult')
  ]

  let sourceReadsCount = 0

  const port: CodeMapNavigationPort = {
    async awaitSnapshot() {},
    getFiles: () => files,
    getElements: () => elements,
    getRelationships: () => relationships,
    getHierarchyRelationshipsBySourceElement: (_repoPath, elementId) => relationships.filter((relationship) => relationship.sourceId === elementId && (relationship.type === 'extends' || relationship.type === 'implements')),
    getHierarchyRelationshipsByTargetElement: (_repoPath, elementId) => relationships.filter((relationship) => relationship.targetId === elementId && (relationship.type === 'extends' || relationship.type === 'implements')),
    getSymbolReferencesByTargetElement: (_repoPath, targetElementId) => symbolReferences.filter((reference) => reference.targetElementId === targetElementId),
    getSymbolReferencesBySourceElement: (_repoPath, sourceElementId) => symbolReferences.filter((reference) => reference.sourceElementId === sourceElementId),
    getElementExactSources: async (_repoPath, ids) => {
      sourceReadsCount += ids.length
      const result = new Map<string, ExactElementSource>()
      for (const id of ids) {
        const source = exactSources.get(id)
        if (source) result.set(id, source)
      }
      return result
    }
  }

  const engine = new ContextEngine(port)

  return {
    repoPath,
    files: FIXTURE_FILES,
    port,
    engine,
    getSourceReadsCount: () => sourceReadsCount
  }
}
