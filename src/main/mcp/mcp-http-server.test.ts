import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ContextNavigationError } from '../../shared/types/context-navigation-types'
import type { ContextNavigationPort } from '../core/context/context-navigation-port'
import { ContextNavigationMcpAdapter } from './context-navigation-mcp-adapter'
import { createMcpHttpServer, type McpOperationalLogEntry } from './mcp-http-server'

const logs: McpOperationalLogEntry[] = []
const navigation: ContextNavigationPort = {
  discoverRepository: vi.fn(async () => ({
    directories: [{ relativePath: '.', children: ['src/'] }]
  })),
  getRelationships: vi.fn(async () => ({ files: [] })),
  inspectFiles: vi.fn(async () => ({ files: [{ relativePath: 'src/a.ts', elements: [] }] })),
  readCode: vi.fn(async () => []),
  getReferences: vi.fn(async (_repoPath, targetIds) => ({ targets: targetIds.map((target) => ({ target, references: [] })) })),
  getSymbolDependencies: vi.fn(async (_repoPath, sourceTargetIds) => ({ sources: sourceTargetIds.map((source) => ({ source, dependencies: [] })) })),
  getSymbolHierarchy: vi.fn(async (_repoPath, targetIds) => ({ targets: targetIds.map((target) => ({ target, up: [], down: [] })) }))
}
const server = createMcpHttpServer(
  new ContextNavigationMcpAdapter(navigation, 'C:/bound-repository'),
  (entry) => logs.push(entry)
)
let endpoint: string

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('MCP server did not expose a TCP port')
  endpoint = `http://127.0.0.1:${address.port}/mcp`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

async function send(message: unknown) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify(message)
  })
  return { response, body: await response.json() }
}

describe('MCP HTTP server', () => {
  it('preserves target failures without expanding context or logging sensitive content', async () => {
    vi.mocked(navigation.readCode).mockRejectedValueOnce(
      new ContextNavigationError('ELEMENT_NOT_RETRIEVABLE', 'private failure detail', 'private-target')
    )
    const discoveryCalls = vi.mocked(navigation.discoverRepository).mock.calls.length
    const scopeCalls = vi.mocked(navigation.inspectFiles).mock.calls.length
    const called = await send({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'read_code', arguments: { targetIds: ['private-target'] } }
    })
    expect(called.body.result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'ELEMENT_NOT_RETRIEVABLE: private failure detail' }]
    })
    expect(navigation.discoverRepository).toHaveBeenCalledTimes(discoveryCalls)
    expect(navigation.inspectFiles).toHaveBeenCalledTimes(scopeCalls)
    expect(logs.at(-1)).toMatchObject({
      timestamp: expect.any(String), requestId: expect.any(String), sessionId: 'local', method: 'tools/call',
      tool: 'read_code', stage: 'mcp-response-sent', durationMs: expect.any(Number),
      responseSize: expect.any(Number), success: false, status: 'error'
    })
    expect(JSON.stringify(logs)).not.toContain('private')
  })

  it('completes the handshake and exposes only the official read-only catalog', async () => {
    const initialized = await send({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {} }
    })
    const listed = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

    expect(initialized.response.status).toBe(200)
    expect(initialized.body.result.protocolVersion).toBe('2025-06-18')
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'discover_repository', 'get_relationships', 'inspect_files', 'get_references', 'get_symbol_dependencies', 'get_symbol_hierarchy', 'read_code', 'get_system_health'
    ])
    for (const tool of listed.body.result.tools) {
      expect(tool.securitySchemes).toEqual([{ type: 'oauth2', scopes: [] }])
    }
  })

  it('delegates calls through the adapter and records no request arguments', async () => {
    const called = await send({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'inspect_files', arguments: { relativePaths: ['src/a.ts'] } }
    })

    expect(called.body.result.content[0].text).toBe('[src/a.ts]\n\n')
    expect(navigation.inspectFiles).toHaveBeenCalledWith('C:/bound-repository', ['src/a.ts'], { signatures: undefined })
    expect(logs.at(-1)).toMatchObject({ tool: 'inspect_files', success: true })
    expect(logs.at(-1)).not.toHaveProperty('args')
    expect(logs.at(-1)?.responseSize).toBeGreaterThan(0)
  })

  it('serves the exact compact references projection through the local MCP endpoint', async () => {
    const target = 't:AAAAAAAAAAA'
    const called = await send({
      jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_references', arguments: { targetIds: [target] } }
    })

    expect(called.body.result).toEqual({ content: [{ type: 'text', text: `[${target}]\n\nNONE` }] })
    expect(navigation.getReferences).toHaveBeenCalledWith('C:/bound-repository', [target])
    expect(logs.at(-1)).toMatchObject({ tool: 'get_references', success: true })
    expect(logs.at(-1)).not.toHaveProperty('args')
  })

  it('serves the exact compact symbol dependencies projection through the local MCP endpoint', async () => {
    const source = 't:AAAAAAAAAAA'
    const called = await send({
      jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_symbol_dependencies', arguments: { sourceTargetIds: [source] } }
    })

    expect(called.body.result).toEqual({ content: [{ type: 'text', text: `[${source}]\n\nNONE` }] })
    expect(navigation.getSymbolDependencies).toHaveBeenCalledWith('C:/bound-repository', [source])
    expect(logs.at(-1)).toMatchObject({ tool: 'get_symbol_dependencies', success: true })
    expect(logs.at(-1)).not.toHaveProperty('args')
  })

  it('serves the exact compact symbol hierarchy projection through the local MCP endpoint', async () => {
    const target = 't:AAAAAAAAAAA'
    const called = await send({
      jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_symbol_hierarchy', arguments: { targetIds: [target] } }
    })

    expect(called.body.result).toEqual({ content: [{ type: 'text', text: `[${target}]\n\nNONE` }] })
    expect(navigation.getSymbolHierarchy).toHaveBeenCalledWith('C:/bound-repository', [target], { direction: undefined })
    expect(logs.at(-1)).toMatchObject({ tool: 'get_symbol_hierarchy', success: true })
    expect(logs.at(-1)).not.toHaveProperty('args')
  })
})
