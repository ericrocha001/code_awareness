import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { fixture, markdown } from './continuum-test-fixtures'
import { executePublishVisualArtifact, visualMarkdown } from './continuum-mcp'
import { ChannelMcpAdapter } from '../mcp/channel-mcp-adapter'
import { createMcpHttpServer } from '../mcp/mcp-http-server'
import { bindProjectNavigation } from '../core/context/project-context-navigation'
import type { ContextNavigationPort } from '../core/context/context-navigation-port'
import type { McpMultimodalToolResult } from '../mcp/mcp-types'
import { acquireHostFile } from '../local-agent-channel/host-file-acquisition'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.reverse().forEach(close => close()); cleanup.length = 0; vi.unstubAllGlobals() })
const file = { download_url: 'https://host.example/authorized-file', file_id: 'host-file', mime_type: 'image/webp' }
const args = { file, name: 'Visual sample', description: 'Four distinct pixels', context: 'Canonical reference' }
const navigation = { discoverRepository: async () => ({ directories: [] }) } as unknown as ContextNavigationPort

describe('Visual MCP real transport', () => {
  it('publishes a host file, discovers without pixels, and sends an exact image block over HTTP without log disclosure', async () => {
    const f = fixture(); cleanup.push(f.close)
    const data = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#7852ee' } }).webp({ lossless: true }).toBuffer()
    const fetchMock = vi.fn(async () => new Response(data, { headers: { 'content-length': String(data.length) } }))
    const publication = await executePublishVisualArtifact(f.service, args, { fetch: fetchMock })
    expect(publication.isError).toBeUndefined()
    const receipt = JSON.parse(publication.content[0].text)
    const logs: unknown[] = []
    const adapter = new ChannelMcpAdapter({ projectId: 'A', repoRoot: f.dir, navigation: bindProjectNavigation(navigation, f.dir), continuum: f.service, visualContinuum: f.service })
    const server = createMcpHttpServer(adapter, entry => logs.push(entry))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port')
    async function call(name: string, arguments_: unknown): Promise<McpMultimodalToolResult> {
      const response = await fetch(`http://127.0.0.1:${(address as { port: number }).port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } }) })
      expect(response.status).toBe(200)
      return ((await response.json()) as { result: McpMultimodalToolResult }).result
    }
    try {
      expect(adapter.listTools().map(tool => tool.name)).toEqual(expect.arrayContaining(['get_visual_artifact', 'publish_visual_artifact', 'get_artifact', 'list_artifacts']))
      const discovery = await call('list_artifacts', { kind: 'VISUAL_REFERENCE' })
      const textual = await call('get_artifact', { artifactId: receipt.artifactId })
      expect(discovery.content.every(block => block.type === 'text')).toBe(true)
      expect(textual.content.every(block => block.type === 'text')).toBe(true)
      for (const result of [discovery, textual]) expect(JSON.stringify(result)).not.toContain(data.toString('base64'))
      const result = await call('get_visual_artifact', { artifactId: receipt.artifactId })
      const image = result.content.find(block => block.type === 'image')
      expect(image?.mimeType).toBe('image/webp')
      expect(Buffer.from(image!.data, 'base64')).toEqual(data)
      expect((await call('get_visual_artifact', { artifactId: 'outside' })).isError).toBe(true)
      expect((await call('get_visual_artifact', { artifactId: receipt.artifactId, extra: 'no' })).isError).toBe(true)
      expect(JSON.stringify(logs)).not.toContain(data.toString('base64'))
      expect(JSON.stringify(adapter.getActivityState())).not.toContain(data.toString('base64'))
      const text = await call('publish_artifact', { rawMarkdown: markdown() })
      expect(text.isError).toBeUndefined()
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('bounds acquisition and reports timeout, redirects, malformed descriptors and repository changes without publication', async () => {
    const f = fixture(); cleanup.push(f.close)
    expect((await executePublishVisualArtifact(f.service, { ...args, file: { ...file, download_url: 'file:///secret' } })).isError).toBe(true)
    await expect(acquireHostFile(file, 4, { fetch: async () => new Response(Buffer.alloc(5)) })).rejects.toThrow('FILE_TOO_LARGE')
    await expect(acquireHostFile(file, 4, { fetch: async () => new Response('x', { headers: { 'content-length': '9' } }) })).rejects.toThrow('FILE_TOO_LARGE')
    await expect(acquireHostFile(file, 4, { timeoutMs: 10, fetch: () => new Promise(() => {}) })).rejects.toThrow('REQUEST_TIMEOUT')
    await expect(acquireHostFile(file, 4, { fetch: async () => new Response('x', { status: 302 }) })).rejects.toThrow('DOWNLOAD_FAILED')
    expect(f.service.list().artifacts).toHaveLength(0)
    const data = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).webp({ lossless: true }).toBuffer()
    expect((await executePublishVisualArtifact(f.service, { ...args, relations: [{ artifactId: 'outside', kind: 'related-to' }] }, { fetch: async () => new Response(data) })).isError).toBe(true)
    const receipt = await f.service.publishVisual(visualMarkdown(args.name, args.description, args.context), data)
    expect(receipt.media.bytes).toBe(data.length)
  })
})
