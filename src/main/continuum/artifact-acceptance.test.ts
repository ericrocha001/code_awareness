import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepositoryContinuumSession } from './project-continuum-session'
import { McpLifecycle } from '../mcp/mcp-lifecycle'
import type { ProjectContextNavigation } from '../core/context/project-context-navigation'
import { RepositoryCatalogStore } from '../repository-catalog/repository-catalog-store'
import { fixture, markdown } from './continuum-test-fixtures'
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup.length = 0; vi.restoreAllMocks() })
describe('Agent-first acceptance over real MCP HTTP and repository lifecycle', () => {
  it('publishes, discovers, selects, edits and switches between isolated canonical repository Continuums', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const f = fixture(); cleanup.push(f.close)
    const rootA = join(f.dir, 'repo-A'), rootB = join(f.dir, 'repo-B'); mkdirSync(rootA); mkdirSync(rootB)
    const catalog = new RepositoryCatalogStore(join(f.dir, 'catalog.db')); cleanup.push(() => catalog.close())
    for (const path of [rootA, rootB]) catalog.upsertLocalCheckout({ path, normalizedPath: path, name: 'Same presentation name', status: 'ACTIVE', availability: 'AVAILABLE', gitState: 'GIT' })
    const session = new RepositoryContinuumSession(join(f.dir, 'continuums'), { findByPath: path => catalog.findByNormalizedPath(path) }); cleanup.push(() => session.dispose())
    const lifecycle = new McpLifecycle({ log: () => {} })
    const navigation = { discoverRepository: async () => ({ directories: [] }), getRelationships: async () => ({ files: [] }), inspectFiles: async () => ({ files: [] }), readCode: async () => [] } as unknown as ProjectContextNavigation
    let endpoint = '', id = 0
    const switchTo = async (path: string) => {
      await lifecycle.deactivate(); session.activate(path)
      await lifecycle.activateContext({ projectId: 'codemap:' + path, repoRoot: path, navigation, continuum: session.getActiveService()! })
      const state = lifecycle.getState(); if (state.status !== 'RUNNING') throw new Error('MCP not running'); endpoint = state.endpoint
    }
    const rpc = async (method: string, params: unknown): Promise<any> => {
      const response = await fetch(endpoint, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
      expect(response.status).toBe(200); return ((await response.json()) as { result: unknown }).result
    }
    const call = (name: string, args: unknown) => rpc('tools/call', { name, arguments: args })
    const read = async (name: string, args: unknown) => { const result = await call(name, args); expect(result.isError).not.toBe(true); return JSON.parse(result.content[0].text) }
    try {
      await switchTo(rootA)
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'continuum-acceptance', version: '1' } })
      const tools = (await rpc('tools/list', {})).tools.filter((t: { name: string }) => t.name.endsWith('_artifact') || t.name === 'list_artifacts')
      expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(['get_artifact', 'list_artifacts', 'publish_artifact', 'update_artifact'])
      const first = await read('publish_artifact', { rawMarkdown: markdown('Needle', 'status: BLOCKED\n', 'SOURCE_BODY_SENTINEL') })
      const related = await read('publish_artifact', { rawMarkdown: markdown('Proof', `relations:\n  - artifactId: ${first.artifactId}\n    kind: validates\n`, 'RELATED_BODY_SENTINEL') })
      const discovery = await read('list_artifacts', {}); expect(discovery.count).toBe(2); expect(JSON.stringify(discovery)).not.toMatch(/rawMarkdown|BODY_SENTINEL/)
      expect((await read('list_artifacts', { query: 'Needle runtime' })).artifacts[0].artifactId).toBe(first.artifactId)
      const hop = await read('list_artifacts', { relatedToArtifactId: first.artifactId, direction: 'inbound', relationKind: 'validates' })
      expect(hop.artifacts.map((a: { artifactId: string }) => a.artifactId)).toEqual([related.artifactId])
      const selected = await read('get_artifact', { artifactId: related.artifactId })
      expect(selected.rawMarkdown).toContain('RELATED_BODY_SENTINEL'); expect(JSON.stringify(selected)).not.toContain('SOURCE_BODY_SENTINEL')
      const updated = await read('update_artifact', { artifactId: related.artifactId, expectedRevision: selected.revision,
        rawMarkdown: markdown('Proof', `status: VALIDATED\nrelations:\n  - artifactId: ${first.artifactId}\n    kind: validates\n`, 'CORRECTED_BODY') })
      expect(updated.artifactId).toBe(related.artifactId); expect(updated.revision).toBe(selected.revision + 1)
      const stale = await call('update_artifact', { artifactId: related.artifactId, expectedRevision: selected.revision, rawMarkdown: markdown('Stale') })
      expect(stale.isError).toBe(true); expect(stale.content[0].text).toContain('REVISION_CONFLICT')
      await switchTo(rootB)
      expect((await read('list_artifacts', {})).count).toBe(0)
      expect((await call('get_artifact', { artifactId: first.artifactId })).isError).toBe(true)
      expect((await call('update_artifact', { artifactId: related.artifactId, expectedRevision: 2, rawMarkdown: markdown('Cross repository') })).isError).toBe(true)
      const b = await read('publish_artifact', { rawMarkdown: markdown('Needle', 'status: BLOCKED\n') })
      expect((await read('list_artifacts', { query: 'Needle' })).artifacts.map((a: { artifactId: string }) => a.artifactId)).toEqual([b.artifactId])
      await switchTo(rootA)
      expect((await read('list_artifacts', {})).count).toBe(2)
      expect((await read('get_artifact', { artifactId: related.artifactId })).revision).toBe(2)
      expect((await call('get_artifact', { artifactId: b.artifactId })).isError).toBe(true)
    } finally { await lifecycle.dispose() }
  })
})
