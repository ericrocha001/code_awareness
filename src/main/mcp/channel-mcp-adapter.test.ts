import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { ContextNavigationError } from '../../shared/types/context-navigation-types'
import type { ContextNavigationPort } from '../core/context/context-navigation-port'
import { createEfficiencyFixture } from '../core/context/context-efficiency-fixture'
import { serializeDiscovery, serializeRelationships, serializeInspectFiles, serializeReadCode, serializeReferences, serializeSymbolDependencies, serializeSymbolHierarchy } from '../core/context/context-navigation-serializer'
import { ChannelMcpAdapter } from './channel-mcp-adapter'
import { CODE_NAVIGATION_MCP_TOOLS as contextNavigationMcpTools } from './code-navigation-mcp'

function createNavigation(): ContextNavigationPort {
  return {
    discoverRepository: vi.fn(async () => ({ directories: [{ relativePath: '.', children: ['src/', 'tests/', 'package.json'] }, { relativePath: 'src/main/core/context', children: ['code-target.ts', 'context-engine.ts', 'repo-discovery.ts'] }] })),
    getRelationships: vi.fn(async () => ({ files: [{ relativePath: 'src/a.ts', out: [{ relativePath: 'src/b.ts' }], in: [{ relativePath: 'src/c.ts' }] }] })),
    inspectFiles: vi.fn(async () => ({ files: [{ relativePath: 'src/a.ts', elements: [{ kind: 'class', name: 'Example', target: 't:ASNFZ4mrze8', children: [{ kind: 'method', name: 'run', target: 't:AAAAAAAAAAA' }] }] }] })),
    readCode: vi.fn(async (_repoPath, targetIds) => targetIds.map((targetId) => ({ targetId, relativePath: 'src/a.ts', source: 'function run() {\r\n  return "ação 日本語"\r\n}\r\n' }))),
    getReferences: vi.fn(async (_repoPath, targetIds) => ({
      targets: targetIds.map((target, index) => ({
        target,
        references: index === 0 ? [{ relativePath: 'src/app.ts', kind: 'call' as const, line: 7, sourceTarget: 't:AAAAAAAAAAA' }] : []
      }))
    })),
    getSymbolDependencies: vi.fn(async (_repoPath, sourceTargetIds) => ({
      sources: sourceTargetIds.map((source, index) => ({
        source,
        dependencies: index === 0 ? [{ kind: 'call' as const, target: 't:ASNFZ4mrze8', relativePath: 'src/service.ts' }] : []
      }))
    })),
    getSymbolHierarchy: vi.fn(async (_repoPath, targetIds, options = {}) => ({
      targets: targetIds.map((target, index) => ({
        target,
        ...(options.direction !== 'down' ? { up: index === 0 ? [{ kind: 'extends' as const, target: 't:ASNFZ4mrze8', relativePath: 'src/base.ts' }] : [] } : {}),
        ...(options.direction !== 'up' ? { down: index === 0 ? [{ kind: 'implements' as const, target: 't:CCCCCCCCCCC', relativePath: 'src/service.ts' }] : [] } : {})
      }))
    }))
  }
}

