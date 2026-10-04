import { describe, expect, it, vi } from 'vitest'
import type { CompressionPort } from '../compression-port'
import { CodeMapService } from '../code-map-service'
import { createCodeMapSystemFixture } from '../codemap-system-fixture'
import { WatcherService } from '../watcher-service'
import { ContextNavigationError } from '../../../shared/types/context-navigation-types'
import { createFullTargetId, parseCodeTargetId, projectFullTarget } from './code-target'
import { ContextEngine } from './context-engine'
import { serializeDiscovery, serializeInspectFiles, serializeReadCode, serializeReferences, serializeSymbolDependencies, serializeRelationships, serializeSymbolHierarchy } from './context-navigation-serializer'
import { getCanonicalTokenizer } from '../tokenizer'
import { ActiveProjectService } from '../active-project-service'
import { bindProjectNavigation } from './project-context-navigation'
import { McpLifecycle } from '../../mcp/mcp-lifecycle'
import type { McpToolResult } from '../../mcp/context-navigation-mcp-adapter'
import { createLocalGateway, MemoryInstallationRegistry } from '../../../../infra/gateway/testing/local-gateway'
import { provisionCanonicalRelayIdentity } from '../../../../infra/gateway/testing/canonical-relay-identity-fixture'
import { type UserId } from '../../../shared/distribution/relay-protocol'
import { RelayTransport } from '../../mcp/connection/relay-transport'
import { ConnectionLifecycle } from '../../mcp/connection/connection-lifecycle'
import { CodeScopeHealthMonitor, type CodeScopeTraceEvent } from '../../mcp/code-scope-health'

const unusedCompression: CompressionPort = {
  async generateCompressionMarkdown() {
    throw new Error('unused')
  }
}

