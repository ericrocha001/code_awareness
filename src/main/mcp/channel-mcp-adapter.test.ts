import { textContent } from './mcp-test-content'
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { ContextNavigationError } from '../../shared/types/context-navigation-types'
import type { ContextNavigationPort } from '../core/context/context-navigation-port'
import { bindProjectNavigation } from '../core/context/project-context-navigation'
import { createEfficiencyFixture } from '../core/context/context-efficiency-fixture'
import { serializeDiscovery, serializeRelationships, serializeInspectFiles, serializeReadCode, serializeReferences, serializeSymbolDependencies, serializeSymbolHierarchy } from '../core/context/context-navigation-serializer'
import { ChannelMcpAdapter } from './channel-mcp-adapter'
import { CODE_NAVIGATION_MCP_TOOLS as contextNavigationMcpTools } from './code-navigation-mcp'
import { authenticatedAgentPrincipal, authorizeArtifactAgent } from '../continuum/agent-authority'

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
  it('projects the selected session event with its schema, literal text and all metadata while preserving errors', async () => {
    const content = 'public literal 🧪\r\n${source}\t"quoted"\\tail'
    const args = { sessionId: 'session-public', eventId: 'event-public', expectedRevision: 2 }
    const payload = {
      sessionId: args.sessionId, eventId: args.eventId, revision: 2, content, range: { startByte: 0, endByte: Buffer.byteLength(content) },
      coverage: 'PARTIAL', complete: false, partial: true, omission: 'LIMIT_REACHED', sanitized: true,
      untrusted: true, claimsVerified: false, provenance: 'OBSERVED_FROM_PROVIDER', sourcePosition: 7,
      payloadDigest: createHash('sha256').update(content).digest('hex'), nextCursor: 'opaque-public-cursor'
    }
    const legacy = { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
    const call = vi.fn(async (_name: string, _args: unknown) => legacy)
    const adapter = new ChannelMcpAdapter({ projectId: 'repo', repoRoot: 'repo', navigation: bindProjectNavigation(createNavigation(), 'repo'), sessionContext: { call } })
    expect(adapter.listTools().find(tool => tool.name === 'read_agent_session_event')!.outputSchema)
      .toMatchObject({ type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: true })
    const result = await adapter.callTool('read_agent_session_event', args)
    expect(call).toHaveBeenCalledExactlyOnceWith('read_agent_session_event', args)
    expect(result.content).toEqual(legacy.content)
    expect(result.structuredContent).toEqual(payload)
    expect(result.structuredContent).toEqual(JSON.parse(textContent(result.content[0])))
    expect(result.structuredContent?.content).toBe(content)
    const failure = { content: [{ type: 'text' as const, text: '{"code":"REVISION_CONFLICT"}' }], isError: true as const }
    call.mockResolvedValueOnce(failure)
    const rejected = await adapter.callTool('read_agent_session_event', { ...args, expectedRevision: 1 })
    expect(rejected).toEqual(failure)
    expect(rejected.structuredContent).toBeUndefined()
    call.mockResolvedValueOnce({ ...legacy, isError: true } as typeof legacy)
    expect((await adapter.callTool('read_agent_session_event', args)).structuredContent).toBeUndefined()
    call.mockResolvedValueOnce({ content: [{ type: 'text', text: '{}' }] })
    expect((await adapter.callTool('read_agent_session_event', args)).structuredContent).toBeUndefined()
    for (const name of ['list_agent_sessions', 'inspect_agent_session', 'list_agent_session_events']) {
      expect(adapter.listTools().find(tool => tool.name === name)?.outputSchema).toBeUndefined()
    }
  })

  it.each(['read_artifact_section', 'read_worktree_file'])('exposes %s data explicitly without changing legacy text or source fields', async name => {
    const adapter = new ChannelMcpAdapter(createNavigation(), 'repo')
    const data = { content: 'literal 🚀\r\n${source}', revision: 2, start: 10, end: 35, nextCursor: 'opaque' }
    const legacy = { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
    const dispatch = vi.spyOn(adapter as unknown as { dispatchTool: () => Promise<typeof legacy> }, 'dispatchTool').mockResolvedValue(legacy)
    const result = await adapter.callTool(name, {})
    expect(result.content).toEqual(legacy.content)
    expect(result.structuredContent).toEqual(data)
    dispatch.mockResolvedValueOnce({ ...legacy, isError: true } as typeof legacy)
    expect((await adapter.callTool(name, {})).structuredContent).toBeUndefined()
    expect((await adapter.callTool('get_artifact', {})).structuredContent).toBeUndefined()
  })

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
    expect(textContent((await adapter.callTool('get_relationships', { relativePaths: ['src/a.ts'] })).content[0])).toBe('[src/a.ts]\n\nOUT\nsrc/b.ts\n\nIN\nsrc/c.ts')
    expect(textContent((await adapter.callTool('inspect_files', { relativePaths: ['src/a.ts'] })).content[0])).toBe('[src/a.ts]\n\nclass Example t:ASNFZ4mrze8\n  run t:AAAAAAAAAAA')
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
    expect(textContent(result.content[0])).toMatch(/^INVALID_ARGUMENT:/)
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
    expect(textContent(mcpDisc.content[0])).toBe(expectedDiscovery)
    expect(textContent(mcpDisc.content[0])).not.toMatch(/\\"/)
    expect(textContent(mcpDisc.content[0])).not.toMatch(/^\{|^\[\{/)

    const relResult = await navigation.getRelationships('repo', ['src/a.ts'], {})
    const expectedRel = serializeRelationships(relResult)
    const mcpRel = await adapter.callTool('get_relationships', { relativePaths: ['src/a.ts'] })
    expect(textContent(mcpRel.content[0])).toBe(expectedRel)
    expect(textContent(mcpRel.content[0])).not.toMatch(/\\"/)
    expect(textContent(mcpRel.content[0])).not.toMatch(/^\{|^\[\{/)

    const inspResult = await navigation.inspectFiles('repo', ['src/a.ts'], {})
    const expectedInspect = serializeInspectFiles(inspResult)
    const mcpInsp = await adapter.callTool('inspect_files', { relativePaths: ['src/a.ts'] })
    expect(textContent(mcpInsp.content[0])).toBe(expectedInspect)
    expect(textContent(mcpInsp.content[0])).not.toMatch(/\\"/)
    expect(textContent(mcpInsp.content[0])).not.toMatch(/^\{|^\[\{/)

    const readResults = await navigation.readCode('repo', ['t:AAAAAAAAAAA'])
    const expectedRead = serializeReadCode(readResults[0])
    const mcpRead = await adapter.callTool('read_code', { targetIds: ['t:AAAAAAAAAAA'] })
    expect(textContent(mcpRead.content[0])).toBe(expectedRead)
    expect(textContent(mcpRead.content[0])).not.toMatch(/\\"/)
    expect(textContent(mcpRead.content[0])).not.toMatch(/^\{|^\[\{/)

    const referencesResult = await navigation.getReferences('repo', ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'])
    const expectedReferences = serializeReferences(referencesResult)
    const mcpReferences = await adapter.callTool('get_references', { targetIds: ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'] })
    expect(mcpReferences.content).toEqual([{ type: 'text', text: expectedReferences }])
    expect(textContent(mcpReferences.content[0])).not.toMatch(/\\"/)
    expect(textContent(mcpReferences.content[0])).not.toMatch(/^\{|^\[\{/)

    const dependenciesResult = await navigation.getSymbolDependencies('repo', ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'])
    const expectedDependencies = serializeSymbolDependencies(dependenciesResult)
    const mcpDependencies = await adapter.callTool('get_symbol_dependencies', { sourceTargetIds: ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'] })
    expect(mcpDependencies.content).toEqual([{ type: 'text', text: expectedDependencies }])
    expect(textContent(mcpDependencies.content[0])).not.toMatch(/\\"/)
    expect(textContent(mcpDependencies.content[0])).not.toMatch(/^\{|^\[\{/)

    const hierarchyResult = await navigation.getSymbolHierarchy('repo', ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'], {})
    const expectedHierarchy = serializeSymbolHierarchy(hierarchyResult)
    const mcpHierarchy = await adapter.callTool('get_symbol_hierarchy', { targetIds: ['t:AAAAAAAAAAA', 't:BBBBBBBBBBB'] })
    expect(mcpHierarchy.content).toEqual([{ type: 'text', text: expectedHierarchy }])
    expect(textContent(mcpHierarchy.content[0])).not.toMatch(/\\"/)
    expect(textContent(mcpHierarchy.content[0])).not.toMatch(/^\{|^\[\{/)
  })

  it('navigates hierarchy in both directions through public MCP tools without reading source early', async () => {
    const fixture = createEfficiencyFixture()
    const adapter = new ChannelMcpAdapter(fixture.engine, fixture.repoPath)
    const inspected = await adapter.callTool('inspect_files', { relativePaths: ['src/service.ts', 'src/types.ts'] })
    const service = textContent(inspected.content[0]).match(/class DataService (t:[A-Za-z0-9_-]{11})/)?.[1]
    const contract = textContent(inspected.content[0]).match(/interface ServiceConfig (t:[A-Za-z0-9_-]{11})/)?.[1]
    expect(service).toBeDefined()
    expect(contract).toBeDefined()

    const up = await adapter.callTool('get_symbol_hierarchy', { targetIds: [service!] })
    expect(textContent(up.content[0])).toBe(serializeSymbolHierarchy(await fixture.engine.getSymbolHierarchy(fixture.repoPath, [service!])))
    expect(textContent(up.content[0])).toContain(contract!)
    const contractReferences = await adapter.callTool('get_references', { targetIds: [contract!] })
    expect(textContent(contractReferences.content[0])).toContain('t:')

    const down = await adapter.callTool('get_symbol_hierarchy', { targetIds: [contract!], direction: 'down' })
    expect(textContent(down.content[0])).toBe(serializeSymbolHierarchy(await fixture.engine.getSymbolHierarchy(fixture.repoPath, [contract!], { direction: 'down' })))
    expect(textContent(down.content[0])).toContain(service!)
    const dependencies = await adapter.callTool('get_symbol_dependencies', { sourceTargetIds: [service!] })
    expect(dependencies.isError).toBeUndefined()
    expect(fixture.getSourceReadsCount()).toBe(0)

    const read = await adapter.callTool('read_code', { targetIds: [service!] })
    expect(textContent(read.content[0])).toContain('class DataService')
    expect(fixture.getSourceReadsCount()).toBe(1)

    const rejectedInternalId = await adapter.callTool('get_symbol_hierarchy', { targetIds: ['0000000000000001'] })
    expect(rejectedInternalId).toMatchObject({ isError: true })
    expect(textContent(rejectedInternalId.content[0])).toMatch(/^INVALID_TARGET:/)
  })

  it('navigates inspect to references to source code through public MCP tools without reading source early', async () => {
    const fixture = createEfficiencyFixture()
    const adapter = new ChannelMcpAdapter(fixture.engine, fixture.repoPath)

    const inspected = await adapter.callTool('inspect_files', { relativePaths: ['src/service.ts'] })
    const target = textContent(inspected.content[0]).match(/class DataService (t:[A-Za-z0-9_-]{11})/)?.[1]
    expect(target).toBeDefined()

    const references = await adapter.callTool('get_references', { targetIds: [target!] })
    const coreResult = await fixture.engine.getReferences(fixture.repoPath, [target!])
    expect(references.content).toEqual([{ type: 'text', text: serializeReferences(coreResult) }])
    expect(fixture.getSourceReadsCount()).toBe(0)

    const sourceTarget = textContent(references.content[0]).match(/ (t:[A-Za-z0-9_-]{11})$/m)?.[1]
    expect(sourceTarget).toBeDefined()
    const read = await adapter.callTool('read_code', { targetIds: [sourceTarget!] })
    expect(textContent(read.content[0])).toContain('function startApp')
    expect(fixture.getSourceReadsCount()).toBe(1)
  })

  it('navigates inspect to outbound dependency, inbound references and source through public MCP tools', async () => {
    const fixture = createEfficiencyFixture()
    const adapter = new ChannelMcpAdapter(fixture.engine, fixture.repoPath)
    const inspected = await adapter.callTool('inspect_files', { relativePaths: ['src/app.ts'] })
    const sourceTarget = textContent(inspected.content[0]).match(/function startApp (t:[A-Za-z0-9_-]{11})/)?.[1]
    expect(sourceTarget).toBeDefined()

    const dependencies = await adapter.callTool('get_symbol_dependencies', { sourceTargetIds: [sourceTarget!] })
    const coreResult = await fixture.engine.getSymbolDependencies(fixture.repoPath, [sourceTarget!])
    expect(dependencies.content).toEqual([{ type: 'text', text: serializeSymbolDependencies(coreResult) }])
    expect(fixture.getSourceReadsCount()).toBe(0)
    const dependencyTarget = textContent(dependencies.content[0]).match(/\b(t:[A-Za-z0-9_-]{11}) src\/service\.ts$/m)?.[1]
    expect(dependencyTarget).toBeDefined()

    const inbound = await adapter.callTool('get_references', { targetIds: [dependencyTarget!] })
    expect(textContent(inbound.content[0])).toContain(sourceTarget!)
    expect(fixture.getSourceReadsCount()).toBe(0)

    const read = await adapter.callTool('read_code', { targetIds: [dependencyTarget!] })
    expect(textContent(read.content[0])).toContain('class DataService')
    expect(fixture.getSourceReadsCount()).toBe(1)

    const rejectedInternalId = await adapter.callTool('get_symbol_dependencies', { sourceTargetIds: ['0000000000000001'] })
    expect(rejectedInternalId).toMatchObject({ isError: true })
    expect(textContent(rejectedInternalId.content[0])).toMatch(/^INVALID_TARGET:/)
  })

  it('propagates authenticated deliveryContext automatically across publish_artifact, update_artifact, start_validation and record_validation_proof without editorial YAML mutation', async () => {
    const request = { bindingArtifactId: 'artifact-execution-branch-' + '1'.repeat(64), bindingRevision: 1, planArtifactId: 'artifact-11111111-1111-4111-8111-111111111111', planRevision: 1, executionId: 'execution-A' }
    const snapshot = { repositoryId: 'repo-1', worktreeId: 'a'.repeat(64), worktreeGeneration: '4'.repeat(64), branchRef: 'refs/heads/feat', branchGeneration: '5'.repeat(64), branchRevision: '6'.repeat(64), fingerprint: '7'.repeat(64), head: 'b'.repeat(40) }
    const anchor = { ...request, schemaVersion: 1 as const, repositoryId: 'repo-1', planDigest: '2'.repeat(64), bindingDigest: '3'.repeat(64), classification: 'AUTHENTICATED_EXECUTION_CONTEXT' as const, snapshot }
    const continuum = {
      repositoryId: 'repo-1',
      prepareDeliveryContext: vi.fn(async () => anchor),
      publish: vi.fn((rawMarkdown: string, _fields?: unknown, _authority?: unknown, prepared?: unknown) => ({ success: true, artifactId: 'artifact-out', revision: 1, updatedAt: '2026-11-19T00:00:00Z', rawMarkdown, prepared })),
      updateAgent: vi.fn(async () => ({ success: true, artifactId: 'artifact-out', revision: 2, updatedAt: '2026-11-19T00:00:01Z', state: 'PERSISTED' })),
      update: vi.fn()
    }
    const ledger = { recordProof: vi.fn((input: any) => ({ proofId: 'proof-1', recordedAt: '2026-11-19T00:00:02Z', status: input.status, ...input })) }
    const validationExecution = { start: vi.fn(async (input: any) => ({ runId: 'run-1', status: 'RUNNING', cwd: '/repo', source: { version: 1 }, input })), listProfiles: () => [], wait: vi.fn(), getActiveRunId: () => null }
    const adapter = new ChannelMcpAdapter({
      projectId: 'repo-1',
      repoRoot: '/repo',
      navigation: bindProjectNavigation(createNavigation(), '/repo'),
      continuum: continuum as any,
      gitOperations: { deliverySnapshot: vi.fn(async () => snapshot) } as any,
      validationExecution: validationExecution as any
    }, undefined, undefined, ledger as any)
    const authority = authorizeArtifactAgent(authenticatedAgentPrincipal('MCP', () => true), 'repo-1', () => true, 'a'.repeat(64), { deliveryContext: request })

    const pub = await adapter.callTool('publish_artifact', { rawMarkdown: '---\nname: Doc\nkind: TECHNICAL_SPEC\n---\nBody' }, undefined, authority)
    expect(pub.isError).toBeUndefined()
    expect(continuum.prepareDeliveryContext).toHaveBeenCalledTimes(1)
    expect(continuum.publish).toHaveBeenCalledWith('---\nname: Doc\nkind: TECHNICAL_SPEC\n---\nBody', expect.any(Object), authority, anchor)

    const upd = await adapter.callTool('update_artifact', { artifactId: 'artifact-out', expectedRevision: 1, rawMarkdown: '---\nname: Doc\nkind: TECHNICAL_SPEC\n---\nBody v2' }, undefined, authority)
    expect(upd.isError).toBeUndefined()
    expect(continuum.updateAgent).toHaveBeenCalledWith(authority, 'artifact-out', 1, '---\nname: Doc\nkind: TECHNICAL_SPEC\n---\nBody v2', {}, undefined, expect.any(Function))

    const proof = await adapter.callTool('record_validation_proof', {
      kind: 'TARGETED_TEST', producer: 'IMPLEMENTER', status: 'PASSED',
      startedAt: '2026-11-19T00:00:00Z', finishedAt: '2026-11-19T00:00:01Z', durationMs: 1000, scope: ['x'], summary: 'ok'
    }, undefined, authority)
    expect(proof.isError).toBeUndefined()
    expect(ledger.recordProof).toHaveBeenCalledWith(expect.objectContaining({
      evidenceFor: [request.planArtifactId],
      commandProfile: expect.objectContaining({ deliveryContext: anchor })
    }))

    const explicitProof = await adapter.callTool('record_validation_proof', {
      kind: 'TARGETED_TEST', producer: 'IMPLEMENTER', status: 'PASSED',
      startedAt: '2026-11-19T00:00:00Z', finishedAt: '2026-11-19T00:00:01Z', durationMs: 1000, scope: ['x'], summary: 'ok', evidenceFor: ['explicit-target']
    }, undefined, authority)
    expect(explicitProof.isError).toBeUndefined()
    expect(ledger.recordProof).toHaveBeenLastCalledWith(expect.objectContaining({
      evidenceFor: ['explicit-target'],
      commandProfile: expect.objectContaining({ deliveryContext: anchor })
    }))

    const val = await adapter.callTool('start_validation', { profileId: 'typecheck', producer: 'TESTER' }, undefined, authority)
    expect(val.isError).toBeUndefined()
    expect(validationExecution.start).toHaveBeenCalledWith(expect.objectContaining({ deliveryContext: anchor }))

    const badAuthority = authorizeArtifactAgent(authenticatedAgentPrincipal('MCP', () => true), 'repo-1', () => true, 'a'.repeat(64), { deliveryContextError: 'DELIVERY_CONTEXT_MALFORMED' })
    const badPub = await adapter.callTool('publish_artifact', { rawMarkdown: '---\nname: Bad\nkind: TECHNICAL_SPEC\n---\nBody' }, undefined, badAuthority)
    expect(badPub.isError).toBe(true)
    expect(textContent(badPub.content[0])).toBe('DELIVERY_CONTEXT_INVALID')
    expect(continuum.publish).toHaveBeenCalledTimes(1)
    const badVal = await adapter.callTool('start_validation', { profileId: 'typecheck', producer: 'TESTER' }, undefined, badAuthority)
    expect(badVal.isError).toBe(true)
    expect(validationExecution.start).toHaveBeenCalledTimes(1)
  })

  it('exposes worktree execution bootstrap/revoke tools without implicit unscoped inheritance', async () => {
    const worktreeId = 'b'.repeat(64)
    const continuum = {
      repositoryId: 'repo-1',
      get: vi.fn(),
      list: vi.fn(),
      publish: vi.fn((rawMarkdown: string, _fields?: unknown, _authority?: unknown, anchor?: unknown) => ({ success: true, artifactId: 'artifact-pub', revision: 1, updatedAt: '2026-11-20T00:00:00Z', anchor })),
      update: vi.fn(),
      bootstrapExecution: vi.fn(async (input: { planArtifactId: string; scopeKind?: string }) => ({ state: 'PERSISTED', artifactId: 'artifact-bind', revision: 1, executionId: 'exec-1', planArtifactId: input.planArtifactId, scopeKind: input.scopeKind })),
      revokeExecutionActivation: vi.fn(async (input: { worktreeId: string; status?: string }) => ({ state: 'PERSISTED', worktreeId: input.worktreeId, status: input.status ?? 'REVOKED' })),
      resolveExecutionContext: vi.fn(async (auth: { worktreeId?: string } | undefined) =>
        auth?.worktreeId ? { anchor: { executionId: 'exec-1' }, source: 'DURABLE_ACTIVATION' as const } : { anchor: undefined, source: 'UNMANAGED' as const }
      )
    } as unknown as import('../continuum/continuum-types').IContinuumService
    const gitOperations = {
      deliverySnapshot: vi.fn(async (targetId?: string) => ({ repositoryId: 'repo-1', worktreeId: targetId ?? worktreeId, worktreeGeneration: 'gen-1', branchRef: 'refs/heads/feat', branchGeneration: 'bg-1' }))
    } as unknown as import('../git-operations/git-operations-service').GitOperationsService
    const adapter = new ChannelMcpAdapter({ projectId: 'repo-1', repoRoot: 'repo', navigation: bindProjectNavigation(createNavigation(), 'repo'), continuum, gitOperations })
    expect(adapter.listTools().map(t => t.name)).toContain('bind_worktree_execution')
    expect(adapter.listTools().map(t => t.name)).toContain('revoke_worktree_execution')

    const principal = authenticatedAgentPrincipal('MCP', () => true)
    const unscoped = authorizeArtifactAgent(principal, 'repo-1', () => true)
    await adapter.callTool('publish_artifact', { rawMarkdown: '---\nname: Unscoped\nkind: TECHNICAL_SPEC\n---\nBody' }, undefined, unscoped)
    expect(continuum.publish).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), unscoped, undefined)

    const bound = await adapter.callTool('bind_worktree_execution', { worktreeId, planArtifactId: 'artifact-plan-1' }, undefined, unscoped)
    expect(bound.isError).toBeUndefined()
    expect(continuum.bootstrapExecution).toHaveBeenCalledWith(expect.objectContaining({ planArtifactId: 'artifact-plan-1', scopeKind: 'REMOTE_DELEGATED', activate: true }), expect.any(Function))
    expect(gitOperations.deliverySnapshot).not.toHaveBeenCalled()

    const otherWorktree = authorizeArtifactAgent(principal, 'repo-1', () => true, 'c'.repeat(64))
    const conflict = await adapter.callTool('bind_worktree_execution', { worktreeId, planArtifactId: 'artifact-plan-1' }, undefined, otherWorktree)
    expect(conflict.isError).toBe(true)
    expect(textContent(conflict.content[0])).toBe('DELIVERY_CONTEXT_CONFLICT')

    const revoked = await adapter.callTool('revoke_worktree_execution', { worktreeId, status: 'CLOSED', reason: 'finished' }, undefined, unscoped)
    expect(revoked.isError).toBeUndefined()
    expect(continuum.revokeExecutionActivation).toHaveBeenCalledWith(expect.objectContaining({ worktreeId, status: 'CLOSED', reason: 'finished' }))
  })
})