describe('ChannelMcpAdapter', () => {
  it('fingerprints metadata and annotations with stable object key ordering', () => {
    const adapter = new ChannelMcpAdapter(createNavigation(), 'repo')
    const original = adapter.listTools()[0]
    const list = vi.spyOn(adapter, 'listTools')
    list.mockReturnValue([original])
    const baseline = adapter.getToolCatalogHash()
    list.mockReturnValue([{ ...original, _meta: { 'openai/fileParams': ['file'], other: { b: 2, a: 1 } } }])
    const metadataHash = adapter.getToolCatalogHash()
    expect(metadataHash).not.toBe(baseline)
    list.mockReturnValue([{ ...original, _meta: { other: { a: 1, b: 2 }, 'openai/fileParams': ['file'] } }])
    expect(adapter.getToolCatalogHash()).toBe(metadataHash)
    list.mockReturnValue([{ ...original, _meta: { 'openai/fileParams': ['file'], other: { b: 2, a: 1 } }, annotations: { readOnlyHint: false } }])
    expect(adapter.getToolCatalogHash()).not.toBe(metadataHash)
    list.mockReturnValue([original])
    expect(adapter.getToolCatalogHash()).toBe(baseline)
  })

  it('preserves the ordered navigation catalog from before the Channel extraction', () => {
    expect(createHash('sha256').update(JSON.stringify(contextNavigationMcpTools.filter(tool => tool.name !== 'inspect_worktree_structure'))).digest('hex')).toBe('92fcf3f0031863ce4557de703ad3865dda44e6e22c91f8de6994dc467dff0f7e')
  })

  it('publishes eight independent progressive capabilities', () => {
    expect(contextNavigationMcpTools.map((tool) => tool.name)).toEqual(['inspect_worktree_structure', 'discover_repository', 'get_relationships', 'inspect_files', 'get_references', 'get_symbol_dependencies', 'get_symbol_hierarchy', 'read_code'])
    for (const tool of contextNavigationMcpTools) {
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(tool.securitySchemes).toEqual([{ type: 'oauth2', scopes: [] }])
    }
    expect(contextNavigationMcpTools.find((tool) => tool.name === 'get_references')?.description).toContain('only references resolved by the CodeMap')
    const dependenciesDescription = contextNavigationMcpTools.find((tool) => tool.name === 'get_symbol_dependencies')?.description
    expect(dependenciesDescription).toContain('directly used')
    expect(dependenciesDescription).toContain('resolved by the CodeMap')
    expect(dependenciesDescription).not.toMatch(/transitive|full call graph/i)
    const hierarchyDescription = contextNavigationMcpTools.find((tool) => tool.name === 'get_symbol_hierarchy')?.description
    expect(hierarchyDescription).toMatch(/direct inheritance and implementation/i)
    expect(hierarchyDescription).toContain('known to the CodeMap')
    expect(hierarchyDescription).toMatch(/up.*direct bases or implemented contracts/i)
    expect(hierarchyDescription).toMatch(/down.*direct derived types or implementations/i)
    expect(hierarchyDescription).toMatch(/both.*both directions/i)
    expect(hierarchyDescription).toMatch(/does not build a full tree or return transitive relationships/i)
  })

  it('binds the project and freezes compact golden outputs without enrichment', async () => {
    const navigation = createNavigation()
    const adapter = new ChannelMcpAdapter(navigation, 'C:/bound')
    expect((await adapter.callTool('discover_repository', {})).content).toEqual([{ type: 'text', text: '[.]\nsrc/\ntests/\npackage.json\n\n[src/main/core/context]\ncode-target.ts\ncontext-engine.ts\nrepo-discovery.ts' }])
    expect(navigation.discoverRepository).toHaveBeenCalledWith('C:/bound', undefined)
    expect(navigation.getRelationships).not.toHaveBeenCalled()
    expect(navigation.inspectFiles).not.toHaveBeenCalled()
    expect(navigation.readCode).not.toHaveBeenCalled()
    expect(navigation.getReferences).not.toHaveBeenCalled()
    expect(navigation.getSymbolDependencies).not.toHaveBeenCalled()
    expect(navigation.getSymbolHierarchy).not.toHaveBeenCalled()
    expect((await adapter.callTool('get_relationships', { relativePaths: ['src/a.ts'] })).content[0].text).toBe('[src/a.ts]\n\nOUT\nsrc/b.ts\n\nIN\nsrc/c.ts')
    expect((await adapter.callTool('inspect_files', { relativePaths: ['src/a.ts'] })).content[0].text).toBe('[src/a.ts]\n\nclass Example t:ASNFZ4mrze8\n  run t:AAAAAAAAAAA')
    const code = await adapter.callTool('read_code', { targetIds: ['t:AAAAAAAAAAA', 't:ASNFZ4mrze8'] })
    expect(code.content).toEqual(['t:AAAAAAAAAAA', 't:ASNFZ4mrze8'].map((id) => ({ type: 'text', text: '[' + id + ' src/a.ts]\n\nfunction run() {\r\n  return "ação 日本語"\r\n}\r\n' })))
    const references = await adapter.callTool('get_references', { targetIds: ['t:ASNFZ4mrze8', 't:BBBBBBBBBBB'] })
    expect(references.content).toEqual([{ type: 'text', text: '[t:ASNFZ4mrze8]\n\nsrc/app.ts:7 call t:AAAAAAAAAAA\n\n[t:BBBBBBBBBBB]\n\nNONE' }])
    const dependencies = await adapter.callTool('get_symbol_dependencies', { sourceTargetIds: ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'] })
    expect(dependencies.content).toEqual([{ type: 'text', text: '[t:AAAAAAAAAAA]\n\ncall t:ASNFZ4mrze8 src/service.ts\n\n[t:BBBBBBBBBBB]\n\nNONE' }])
    const hierarchy = await adapter.callTool('get_symbol_hierarchy', { targetIds: ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'] })
    expect(hierarchy.content).toEqual([{ type: 'text', text: '[t:AAAAAAAAAAA]\n\nUP\nextends t:ASNFZ4mrze8 src/base.ts\n\nDOWN\nimplements t:CCCCCCCCCCC src/service.ts\n\n[t:BBBBBBBBBBB]\n\nNONE' }])
    expect(navigation.discoverRepository).toHaveBeenCalledTimes(1)
    expect(navigation.getRelationships).toHaveBeenCalledTimes(1)
    expect(navigation.inspectFiles).toHaveBeenCalledTimes(1)
    expect(navigation.readCode).toHaveBeenCalledTimes(1)
    expect(navigation.getReferences).toHaveBeenCalledTimes(1)
    expect(navigation.getSymbolDependencies).toHaveBeenCalledTimes(1)
    expect(navigation.getSymbolHierarchy).toHaveBeenCalledTimes(1)
  })

  it('forwards explicit options without adding implicit requests', async () => {
    const navigation = createNavigation()
    const adapter = new ChannelMcpAdapter(navigation, 'repo')
    await adapter.callTool('discover_repository', { relativePaths: ['src', 'tests'] })
    await adapter.callTool('get_relationships', { relativePaths: ['src/a.ts'], direction: 'out', details: true })
    await adapter.callTool('inspect_files', { relativePaths: ['src/a.ts'], signatures: true })
    await adapter.callTool('get_symbol_hierarchy', { targetIds: ['t:AAAAAAAAAAA'], direction: 'down' })
    expect(navigation.discoverRepository).toHaveBeenCalledWith('repo', ['src', 'tests'])
    expect(navigation.getRelationships).toHaveBeenCalledWith('repo', ['src/a.ts'], { direction: 'out', details: true })
    expect(navigation.inspectFiles).toHaveBeenCalledWith('repo', ['src/a.ts'], { signatures: true })
    expect(navigation.getSymbolHierarchy).toHaveBeenCalledWith('repo', ['t:AAAAAAAAAAA'], { direction: 'down' })
  })

  it.each([
    ['inspect_scope', { relativePaths: ['src/a.ts'] }], ['ping', {}],
    ['read_code', { targetIds: 'bad' }], ['read_code', { targetIds: [] }],
    ['get_references', { targetIds: 'bad' }], ['get_references', { targetIds: [] }],
    ['get_references', { targetIds: ['a', 'a'] }], ['get_references', { targetIds: ['a'], includeSource: true }],
    ['get_symbol_dependencies', { sourceTargetIds: 'bad' }], ['get_symbol_dependencies', { sourceTargetIds: [] }],
    ['get_symbol_dependencies', { sourceTargetIds: ['a', 'a'] }], ['get_symbol_dependencies', { sourceTargetIds: ['a'], depth: 2 }],
    ['get_symbol_dependencies', { targetIds: ['a'] }],
    ['get_symbol_hierarchy', { targetIds: 'bad' }], ['get_symbol_hierarchy', { targetIds: [] }],
    ['get_symbol_hierarchy', { targetIds: ['a', 'a'] }], ['get_symbol_hierarchy', { targetIds: ['a'], direction: 'sideways' }],
    ['get_symbol_hierarchy', { targetIds: ['a'], recursive: true }], ['get_symbol_hierarchy', { targetIds: ['a'], depth: 2 }],
    ['get_symbol_hierarchy', { sourceTargetIds: ['a'] }],
    ['discover_repository', { repoPath: '/other' }], ['discover_repository', { relativePaths: ['a', 'a'] }],
    ['discover_repository', { toString: true }],
    ['get_relationships', { relativePaths: ['a'], direction: 'all' }],
    ['get_relationships', { relativePaths: ['a'], hops: 2 }],
    ['inspect_files', { relativePaths: ['a'], signatures: 'true' }]
  ])('rejects invalid call %s', async (name, args) => {
    const navigation = createNavigation()
    const result = await new ChannelMcpAdapter(navigation, 'repo').callTool(name as string, args)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^INVALID_ARGUMENT:/)
    for (const operation of Object.values(navigation)) expect(operation).not.toHaveBeenCalled()
  })

  it('preserves domain failure without fallback or JSON', async () => {
    const navigation = createNavigation()
    vi.mocked(navigation.inspectFiles).mockRejectedValueOnce(new ContextNavigationError('UNKNOWN_FILE', 'Unknown file: missing.ts'))
    const result = await new ChannelMcpAdapter(navigation, 'repo').callTool('inspect_files', { relativePaths: ['missing.ts'] })
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'UNKNOWN_FILE: Unknown file: missing.ts' }] })
    expect(navigation.discoverRepository).not.toHaveBeenCalled()
  })

  it('tool schemas declare correct parameter requirements per tool', () => {
    const tools = Object.fromEntries(contextNavigationMcpTools.map((t) => [t.name, t]))
    const props = (name: string) => tools[name].inputSchema.properties as Record<string, unknown>
    const required = (name: string) => (tools[name].inputSchema.required ?? []) as string[]

    expect(required('discover_repository')).not.toContain('relativePaths')
    expect(props('discover_repository')).toHaveProperty('relativePaths')

    expect(required('get_relationships')).toContain('relativePaths')
    expect(required('get_relationships')).not.toContain('direction')
    expect(required('get_relationships')).not.toContain('details')
    expect((props('get_relationships').direction as Record<string, unknown>).enum).toEqual(['in', 'out', 'both'])

    expect(required('inspect_files')).toContain('relativePaths')
    expect(required('inspect_files')).not.toContain('signatures')

    expect(required('read_code')).toContain('targetIds')
    expect(required('read_code')).not.toContain('relativePaths')

    expect(required('get_references')).toEqual(['targetIds'])
    expect(Object.keys(props('get_references'))).toEqual(['targetIds'])

    expect(required('get_symbol_dependencies')).toEqual(['sourceTargetIds'])
    expect(Object.keys(props('get_symbol_dependencies'))).toEqual(['sourceTargetIds'])

    expect(required('get_symbol_hierarchy')).toEqual(['targetIds'])
    expect(Object.keys(props('get_symbol_hierarchy'))).toEqual(['targetIds', 'direction'])
    expect((props('get_symbol_hierarchy').direction as Record<string, unknown>).enum).toEqual(['up', 'down', 'both'])
  })

  it('content.text equals serializer output exactly, with no JSON escaping', async () => {
    const navigation = createNavigation()
    const adapter = new ChannelMcpAdapter(navigation, 'repo')

    const discResult = await navigation.discoverRepository('repo', undefined)
    const expectedDiscovery = serializeDiscovery(discResult)
    const mcpDisc = await adapter.callTool('discover_repository', {})
    expect(mcpDisc.content[0].text).toBe(expectedDiscovery)
    expect(mcpDisc.content[0].text).not.toMatch(/\\"/)
    expect(mcpDisc.content[0].text).not.toMatch(/^\{|^\[\{/)

    const relResult = await navigation.getRelationships('repo', ['src/a.ts'], {})
    const expectedRel = serializeRelationships(relResult)
    const mcpRel = await adapter.callTool('get_relationships', { relativePaths: ['src/a.ts'] })
    expect(mcpRel.content[0].text).toBe(expectedRel)
    expect(mcpRel.content[0].text).not.toMatch(/\\"/)
    expect(mcpRel.content[0].text).not.toMatch(/^\{|^\[\{/)

    const inspResult = await navigation.inspectFiles('repo', ['src/a.ts'], {})
    const expectedInspect = serializeInspectFiles(inspResult)
    const mcpInsp = await adapter.callTool('inspect_files', { relativePaths: ['src/a.ts'] })
    expect(mcpInsp.content[0].text).toBe(expectedInspect)
    expect(mcpInsp.content[0].text).not.toMatch(/\\"/)
    expect(mcpInsp.content[0].text).not.toMatch(/^\{|^\[\{/)

    const readResults = await navigation.readCode('repo', ['t:AAAAAAAAAAA'])
    const expectedRead = serializeReadCode(readResults[0])
    const mcpRead = await adapter.callTool('read_code', { targetIds: ['t:AAAAAAAAAAA'] })
    expect(mcpRead.content[0].text).toBe(expectedRead)
    expect(mcpRead.content[0].text).not.toMatch(/\\"/)
    expect(mcpRead.content[0].text).not.toMatch(/^\{|^\[\{/)

    const referencesResult = await navigation.getReferences('repo', ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'])
    const expectedReferences = serializeReferences(referencesResult)
    const mcpReferences = await adapter.callTool('get_references', { targetIds: ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'] })
    expect(mcpReferences.content).toEqual([{ type: 'text', text: expectedReferences }])
    expect(mcpReferences.content[0].text).not.toMatch(/\\"/)
    expect(mcpReferences.content[0].text).not.toMatch(/^\{|^\[\{/)

    const dependenciesResult = await navigation.getSymbolDependencies('repo', ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'])
    const expectedDependencies = serializeSymbolDependencies(dependenciesResult)
    const mcpDependencies = await adapter.callTool('get_symbol_dependencies', { sourceTargetIds: ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'] })
    expect(mcpDependencies.content).toEqual([{ type: 'text', text: expectedDependencies }])
    expect(mcpDependencies.content[0].text).not.toMatch(/\\"/)
    expect(mcpDependencies.content[0].text).not.toMatch(/^\{|^\[\{/)

    const hierarchyResult = await navigation.getSymbolHierarchy('repo', ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'], {})
    const expectedHierarchy = serializeSymbolHierarchy(hierarchyResult)
    const mcpHierarchy = await adapter.callTool('get_symbol_hierarchy', { targetIds: ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'] })
    expect(mcpHierarchy.content).toEqual([{ type: 'text', text: expectedHierarchy }])
    expect(mcpHierarchy.content[0].text).not.toMatch(/\\"/)
    expect(mcpHierarchy.content[0].text).not.toMatch(/^\{|^\[\{/)
  })

  it('navigates hierarchy in both directions through public MCP tools without reading source early', async () => {
    const fixture = createEfficiencyFixture()
    const adapter = new ChannelMcpAdapter(fixture.engine, fixture.repoPath)
    const inspected = await adapter.callTool('inspect_files', { relativePaths: ['src/service.ts', 'src/types.ts'] })
    const service = inspected.content[0].text.match(/class DataService (t:[A-Za-z0-9_-]{11})/)?.[1]
    const contract = inspected.content[0].text.match(/interface ServiceConfig (t:[A-Za-z0-9_-]{11})/)?.[1]
    expect(service).toBeDefined()
    expect(contract).toBeDefined()

    const up = await adapter.callTool('get_symbol_hierarchy', { targetIds: [service!] })
    expect(up.content[0].text).toBe(serializeSymbolHierarchy(await fixture.engine.getSymbolHierarchy(fixture.repoPath, [service!])))
    expect(up.content[0].text).toContain(contract!)
    const contractReferences = await adapter.callTool('get_references', { targetIds: [contract!] })
    expect(contractReferences.content[0].text).toContain('t:')

    const down = await adapter.callTool('get_symbol_hierarchy', { targetIds: [contract!], direction: 'down' })
    expect(down.content[0].text).toBe(serializeSymbolHierarchy(await fixture.engine.getSymbolHierarchy(fixture.repoPath, [contract!], { direction: 'down' })))
    expect(down.content[0].text).toContain(service!)
    const dependencies = await adapter.callTool('get_symbol_dependencies', { sourceTargetIds: [service!] })
    expect(dependencies.isError).toBeUndefined()
    expect(fixture.getSourceReadsCount()).toBe(0)

    const read = await adapter.callTool('read_code', { targetIds: [service!] })
    expect(read.content[0].text).toContain('class DataService')
    expect(fixture.getSourceReadsCount()).toBe(1)

    const rejectedInternalId = await adapter.callTool('get_symbol_hierarchy', { targetIds: ['0000000000000001'] })
    expect(rejectedInternalId).toMatchObject({ isError: true })
    expect(rejectedInternalId.content[0].text).toMatch(/^INVALID_TARGET:/)
  })

  it('navigates inspect to references to source code through public MCP tools without reading source early', async () => {
    const fixture = createEfficiencyFixture()
    const adapter = new ChannelMcpAdapter(fixture.engine, fixture.repoPath)

    const inspected = await adapter.callTool('inspect_files', { relativePaths: ['src/service.ts'] })
    const target = inspected.content[0].text.match(/class DataService (t:[A-Za-z0-9_-]{11})/)?.[1]
    expect(target).toBeDefined()

    const references = await adapter.callTool('get_references', { targetIds: [target!] })
    const coreResult = await fixture.engine.getReferences(fixture.repoPath, [target!])
    expect(references.content).toEqual([{ type: 'text', text: serializeReferences(coreResult) }])
    expect(fixture.getSourceReadsCount()).toBe(0)

    const sourceTarget = references.content[0].text.match(/ (t:[A-Za-z0-9_-]{11})$/m)?.[1]
    expect(sourceTarget).toBeDefined()
    const read = await adapter.callTool('read_code', { targetIds: [sourceTarget!] })
    expect(read.content[0].text).toContain('function startApp')
    expect(fixture.getSourceReadsCount()).toBe(1)
  })

  it('navigates inspect to outbound dependency, inbound references and source through public MCP tools', async () => {
    const fixture = createEfficiencyFixture()
    const adapter = new ChannelMcpAdapter(fixture.engine, fixture.repoPath)
    const inspected = await adapter.callTool('inspect_files', { relativePaths: ['src/app.ts'] })
    const sourceTarget = inspected.content[0].text.match(/function startApp (t:[A-Za-z0-9_-]{11})/)?.[1]
    expect(sourceTarget).toBeDefined()

    const dependencies = await adapter.callTool('get_symbol_dependencies', { sourceTargetIds: [sourceTarget!] })
    const coreResult = await fixture.engine.getSymbolDependencies(fixture.repoPath, [sourceTarget!])
    expect(dependencies.content).toEqual([{ type: 'text', text: serializeSymbolDependencies(coreResult) }])
    expect(fixture.getSourceReadsCount()).toBe(0)
    const dependencyTarget = dependencies.content[0].text.match(/\b(t:[A-Za-z0-9_-]{11}) src\/service\.ts$/m)?.[1]
    expect(dependencyTarget).toBeDefined()

    const inbound = await adapter.callTool('get_references', { targetIds: [dependencyTarget!] })
    expect(inbound.content[0].text).toContain(sourceTarget!)
    expect(fixture.getSourceReadsCount()).toBe(0)

    const read = await adapter.callTool('read_code', { targetIds: [dependencyTarget!] })
    expect(read.content[0].text).toContain('class DataService')
    expect(fixture.getSourceReadsCount()).toBe(1)

    const rejectedInternalId = await adapter.callTool('get_symbol_dependencies', { sourceTargetIds: ['0000000000000001'] })
    expect(rejectedInternalId).toMatchObject({ isError: true })
    expect(rejectedInternalId.content[0].text).toMatch(/^INVALID_TARGET:/)
  })
})