describe('Context Navigation system acceptance', () => {
  it('preserves local navigation results through authenticated outbound relay without persisting context', async () => {
    const fixture = createCodeMapSystemFixture()
    const second = createCodeMapSystemFixture()
    const watcher = new WatcherService()
    const codeMap = new CodeMapService(watcher, unusedCompression)
    const engine = new ContextEngine(codeMap)
    const projects = new ActiveProjectService(codeMap)
    const health = new CodeScopeHealthMonitor()
    const traceEvents: CodeScopeTraceEvent[] = []
    const trace = { record: (event: CodeScopeTraceEvent) => { traceEvents.push(event); health.record(event) } }
    const mcp = new McpLifecycle({ log: () => {}, trace })
    const registry = new MemoryInstallationRegistry()
    const owner = 'relay-proof-user' as UserId
    const externalIdentity = { issuer: 'https://test.cloudflareaccess.com', subject: 'relay-proof-subject' }
    const gateway = await createLocalGateway(registry, { async verify(assertion) { if (assertion !== 'test-access-assertion') throw new Error(); return externalIdentity } })
    const identity = await provisionCanonicalRelayIdentity({
      identityResolver: gateway.resolver,
      installationRegistry: registry,
      externalIdentity,
      canonicalUserId: owner,
      credential: 'x'.repeat(43)
    })
    const connection = new ConnectionLifecycle(mcp, new RelayTransport(gateway.endpoint, { getId: () => identity.installationId, getCredential: () => identity.credential }, 30_000, 25_000, trace), () => ({}), () => {})
    projects.onBeforeChange(() => mcp.quiesce())
    projects.onChanged(({ project }) => project ? mcp.activate(project.id, bindProjectNavigation(engine, project.path)) : mcp.deactivate())
    async function call(endpoint: string, method: string, params: unknown) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': 'test-access-assertion' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) })
      expect(response.status).toBe(200)
      return await response.json() as { result: McpToolResult & { tools?: unknown[] } }
    }
    try {
      await connection.setIntent(true)
      await codeMap.openRepository(fixture.repoPath)
      await codeMap.awaitMaintenance(fixture.repoPath)
      await codeMap.indexRepository(fixture.repoPath)
      await projects.activate(codeMap.getOpenProjects()[0].id)
      await vi.waitFor(() => expect(connection.getState().status).toBe('CONNECTED'))
      const local = mcp.getState()
      if (local.status !== 'RUNNING') throw new Error('MCP unavailable')
      const before = JSON.stringify(await registry.listOwned(owner))
      for (const [method, params] of [['initialize', {}], ['tools/list', {}], ['tools/call', { name: 'discover_repository', arguments: {} }]] as const) {
        expect(await call(gateway.endpoint, method, params)).toEqual(await call(local.endpoint, method, params))
      }
      const listed = await call(gateway.endpoint, 'tools/list', {})
      expect((listed.result.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
        'discover_repository', 'get_relationships', 'inspect_files', 'get_references', 'get_symbol_dependencies', 'get_symbol_hierarchy', 'read_code', 'get_system_health', 'get_runtime_identity'
      ])
      const discover = await call(gateway.endpoint, 'tools/call', { name: 'discover_repository', arguments: {} })
      expect(discover.result.content[0].text).toBe(serializeDiscovery(await engine.discoverRepository(fixture.repoPath)))
      expect(health.getState()).toMatchObject({ status: 'OPERATIONAL', lastSuccessfulToolCall: 'discover_repository' })
      const discoverTrace = traceEvents.filter((event) => event.tool === 'discover_repository')
      const correlated = discoverTrace.filter((event) => event.requestId === discoverTrace.at(-1)?.requestId)
      expect(correlated.map((event) => event.stage)).toEqual(expect.arrayContaining([
        'relay-request-received',
        'bridge-forward-started',
        'mcp-request-received',
        'mcp-dispatch-started',
        'codescope-handler-started',
        'codescope-handler-completed',
        'mcp-response-sent',
        'bridge-response-received',
        'relay-response-forwarded'
      ]))
      expect(new Set(correlated.map((event) => event.sessionId)).size).toBe(1)
      const inspectArgs = { name: 'inspect_files', arguments: { relativePaths: ['src/core/BaseService.ts'] } }
      const inspected = await call(gateway.endpoint, 'tools/call', inspectArgs)
      expect(inspected).toEqual(await call(local.endpoint, 'tools/call', inspectArgs))
      const scope = await engine.inspectFiles(fixture.repoPath, ['src/core/BaseService.ts'])
      const target = scope.files[0].elements.find((element) => element.target)!.target!
      const exactReads = vi.spyOn(codeMap, 'getElementExactSources')
      const userScope = await engine.inspectFiles(fixture.repoPath, ['src/core/UserService.ts'])
      const userTarget = userScope.files[0].elements.find((element) => element.name === 'UserService')!.target!
      const hierarchyArgs = { name: 'get_symbol_hierarchy', arguments: { targetIds: [userTarget] } }
      const hierarchy = await call(gateway.endpoint, 'tools/call', hierarchyArgs)
      expect(hierarchy).toEqual(await call(local.endpoint, 'tools/call', hierarchyArgs))
      const coreHierarchy = await engine.getSymbolHierarchy(fixture.repoPath, [userTarget])
      expect(hierarchy.result.content).toEqual([{ type: 'text', text: serializeSymbolHierarchy(coreHierarchy) }])
      expect(coreHierarchy.targets[0].up).toEqual([{ kind: 'extends', target, relativePath: 'src/core/BaseService.ts' }])
      expect(exactReads).not.toHaveBeenCalled()
      const referenceArgs = { name: 'get_references', arguments: { targetIds: [target] } }
      const references = await call(gateway.endpoint, 'tools/call', referenceArgs)
      expect(references).toEqual(await call(local.endpoint, 'tools/call', referenceArgs))
      expect(references.result.content[0].text).toBe(serializeReferences(await engine.getReferences(fixture.repoPath, [target])))
      expect(references.result.content[0].text).toContain(userTarget)
      expect(exactReads).not.toHaveBeenCalled()

      const appScope = await engine.inspectFiles(fixture.repoPath, ['src/renderer/App.tsx'])
      const appTarget = appScope.files[0].elements.find((element) => element.name === 'App')!.target!
      const dependencyArgs = { name: 'get_symbol_dependencies', arguments: { sourceTargetIds: [appTarget] } }
      const dependencies = await call(gateway.endpoint, 'tools/call', dependencyArgs)
      expect(dependencies).toEqual(await call(local.endpoint, 'tools/call', dependencyArgs))
      const coreDependencies = await engine.getSymbolDependencies(fixture.repoPath, [appTarget])
      expect(dependencies.result.content).toEqual([{ type: 'text', text: serializeSymbolDependencies(coreDependencies) }])
      expect(exactReads).not.toHaveBeenCalled()
      const dependencyTarget = coreDependencies.sources[0].dependencies[0].target
      const inboundArgs = { name: 'get_references', arguments: { targetIds: [dependencyTarget] } }
      const inbound = await call(gateway.endpoint, 'tools/call', inboundArgs)
      expect(inbound.result.content[0].text).toBe(serializeReferences(await engine.getReferences(fixture.repoPath, [dependencyTarget])))
      expect(inbound.result.content[0].text).toContain(appTarget)
      expect(exactReads).not.toHaveBeenCalled()
      const dependencyRead = await call(gateway.endpoint, 'tools/call', { name: 'read_code', arguments: { targetIds: [dependencyTarget] } })
      expect(dependencyRead.result.content[0].text).toBe(serializeReadCode((await engine.readCode(fixture.repoPath, [dependencyTarget]))[0]))
      expect(exactReads).toHaveBeenCalledTimes(2)
      for (const targetId of [target, 'target:missing:full']) {
        const args = { name: 'read_code', arguments: { targetIds: [targetId] } }
        expect(await call(gateway.endpoint, 'tools/call', args)).toEqual(await call(local.endpoint, 'tools/call', args))
      }
      expect(JSON.stringify(await registry.listOwned(owner))).toBe(before)
      const { writeFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      writeFileSync(join(second.repoPath, 'only-project-b.ts'), 'export const onlyB = true\n')
      await codeMap.openRepository(second.repoPath)
      await codeMap.awaitMaintenance(second.repoPath)
      await codeMap.indexRepository(second.repoPath)
      const projectB = codeMap.getOpenProjects().find((entry) => entry.path === second.repoPath.replace(/\\/g, '/'))!
      await projects.activate(projectB.id)
      await vi.waitFor(() => expect(connection.getState()).toMatchObject({ status: 'CONNECTED', projectId: projectB.id }))
      const discoverB = await call(gateway.endpoint, 'tools/call', { name: 'discover_repository', arguments: {} })
      expect(discoverB.result.content[0].text).toBe(serializeDiscovery(await engine.discoverRepository(second.repoPath)))
      await projects.activate(null)
      expect(connection.getState().status).toBe('DISCONNECTED')
      expect(await gateway.directory.isOnline(identity.installationId)).toBe(false)
      await projects.activate(local.projectId)
      await vi.waitFor(() => expect(connection.getState()).toMatchObject({ status: 'CONNECTED', projectId: local.projectId }))
      const restored = await call(gateway.endpoint, 'tools/call', { name: 'discover_repository', arguments: {} })
      expect(restored.result.content[0].text).toBe(serializeDiscovery(await engine.discoverRepository(fixture.repoPath)))
      expect(health.getState()).toMatchObject({ status: 'OPERATIONAL', lastSuccessfulToolCall: 'discover_repository' })
    } finally {
      await connection.dispose(); await projects.dispose(); await mcp.dispose(); await gateway.close()
      codeMap.closeAll(); watcher.stop(); await fixture.cleanup(); await second.cleanup()
    }
  }, 120_000)

  it('proves live Cloudflare Access + Workers + Durable Objects + D1 relay', async () => {
    if (process.env.CODE_AWARENESS_RUN_CLOUD_TESTS !== '1') return
    const fs = await import('node:fs')
    const path = await import('node:path')
    const installFile = path.resolve(process.cwd(), '.cloud_test_installation.json')
    const token = process.env.CODE_AWARENESS_CLOUDFLARE_ACCESS_TOKEN?.trim()
    if (!token || !fs.existsSync(installFile)) return

    const { installationId, credential } = JSON.parse(fs.readFileSync(installFile, 'utf-8'))
    const gatewayEndpoint = 'https://code-awareness-gateway.eric-rocha.workers.dev/mcp'

    const fixture = createCodeMapSystemFixture()
    const watcher = new WatcherService()
    const codeMap = new CodeMapService(watcher, unusedCompression)
    const engine = new ContextEngine(codeMap)
    const projects = new ActiveProjectService(codeMap)
    const mcp = new McpLifecycle({ log: () => {} })

    const relayTransport = new RelayTransport(gatewayEndpoint, {
      getId: () => installationId,
      getCredential: () => credential
    })
    const connection = new ConnectionLifecycle(mcp, relayTransport, () => ({}), () => {})

    projects.onBeforeChange(() => mcp.quiesce())
    projects.onChanged(({ project }) =>
      project ? mcp.activate(project.id, bindProjectNavigation(engine, project.path)) : mcp.deactivate()
    )

    async function callCloud(method: string, params: unknown, customToken = token, customInstallation: string = installationId) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${customToken}`
      }
      if (customInstallation) {
        headers['x-code-awareness-installation'] = customInstallation
      }
      const t0 = performance.now()
      const response = await fetch(gatewayEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 42, method, params })
      })
      const latencyMs = Math.round(performance.now() - t0)
      return { status: response.status, data: await response.json().catch(() => null), latencyMs, cacheStatus: response.headers.get('cf-cache-status') }
    }

    try {
      await codeMap.openRepository(fixture.repoPath)
      await codeMap.awaitMaintenance(fixture.repoPath)
      await codeMap.indexRepository(fixture.repoPath)
      const openProj = codeMap.getOpenProjects()[0]
      await projects.activate(openProj.id)

      const localMcp = mcp.getState()
      expect(localMcp.status).toBe('RUNNING')

      // 1. Outbound relay connection to Cloudflare Durable Object
      const connectResult = await connection.connect()
      expect(connectResult.success).toBe(true)
      expect(connection.getState().status).toBe('CONNECTED')

      // 2. Initialize via Cloudflare Gateway
      const initRes = await callCloud('initialize', {})
      console.log('[Perf] Cloud initialize:', initRes.latencyMs, 'ms')
      expect(initRes.status).toBe(200)
      expect(initRes.data.result.serverInfo.name).toBe('code-awareness-context-navigation')

      // 3. Tools list via Cloudflare Gateway
      const toolsRes = await callCloud('tools/list', {})
      console.log('[Perf] Cloud tools/list:', toolsRes.latencyMs, 'ms')
      expect(toolsRes.status).toBe(200)
      const toolNames = toolsRes.data.result.tools.map((t: any) => t.name)
      console.log('[Cloud catalog]', { toolNames, cacheStatus: toolsRes.cacheStatus })
      expect(toolNames).toEqual(['discover_repository', 'get_relationships', 'inspect_files', 'get_references', 'get_symbol_dependencies', 'get_symbol_hierarchy', 'read_code', 'get_system_health'])

      // 4. Ping via Cloudflare Gateway
      const pingRes = await callCloud('tools/call', { name: 'discover_repository', arguments: {} })
      console.log('[Perf] Cloud ping:', pingRes.latencyMs, 'ms')
      expect(pingRes.status).toBe(200)
      expect(pingRes.data.result.content[0].text).toBe(serializeDiscovery(await engine.discoverRepository(fixture.repoPath)))

      // 5. Context Navigation: discover_repository via Cloudflare Gateway
      const discoverRes = await callCloud('tools/call', { name: 'discover_repository', arguments: {} })
      console.log('[Perf] Cloud discover_repository:', discoverRes.latencyMs, 'ms')
      expect(discoverRes.status).toBe(200)
      expect(discoverRes.data.result.content[0].text).toBe(serializeDiscovery(await engine.discoverRepository(fixture.repoPath)))

      // 6. Context Navigation: inspect_files via Cloudflare Gateway
      const inspectRes = await callCloud('tools/call', {
        name: 'inspect_files',
        arguments: { relativePaths: ['src/core/BaseService.ts'] }
      })
      console.log('[Perf] Cloud inspect_files:', inspectRes.latencyMs, 'ms')
      expect(inspectRes.status).toBe(200)
      expect(inspectRes.data.result.content[0].text).toBe(serializeInspectFiles(await engine.inspectFiles(fixture.repoPath, ['src/core/BaseService.ts'])))

      // 7. Context Navigation: read_code via Cloudflare Gateway
      const scope = await engine.inspectFiles(fixture.repoPath, ['src/core/BaseService.ts'])
      const targetId = scope.files[0].elements.find((e) => e.target)!.target!
      const readRes = await callCloud('tools/call', {
        name: 'read_code',
        arguments: { targetIds: [targetId] }
      })
      console.log('[Perf] Cloud read_code:', readRes.latencyMs, 'ms')
      expect(readRes.status).toBe(200)
      expect(readRes.data.result.content[0].text).toBe(serializeReadCode((await engine.readCode(fixture.repoPath, [targetId]))[0]))

      const referencesRes = await callCloud('tools/call', {
        name: 'get_references',
        arguments: { targetIds: [targetId] }
      })
      console.log('[Perf] Cloud get_references:', referencesRes.latencyMs, 'ms')
      expect(referencesRes.status).toBe(200)
      expect(referencesRes.data.result.content).toEqual([{ type: 'text', text: serializeReferences(await engine.getReferences(fixture.repoPath, [targetId])) }])

      const appScope = await engine.inspectFiles(fixture.repoPath, ['src/renderer/App.tsx'])
      const appTarget = appScope.files[0].elements.find((element) => element.name === 'App')!.target!
      const dependenciesRes = await callCloud('tools/call', {
        name: 'get_symbol_dependencies',
        arguments: { sourceTargetIds: [appTarget] }
      })
      console.log('[Perf] Cloud get_symbol_dependencies:', dependenciesRes.latencyMs, 'ms')
      expect(dependenciesRes.status).toBe(200)
      const coreDependencies = await engine.getSymbolDependencies(fixture.repoPath, [appTarget])
      expect(dependenciesRes.data.result.content).toEqual([{ type: 'text', text: serializeSymbolDependencies(coreDependencies) }])
      const dependencyTarget = coreDependencies.sources[0].dependencies[0].target
      const dependencyReferences = await callCloud('tools/call', {
        name: 'get_references',
        arguments: { targetIds: [dependencyTarget] }
      })
      expect(dependencyReferences.status).toBe(200)
      expect(dependencyReferences.data.result.content[0].text).toContain(appTarget)

      const userScope = await engine.inspectFiles(fixture.repoPath, ['src/core/UserService.ts'])
      const userTarget = userScope.files[0].elements.find((element) => element.name === 'UserService')!.target!
      const hierarchyRes = await callCloud('tools/call', {
        name: 'get_symbol_hierarchy',
        arguments: { targetIds: [userTarget] }
      })
      console.log('[Perf] Cloud get_symbol_hierarchy:', hierarchyRes.latencyMs, 'ms')
      expect(hierarchyRes.status).toBe(200)
      const coreHierarchy = await engine.getSymbolHierarchy(fixture.repoPath, [userTarget])
      expect(hierarchyRes.data.result.content).toEqual([{ type: 'text', text: serializeSymbolHierarchy(coreHierarchy) }])
      const baseTarget = coreHierarchy.targets[0].up![0].target
      const hierarchyReferences = await callCloud('tools/call', {
        name: 'get_references',
        arguments: { targetIds: [baseTarget] }
      })
      expect(hierarchyReferences.status).toBe(200)
      expect(hierarchyReferences.data.result.content[0].text).toContain(userTarget)

      // 8. Cross-user isolation: attempting with non-owned installationId
      const crossRes = await callCloud('tools/call', { name: 'discover_repository', arguments: {} }, token, '00000000-0000-4000-8000-000000000000')
      expect(crossRes.status).toBe(403)
      expect(crossRes.data.code).toBe('FORBIDDEN')

      // 9. Reconnect and safe offline failure
      await connection.disconnect()
      expect(connection.getState().status).toBe('DISCONNECTED')

      const offlineRes = await callCloud('tools/call', { name: 'discover_repository', arguments: {} })
      expect(offlineRes.status).toBe(503)
      expect(offlineRes.data.code).toBe('INSTALLATION_OFFLINE')

      const reconnected = await connection.connect()
      expect(reconnected.success).toBe(true)
      expect(connection.getState().status).toBe('CONNECTED')

      const pingAfterReconnect = await callCloud('tools/call', { name: 'discover_repository', arguments: {} })
      expect(pingAfterReconnect.status).toBe(200)
    } finally {
      await connection.dispose()
      await projects.dispose()
      await mcp.dispose()
      codeMap.closeAll()
      watcher.stop()
      await fixture.cleanup()
    }
  }, 120_000)

  it('shares the existing CodeMap and ContextEngine with the active-project MCP', async () => {
    const fixture = createCodeMapSystemFixture()
    const watcher = new WatcherService()
    const codeMap = new CodeMapService(watcher, unusedCompression)
    const engine = new ContextEngine(codeMap)
    const projects = new ActiveProjectService(codeMap)
    const mcp = new McpLifecycle({ log: () => {} })
    projects.onChanged(({ project }) => project
      ? mcp.activate(project.id, bindProjectNavigation(engine, project.path))
      : mcp.deactivate())
    try {
      await codeMap.openRepository(fixture.repoPath)
      await codeMap.awaitMaintenance(fixture.repoPath)
      await codeMap.indexRepository(fixture.repoPath)
      const project = codeMap.getOpenProjects().find((entry) => entry.path === fixture.repoPath.replace(/\\/g, '/'))!
      expect(project.id).toBe(codeMap.getRepository(fixture.repoPath)!.id)
      expect(projects.getState().project).toBeNull()
      expect(mcp.getState().status).toBe('STOPPED')
      await projects.activate(project.id)
      const running = mcp.getState()
      if (running.status !== 'RUNNING') throw new Error('MCP did not start')
      const response = await fetch(running.endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'discover_repository', arguments: {} } })
      })
      const result = (await response.json() as { result: McpToolResult }).result.content[0].text
      expect(result).toBe(serializeDiscovery(await engine.discoverRepository(fixture.repoPath)))
      expect(codeMap.getOpenProjects().filter((entry) => entry.id === project.id)).toHaveLength(1)
      await projects.closeRepository(project.path)
      expect(projects.getState().project).toBeNull()
      expect(mcp.getState().status).toBe('STOPPED')
      expect(codeMap.getOpenProjects().some((entry) => entry.id === project.id)).toBe(false)
      await expect(fetch(running.endpoint)).rejects.toThrow()
    } finally {
      await projects.dispose()
      await mcp.dispose()
      codeMap.closeAll()
      watcher.stop()
      await fixture.cleanup()
    }
  }, 120_000)

  it('projects deterministic full targets only for retrievable elements', () => {
    const location = {
      start: { line: 1, column: 0, byte: 0 },
      end: { line: 1, column: 10, byte: 10 }
    }
    const element = {
      id: '0123456789abcdef', repositoryId: 'repo', fileId: 'file', kind: 'function' as const, name: 'run',
      parentElementId: null, location, sizeLines: 1, sizeBytes: 10, visibility: null, modifiers: [],
      returnType: null, baseClass: null, hasDocumentation: false, parameterCount: 0,
      granularity: 'structural' as const, retrievable: true
    }
    const first = projectFullTarget(element)
    expect(projectFullTarget(element)).toEqual(first)
    expect(first).toBe('t:ASNFZ4mrze8')
    expect(parseCodeTargetId(first!)).toEqual({ elementId: element.id, kind: 'full' })
    expect(projectFullTarget({ ...element, retrievable: false })).toBeUndefined()
  })

  it('queries persisted local, aliased, instantiation and type references without reading source', async () => {
    const fixture = createCodeMapSystemFixture()
    fixture.write('src/reference-service.ts', 'export class Service {}\n')
    fixture.write('src/reference-types.ts', 'export interface ServiceConfig { enabled: boolean }\n')
    fixture.write('src/reference-app.ts', [
      "import { Service as DataService } from './reference-service'",
      "import type { ServiceConfig } from './reference-types'",
      'export function createService(config: ServiceConfig): DataService {',
      '  return new DataService()',
      '}',
      'export function localRun(): number { return 1 }',
      'export function invokeLocal(): number { return localRun() }',
      ''
    ].join('\n'))
    fixture.write('src/reference-member.ts', [
      'export class MemberService {',
      '  start() { this.execute(); this.execute() }',
      '  execute() {}',
      '}',
      ''
    ].join('\n'))
    fixture.write('src/reference-parameter.ts', [
      "import { MemberService as Service } from './reference-member'",
      'export function invokeMember(service: Service) { service.execute(); service.execute() }',
      ''
    ].join('\n'))
    fixture.write('src/reference-const.ts', [
      "import { MemberService as ConstructedService } from './reference-member'",
      'export function invokeConstructed() { const service = new ConstructedService(); service.execute(); service.execute() }',
      ''
    ].join('\n'))
    fixture.write('src/reference-property.ts', [
      "import { MemberService as PropertyService } from './reference-member'",
      'export class PropertyController { private service!: PropertyService; invoke() { this.service.execute(); this.service.execute() } }',
      ''
    ].join('\n'))
    fixture.write('src/reference-constructor-property.ts', [
      "import { MemberService as ConstructorService } from './reference-member'",
      'export class ConstructorPropertyController { constructor(private readonly service: ConstructorService) {} invoke() { this.service.execute(); this.service.execute() } }',
      ''
    ].join('\n'))
    fixture.write('src/reference-contract.ts', 'export interface ServicePort { execute(): void }\n')
    fixture.write('src/reference-contract-app.ts', [
      "import { ServicePort as Port } from './reference-contract'",
      'export function invokeContract(service: Port) { service.execute(); service.execute() }',
      ''
    ].join('\n'))
    const watcher = new WatcherService()
    const codeMap = new CodeMapService(watcher, unusedCompression)
    const engine = new ContextEngine(codeMap)
    try {
      await codeMap.openRepository(fixture.repoPath)
      await codeMap.awaitMaintenance(fixture.repoPath)
      await codeMap.indexRepository(fixture.repoPath)

      const inspected = await engine.inspectFiles(fixture.repoPath, [
        'src/reference-service.ts', 'src/reference-types.ts', 'src/reference-app.ts', 'src/reference-member.ts', 'src/reference-parameter.ts', 'src/reference-const.ts', 'src/reference-property.ts', 'src/reference-constructor-property.ts', 'src/reference-contract.ts', 'src/reference-contract-app.ts'
      ])
      const serviceTarget = inspected.files[0].elements.find((element) => element.name === 'Service')!.target!
      const configTarget = inspected.files[1].elements.find((element) => element.name === 'ServiceConfig')!.target!
      const localTarget = inspected.files[2].elements.find((element) => element.name === 'localRun')!.target!
      const memberClass = inspected.files[3].elements.find((element) => element.name === 'MemberService')!
      const startTarget = memberClass.children!.find((element) => element.name === 'start')!.target!
      const executeTarget = memberClass.children!.find((element) => element.name === 'execute')!.target!
      const invokeMemberTarget = inspected.files[4].elements.find((element) => element.name === 'invokeMember')!.target!
      const invokeConstructedTarget = inspected.files[5].elements.find((element) => element.name === 'invokeConstructed')!.target!
      const propertyController = inspected.files[6].elements.find((element) => element.name === 'PropertyController')!
      const propertyInvokeTarget = propertyController.children!.find((element) => element.name === 'invoke')!.target!
      const constructorPropertyController = inspected.files[7].elements.find((element) => element.name === 'ConstructorPropertyController')!
      const constructorPropertyInvokeTarget = constructorPropertyController.children!.find((element) => element.name === 'invoke')!.target!
      const contract = inspected.files[8].elements.find((element) => element.name === 'ServicePort')!
      const contractExecuteTarget = contract.children!.find((element) => element.name === 'execute')!.target!
      const invokeContractTarget = inspected.files[9].elements.find((element) => element.name === 'invokeContract')!.target!
      const exactReads = vi.spyOn(codeMap, 'getElementExactSources')

      const service = await engine.getReferences(fixture.repoPath, [serviceTarget])
      expect(service.targets[0].references).toEqual([
        expect.objectContaining({ relativePath: 'src/reference-app.ts', line: 3, kind: 'type' }),
        expect.objectContaining({ relativePath: 'src/reference-app.ts', line: 4, kind: 'instantiation' })
      ])
      expect(service.targets[0].references.every((reference) => reference.sourceTarget)).toBe(true)
      expect(JSON.stringify(service)).not.toContain('DataService')

      const local = await engine.getReferences(fixture.repoPath, [localTarget])
      expect(local.targets[0].references).toEqual([
        expect.objectContaining({ relativePath: 'src/reference-app.ts', line: 7, kind: 'call' })
      ])

      const batch = await engine.getReferences(fixture.repoPath, [configTarget, serviceTarget])
      expect(batch.targets.map((entry) => entry.target)).toEqual([configTarget, serviceTarget])
      expect(batch.targets[0].references).toEqual([
        expect.objectContaining({ relativePath: 'src/reference-app.ts', line: 3, kind: 'type' })
      ])

      const sourceTarget = service.targets[0].references[0].sourceTarget!
      const outbound = await engine.getSymbolDependencies(fixture.repoPath, [sourceTarget])
      expect(outbound.sources[0].dependencies).toEqual([
        { relativePath: 'src/reference-service.ts', kind: 'instantiation', target: serviceTarget },
        { relativePath: 'src/reference-service.ts', kind: 'type', target: serviceTarget },
        { relativePath: 'src/reference-types.ts', kind: 'type', target: configTarget }
      ])
      expect(serializeSymbolDependencies(outbound)).not.toMatch(/sourceFileId|sourceElementId|targetElementId|repositoryId|startByte|line|column|function createService/)
      expect(exactReads).not.toHaveBeenCalled()

      const memberInbound = await engine.getReferences(fixture.repoPath, [executeTarget])
      expect(memberInbound.targets[0].references).toEqual([
        { relativePath: 'src/reference-const.ts', line: 2, kind: 'call', sourceTarget: invokeConstructedTarget },
        { relativePath: 'src/reference-const.ts', line: 2, kind: 'call', sourceTarget: invokeConstructedTarget },
        { relativePath: 'src/reference-constructor-property.ts', line: 2, kind: 'call', sourceTarget: constructorPropertyInvokeTarget },
        { relativePath: 'src/reference-constructor-property.ts', line: 2, kind: 'call', sourceTarget: constructorPropertyInvokeTarget },
        { relativePath: 'src/reference-member.ts', line: 2, kind: 'call', sourceTarget: startTarget },
        { relativePath: 'src/reference-member.ts', line: 2, kind: 'call', sourceTarget: startTarget },
        { relativePath: 'src/reference-parameter.ts', line: 2, kind: 'call', sourceTarget: invokeMemberTarget },
        { relativePath: 'src/reference-parameter.ts', line: 2, kind: 'call', sourceTarget: invokeMemberTarget },
        { relativePath: 'src/reference-property.ts', line: 2, kind: 'call', sourceTarget: propertyInvokeTarget },
        { relativePath: 'src/reference-property.ts', line: 2, kind: 'call', sourceTarget: propertyInvokeTarget }
      ])
      const memberOutbound = await engine.getSymbolDependencies(fixture.repoPath, [startTarget])
      expect(memberOutbound.sources[0].dependencies).toEqual([
        { relativePath: 'src/reference-member.ts', kind: 'call', target: executeTarget }
      ])
      const parameterOutbound = await engine.getSymbolDependencies(fixture.repoPath, [invokeMemberTarget])
      expect(parameterOutbound.sources[0].dependencies).toEqual([
        { relativePath: 'src/reference-member.ts', kind: 'call', target: executeTarget },
        { relativePath: 'src/reference-member.ts', kind: 'type', target: memberClass.target }
      ])
      const constOutbound = await engine.getSymbolDependencies(fixture.repoPath, [invokeConstructedTarget])
      expect(constOutbound.sources[0].dependencies).toEqual([
        { relativePath: 'src/reference-member.ts', kind: 'call', target: executeTarget }
      ])
      const propertyOutbound = await engine.getSymbolDependencies(fixture.repoPath, [propertyInvokeTarget])
      expect(propertyOutbound.sources[0].dependencies).toEqual([
        { relativePath: 'src/reference-member.ts', kind: 'call', target: executeTarget }
      ])
      const constructorPropertyOutbound = await engine.getSymbolDependencies(fixture.repoPath, [constructorPropertyInvokeTarget])
      expect(constructorPropertyOutbound.sources[0].dependencies).toEqual([
        { relativePath: 'src/reference-member.ts', kind: 'call', target: executeTarget }
      ])
      const contractInbound = await engine.getReferences(fixture.repoPath, [contractExecuteTarget])
      expect(contractInbound.targets[0].references).toEqual([
        { relativePath: 'src/reference-contract-app.ts', line: 2, kind: 'call', sourceTarget: invokeContractTarget },
        { relativePath: 'src/reference-contract-app.ts', line: 2, kind: 'call', sourceTarget: invokeContractTarget }
      ])
      const contractOutbound = await engine.getSymbolDependencies(fixture.repoPath, [invokeContractTarget])
      expect(contractOutbound.sources[0].dependencies).toEqual([
        { relativePath: 'src/reference-contract.ts', kind: 'call', target: contractExecuteTarget },
        { relativePath: 'src/reference-contract.ts', kind: 'type', target: contract.target! }
      ])
      expect(exactReads).not.toHaveBeenCalled()

      const dependencyTargets = [...new Set(outbound.sources[0].dependencies.map((dependency) => dependency.target))]
      const dependencySources = await engine.readCode(fixture.repoPath, dependencyTargets)
      expect(dependencySources.map((entry) => entry.targetId)).toEqual(dependencyTargets)
      expect(dependencySources.map((entry) => entry.source)).toEqual(expect.arrayContaining([
        expect.stringContaining('class Service'),
        expect.stringContaining('interface ServiceConfig')
      ]))

      const [source] = await engine.readCode(fixture.repoPath, [sourceTarget])
      expect(source.source).toContain('function createService')
      expect(exactReads).toHaveBeenCalledTimes(2)

      const serialized = serializeReferences(service)
      expect(serialized).not.toMatch(/sourceFileId|sourceElementId|targetElementId|repositoryId|startByte|column|DataService\(\)|function createService/)
    } finally {
      codeMap.closeAll()
      watcher.stop()
      await fixture.cleanup()
    }
  }, 120_000)

  it('projects persisted direct extends and implements hierarchy without expanding files or reading source', async () => {
    const fixture = createCodeMapSystemFixture()
    fixture.write('src/hierarchy-base.ts', 'export class BaseService {}\nexport class UnrelatedBase {}\n')
    fixture.write('src/hierarchy-ports.ts', [
      'export interface ServicePort { execute(): void }',
      'export interface AuditPort { audit(): void }',
      'export interface ChildPort extends ServicePort { child(): void }',
      'export interface UnrelatedPort { noop(): void }',
      ''
    ].join('\n'))
    fixture.write('src/hierarchy-service.ts', [
      "import { BaseService } from './hierarchy-base'",
      "import type { ServicePort, AuditPort } from './hierarchy-ports'",
      'export class Service extends BaseService implements ServicePort, AuditPort {',
      '  execute(): void {}',
      '  audit(): void {}',
      '}',
      ''
    ].join('\n'))
    fixture.write('src/hierarchy-cached.ts', [
      "import type { ServicePort } from './hierarchy-ports'",
      'export class CachedService implements ServicePort { execute(): void {} }',
      ''
    ].join('\n'))
    fixture.write('src/hierarchy-empty.ts', 'export class EmptyService {}\nexport class UnresolvedService extends MissingService {}\n')
    fixture.write('src/hierarchy-js-base.js', 'export class JavaScriptBase {}\n')
    fixture.write('src/hierarchy-js-child.js', "import { JavaScriptBase } from './hierarchy-js-base.js'\nexport class JavaScriptChild extends JavaScriptBase {}\n")
    const watcher = new WatcherService()
    const codeMap = new CodeMapService(watcher, unusedCompression)
    const engine = new ContextEngine(codeMap)
    try {
      await codeMap.openRepository(fixture.repoPath)
      await codeMap.awaitMaintenance(fixture.repoPath)
      await codeMap.indexRepository(fixture.repoPath)

      const inspected = await engine.inspectFiles(fixture.repoPath, [
        'src/hierarchy-base.ts', 'src/hierarchy-ports.ts', 'src/hierarchy-service.ts',
        'src/hierarchy-cached.ts', 'src/hierarchy-empty.ts', 'src/hierarchy-js-base.js', 'src/hierarchy-js-child.js'
      ])
      const find = (fileIndex: number, name: string) => inspected.files[fileIndex].elements.find((element) => element.name === name)!.target!
      const base = find(0, 'BaseService')
      const port = find(1, 'ServicePort')
      const audit = find(1, 'AuditPort')
      const childPort = find(1, 'ChildPort')
      const service = find(2, 'Service')
      const cached = find(3, 'CachedService')
      const empty = find(4, 'EmptyService')
      const unresolved = find(4, 'UnresolvedService')
      const jsBase = find(5, 'JavaScriptBase')
      const jsChild = find(6, 'JavaScriptChild')
      const exactReads = vi.spyOn(codeMap, 'getElementExactSources')
      const broadRelationships = vi.spyOn(codeMap, 'getRelationships')

      const serviceBoth = await engine.getSymbolHierarchy(fixture.repoPath, [service])
      const implementedContracts = [audit, port].sort((left, right) => left.localeCompare(right))
      expect(serviceBoth.targets[0]).toEqual({ target: service, up: [
        { kind: 'extends', target: base, relativePath: 'src/hierarchy-base.ts' },
        { kind: 'implements', target: implementedContracts[0], relativePath: 'src/hierarchy-ports.ts' },
        { kind: 'implements', target: implementedContracts[1], relativePath: 'src/hierarchy-ports.ts' }
      ], down: [] })
      expect((await engine.getSymbolHierarchy(fixture.repoPath, [base], { direction: 'down' })).targets[0].down).toEqual([
        { kind: 'extends', target: service, relativePath: 'src/hierarchy-service.ts' }
      ])
      expect((await engine.getSymbolHierarchy(fixture.repoPath, [port], { direction: 'down' })).targets[0].down).toEqual([
        { kind: 'implements', target: cached, relativePath: 'src/hierarchy-cached.ts' },
        { kind: 'implements', target: service, relativePath: 'src/hierarchy-service.ts' }
      ])
      expect((await engine.getSymbolHierarchy(fixture.repoPath, [jsChild], { direction: 'up' })).targets[0].up).toEqual([])
      expect((await engine.getSymbolHierarchy(fixture.repoPath, [jsBase], { direction: 'down' })).targets[0].down).toEqual([])
      expect((await engine.getSymbolHierarchy(fixture.repoPath, [childPort], { direction: 'up' })).targets[0].up).toEqual([])
      const emptyBatch = await engine.getSymbolHierarchy(fixture.repoPath, [empty, unresolved])
      expect(serializeSymbolHierarchy(emptyBatch)).toBe(`[${empty}]\n\nNONE\n\n[${unresolved}]\n\nNONE`)
      expect(exactReads).not.toHaveBeenCalled()
      expect(broadRelationships).not.toHaveBeenCalled()

      const serviceDependencies = await engine.getSymbolDependencies(fixture.repoPath, [service])
      expect(serviceDependencies.sources[0].source).toBe(service)
      const baseReferences = await engine.getReferences(fixture.repoPath, [base])
      expect(baseReferences.targets[0].target).toBe(base)
      expect((await engine.getSymbolHierarchy(fixture.repoPath, [service], { direction: 'up' })).targets[0].up?.map((relation) => relation.target)).toContain(base)
      const relatedSources = await engine.readCode(fixture.repoPath, [base, port, cached])
      expect(relatedSources.map((entry) => entry.targetId)).toEqual([base, port, cached])
      expect(relatedSources.map((entry) => entry.source)).toEqual(expect.arrayContaining([
        expect.stringContaining('class BaseService'),
        expect.stringContaining('interface ServicePort'),
        expect.stringContaining('class CachedService')
      ]))

      const hierarchyText = serializeSymbolHierarchy(serviceBoth)
      const fileExpansionText = serializeRelationships(await engine.getRelationships(fixture.repoPath, ['src/hierarchy-service.ts'])) + '\n' +
        serializeInspectFiles(await engine.inspectFiles(fixture.repoPath, ['src/hierarchy-base.ts', 'src/hierarchy-ports.ts']))
      const tokenizer = getCanonicalTokenizer()
      const benchmark = { hierarchyTokens: tokenizer.count(hierarchyText), fileExpansionTokens: tokenizer.count(fileExpansionText) }
      expect(benchmark.hierarchyTokens).toBeLessThan(benchmark.fileExpansionTokens)
      console.log('SYMBOL_HIERARCHY_REAL_BENCHMARK', JSON.stringify(benchmark))
    } finally {
      codeMap.closeAll()
      watcher.stop()
      await fixture.cleanup()
    }
  }, 120_000)

  it('navigates selected files and materializes only explicitly selected exact targets', async () => {
    const telemetry = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const fixture = createCodeMapSystemFixture()
    fixture.write('src/target.ts', [
      'export const SENTINELA_ANTES = "ação"',
      '',
      'function alvo(usuario: string): string {',
      '  return `TARGET_EXATO:${usuario}:日本語`',
      '}',
      '',
      'export const SENTINELA_DEPOIS = "fim"',
      '',
      'function terceiro(): string { return "C" }',
      ''
    ].join('\n'))
    const largePrefix = '// padding\n'.repeat(4_000)
    const largeTargetSource = [
      'function afterOldBufferLimit(usuario: string): string {',
      '  return `TARGET_GRANDE:${usuario}:日本語`',
      '}'
    ].join('\n')
    fixture.write('src/large-target.ts', [
      largePrefix + largeTargetSource,
      'export const LARGE_SENTINEL_AFTER = "fim"',
      ''
    ].join('\n'))
    const watcher = new WatcherService()
    const codeMap = new CodeMapService(watcher, unusedCompression)
    const engine = new ContextEngine(codeMap)
    try {
      await codeMap.openRepository(fixture.repoPath)
      await codeMap.awaitMaintenance(fixture.repoPath)
      await codeMap.indexRepository(fixture.repoPath)

      const discovery = await engine.discoverRepository(fixture.repoPath)
      expect(discovery.directories).toHaveLength(1)
      expect(discovery.directories[0].children).toContain('src/')

      const dependencies = await engine.getRelationships(fixture.repoPath, ['src/core/UserService.ts', 'src/renderer/styles.css'])
      expect(dependencies.files).toEqual([
        { relativePath: 'src/core/UserService.ts', out: [{ relativePath: 'src/core/BaseService.ts' }], in: [{ relativePath: 'src/renderer/App.tsx' }] },
        { relativePath: 'src/renderer/styles.css', out: [{ relativePath: 'src/renderer/theme.css' }], in: [{ relativePath: 'src/renderer/App.tsx' }] }
      ])

      const scope = await engine.inspectFiles(fixture.repoPath, ['src/target.ts', 'src/core/BaseService.ts'])
      expect(scope.files.map((file) => file.relativePath)).toEqual(['src/target.ts', 'src/core/BaseService.ts'])
      expect(scope.files).toHaveLength(2)
      expect(JSON.stringify(scope)).not.toContain('TARGET_EXATO')
      expect(JSON.stringify(scope)).not.toContain('src/core/UserService.ts')
      await expect(engine.inspectFiles(fixture.repoPath, ['src/unknown.ts'])).rejects.toMatchObject({
        code: 'UNKNOWN_FILE', reference: 'src/unknown.ts'
      })
      await expect(engine.inspectFiles(fixture.repoPath, ['src/target.ts', 'src/target.ts'])).rejects.toMatchObject({
        code: 'DUPLICATE_PATH'
      })

      const targetFile = scope.files[0]
      const alvo = targetFile.elements.find((element) => element.name === 'alvo' && element.kind === 'function')!
      const terceiro = targetFile.elements.find((element) => element.name === 'terceiro' && element.kind === 'function')!
      expect(targetFile.elements.every((element) => element.target === undefined || /^t:[A-Za-z0-9_-]{11}$/.test(element.target))).toBe(true)

      const expectedAlvo = [
        'function alvo(usuario: string): string {',
        '  return `TARGET_EXATO:${usuario}:日本語`',
        '}'
      ].join('\n')
      const [readAlvo] = await engine.readCode(fixture.repoPath, [alvo.target!])
      expect(readAlvo.source).toBe(expectedAlvo)
      expect(readAlvo.source).not.toContain('SENTINELA_ANTES')
      expect(readAlvo.source).not.toContain('SENTINELA_DEPOIS')
      const internalAlvo = codeMap.getElements(fixture.repoPath).find((element) => element.id === parseCodeTargetId(alvo.target!)!.elementId)!
      const legacy = 'target:' + internalAlvo.id + ':full'
      expect(await engine.readCode(fixture.repoPath, [legacy])).toEqual([readAlvo])
      expect(Buffer.from(readAlvo.source)).toEqual(Buffer.from(expectedAlvo))

      const ordered = await engine.readCode(fixture.repoPath, [terceiro.target!, alvo.target!])
      expect(ordered.map((result) => result.targetId)).toEqual([terceiro.target, alvo.target])
      expect(ordered.map((result) => result.source)).toEqual([
        'function terceiro(): string { return "C" }',
        expectedAlvo
      ])

      const [largeFile] = (await engine.inspectFiles(fixture.repoPath, ['src/large-target.ts'])).files
      const largeTarget = largeFile.elements.find((element) => element.name === 'afterOldBufferLimit')!
      expect(largeTarget).toMatchObject({ kind: 'function' })
      const internalLarge = codeMap.getElements(fixture.repoPath).find((element) => element.id === parseCodeTargetId(largeTarget.target!)!.elementId)!
      expect(internalLarge.id).toBeTruthy()
      expect(largeTarget.target).toBeDefined()
      expect(internalLarge.location.start.byte).toBe(Buffer.byteLength(largePrefix, 'utf8'))
      expect(internalLarge.location.start.byte).toBeGreaterThan(32 * 1024)
      expect(internalLarge.location.end.byte).toBe(Buffer.byteLength(largePrefix + largeTargetSource, 'utf8'))

      const [largeRead] = await engine.readCode(fixture.repoPath, [largeTarget.target!])
      expect(largeRead.source).toBe(largeTargetSource)
      expect(largeRead.source).not.toContain('LARGE_SENTINEL_AFTER')
      expect(Buffer.byteLength(largeRead.source)).toBe(internalLarge.location.end.byte - internalLarge.location.start.byte)

      await expect(engine.readCode(fixture.repoPath, ['not-a-target'])).rejects.toMatchObject({
        name: 'ContextNavigationError', code: 'INVALID_TARGET'
      })
      await expect(engine.readCode(fixture.repoPath, [createFullTargetId('0000000000000000')])).rejects.toBeInstanceOf(ContextNavigationError)
      await expect(engine.readCode(fixture.repoPath, [alvo.target!, alvo.target!])).rejects.toMatchObject({
        code: 'DUPLICATE_TARGET'
      })
      expect(targetFile.elements.some((element) => (element.kind as string) === 'export')).toBe(false)
      const exportElement = codeMap.getElements(fixture.repoPath).find((element) => element.kind === 'export')!
      expect(exportElement).not.toHaveProperty('target')
      await expect(engine.readCode(fixture.repoPath, [createFullTargetId(exportElement.id)])).rejects.toMatchObject({
        code: 'ELEMENT_NOT_RETRIEVABLE'
      })
    } finally {
      codeMap.closeAll()
      watcher.stop()
      await fixture.cleanup()
      telemetry.mockRestore()
    }
  }, 120_000)
})
