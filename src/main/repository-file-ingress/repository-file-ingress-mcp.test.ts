import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer, type McpOperationalLogEntry } from '../mcp/mcp-http-server'
import { McpLifecycle } from '../mcp/mcp-lifecycle'
import { RepositoryFileIngress } from './repository-file-ingress'
import { IMPORT_REPOSITORY_FILE_TOOL, executeImportRepositoryFile } from './repository-file-ingress-mcp'

const navigation: ProjectContextNavigation = {
  discoverRepository: vi.fn(async () => ({ directories: [{ relativePath: '.', children: [] }] })),
  getRelationships: vi.fn(async () => ({ files: [] })),
  inspectFiles: vi.fn(async () => ({ files: [] })),
  readCode: vi.fn(async () => []),
  getReferences: vi.fn(async () => ({ targets: [] })),
  getSymbolDependencies: vi.fn(async () => ({ sources: [] })),
  getSymbolHierarchy: vi.fn(async () => ({ targets: [] }))
}
const file = { download_url: 'https://files.example/private?token=secret', file_id: 'secret-id' }
const bytes = Buffer.from([0, 255, 127, 42])
let root: string
let ingress: RepositoryFileIngress
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'file-ingress-mcp-'))
  ingress = new RepositoryFileIngress(root, { fetch: vi.fn(async () => new Response(bytes)) as typeof fetch })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('Repository File Ingress MCP', () => {
  it('appears only in an enabled project and preserves the existing catalog', async () => {
    const disabled = new ChannelMcpAdapter({ projectId: 'repo', repoRoot: root, navigation })
    const enabled = new ChannelMcpAdapter({ projectId: 'repo', repoRoot: root, navigation, repositoryFileIngress: ingress })
    expect(enabled.listTools()).toEqual([...disabled.listTools(), IMPORT_REPOSITORY_FILE_TOOL])
    expect(enabled.getToolCatalogHash()).not.toBe(disabled.getToolCatalogHash())
    expect(await disabled.callTool('import_repository_file', { file, destinationPath: 'new.bin' })).toMatchObject({ isError: true, content: [{ type: 'text', text: 'REPOSITORY_FILE_INGRESS_UNAVAILABLE' }] })
    expect((await enabled.callTool('discover_repository', {})).isError).toBeUndefined()
  })

  it('exposes the file param and create-only annotations through actual tools/list and imports through tools/call', async () => {
    const logs: McpOperationalLogEntry[] = []
    const adapter = new ChannelMcpAdapter({ projectId: 'repo', repoRoot: root, navigation, repositoryFileIngress: ingress })
    const server = createMcpHttpServer(adapter, entry => logs.push(entry))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected loopback port')
    const call = async (method: string, params: unknown = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      return await response.json() as { result: { tools?: unknown[]; content?: { type: string; text: string }[]; isError?: boolean } }
    }
    try {
      const catalog = await call('tools/list')
      expect(catalog.result.tools).toContainEqual(IMPORT_REPOSITORY_FILE_TOOL)
      expect(IMPORT_REPOSITORY_FILE_TOOL._meta).toEqual({ 'openai/fileParams': ['file'] })
      expect(IMPORT_REPOSITORY_FILE_TOOL.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
      const result = await call('tools/call', { name: 'import_repository_file', arguments: { file, destinationPath: 'assets/test.bin' } })
      expect(result.result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ path: 'assets/test.bin', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) }] })
      expect(await readFile(path.join(root, 'assets/test.bin'))).toEqual(bytes)
      const repeated = await call('tools/call', { name: 'import_repository_file', arguments: { file, destinationPath: 'assets/test.bin' } })
      expect(repeated.result).toEqual({ isError: true, content: [{ type: 'text', text: 'DESTINATION_CONFLICT' }] })
      expect(await readFile(path.join(root, 'assets/test.bin'))).toEqual(bytes)
      expect(adapter.getActivityState().byCapability['Repository File Ingress']).toMatchObject({ totalRequests: 2, succeededRequests: 1, failedRequests: 1, activeRequests: 0 })
      expect(JSON.stringify(logs)).not.toMatch(/secret|download_url|file_id|assets/)
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })

  it.each([null, [], { file }, { file, destinationPath: 'file.bin', url: 'https://alternative.example' }, { file, destinationPath: 'file.bin', overwrite: true }])('rejects invalid MCP arguments without writing', async args => {
    expect(await executeImportRepositoryFile(ingress, args)).toMatchObject({ isError: true })
    expect(await readdir(root)).toEqual([])
  })

  it('sanitizes unexpected service failures before they reach MCP', async () => {
    vi.spyOn(ingress, 'importFile').mockRejectedValue(new Error('private-url secret-id authorization header'))
    expect(await executeImportRepositoryFile(ingress, { file, destinationPath: 'file.bin' })).toEqual({ isError: true, content: [{ type: 'text', text: 'IMPORT_FAILED' }] })
  })

  it('refreshes the lifecycle catalog when availability changes on the same project', async () => {
    const lifecycle = new McpLifecycle({ log: () => {} })
    const context = { projectId: 'repo', repoRoot: root, navigation }
    try {
      await lifecycle.activateContext(context)
      const original = lifecycle.getCatalogProbe()!.getToolCatalogHash()
      await lifecycle.activateContext({ ...context, repositoryFileIngress: ingress })
      expect(lifecycle.getCatalogProbe()!.getToolCatalogHash()).not.toBe(original)
      await lifecycle.activateContext(context)
      expect(lifecycle.getCatalogProbe()!.getToolCatalogHash()).toBe(original)
    } finally { await lifecycle.dispose() }
  })

  it('does not serialize imports in the Git mutation lane', async () => {
    let finish: (() => void) | undefined
    const streamFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); finish = () => controller.close() } }))) as typeof fetch
    ingress = new RepositoryFileIngress(root, { fetch: streamFetch })
    const adapter = new ChannelMcpAdapter({ projectId: 'repo', repoRoot: root, navigation, repositoryFileIngress: ingress })
    const slow = adapter.callTool('import_repository_file', { file, destinationPath: 'slow.bin' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const finishSlow = finish!
    try {
      vi.mocked(streamFetch).mockImplementationOnce(async () => new Response(bytes))
      expect((await adapter.callTool('import_repository_file', { file, destinationPath: 'fast.bin' })).isError).toBeUndefined()
      expect(adapter.getActivityState().byCapability['Repository File Ingress'].peakConcurrentRequests).toBe(2)
    } finally { finishSlow(); await slow }
  })
})
