import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeListArtifacts, executeGetArtifact, executePublishArtifact, executeUpdateArtifact, executeArtifactNavigation, LIST_ARTIFACTS_TOOL, PUBLISH_ARTIFACT_TOOL, UPDATE_ARTIFACT_TOOL, INSPECT_ARTIFACT_STRUCTURE_TOOL } from './continuum-mcp'
import { fixture, markdown } from './continuum-test-fixtures'
import type { McpToolResult } from '../mcp/channel-mcp-adapter'
import * as tokenizer from '../core/tokenizer'
const cleanup: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup) close(); cleanup.length = 0 })
function data(result: McpToolResult) { expect(result.isError).not.toBe(true); return JSON.parse(result.content[0].text) }
describe('Repository Continuum MCP contracts', () => {
  function setup() { const f = fixture(); cleanup.push(f.close); return f }
  it('estimates only the transmitted JSON and selected literal Markdown, deterministically and on demand', () => {
    const { service } = setup()
    const rawMarkdown = markdown('Ação 日本語 🚀', '', '# Português\r\n"aspas" e \\caminho\n\n```ts\n${literal}\n```')
    const { artifactId } = service.publish(rawMarkdown)
    const count = vi.spyOn(tokenizer, 'countCanonicalTokens')
    for (const includeTokenUsage of [undefined, false]) {
      const args = includeTokenUsage === undefined ? {} : { includeTokenUsage }
      const page = data(executeListArtifacts(service, args))
      expect(page).toEqual({ count: 1, ...service.list() })
      const result = data(executeGetArtifact(service, { artifactId, ...args }))
      const { contentHash, provenance, ...expected } = service.get(artifactId)!
      expect(result).toEqual(expected)
    }
    expect(count).not.toHaveBeenCalled()
    const get = vi.spyOn(service, 'get')
    const list = vi.spyOn(service, 'list')
    const page = data(executeListArtifacts(service, { limit: 1, includeTokenUsage: true }))
    expect(list).toHaveBeenCalledExactlyOnceWith({ limit: 1 })
    expect(get).not.toHaveBeenCalled()
    expect(count).toHaveBeenCalledTimes(1)
    const { tokenUsage: pageUsage, ...pagePayload } = page
    expect(pageUsage).toEqual({ tokenizerId: 'js-tiktoken@1.0.21', tokenizerEncoding: 'cl100k_base', estimated: true,
      payloadScope: 'JSON.stringify(payload) before tokenUsage', payloadTokenCount: tokenizer.countCanonicalTokens(JSON.stringify(pagePayload)).tokenCount })
    const result = data(executeGetArtifact(service, { artifactId, includeTokenUsage: true }))
    expect(get).toHaveBeenCalledExactlyOnceWith(artifactId)
    const { tokenUsage, ...payload } = result
    expect(payload.rawMarkdown).toBe(rawMarkdown)
    expect(tokenUsage).toEqual({ tokenizerId: 'js-tiktoken@1.0.21', tokenizerEncoding: 'cl100k_base', estimated: true,
      payloadScope: 'JSON.stringify(payload) before tokenUsage', payloadTokenCount: tokenizer.countCanonicalTokens(JSON.stringify(payload)).tokenCount,
      rawMarkdownScope: 'literal rawMarkdown', rawMarkdownTokenCount: tokenizer.countCanonicalTokens(rawMarkdown).tokenCount })
    expect(count).toHaveBeenCalledWith(JSON.stringify(payload))
    expect(count).toHaveBeenCalledWith(rawMarkdown)
    expect(data(executeGetArtifact(service, { artifactId, includeTokenUsage: true }))).toEqual(result)
    expect(data(executeListArtifacts(service, { limit: 1, includeTokenUsage: true }))).toEqual(page)
  })
  it('rejects invalid token usage options before any acquisition and measures empty pages', () => {
    const { service } = setup()
    const list = vi.spyOn(service, 'list'), get = vi.spyOn(service, 'get')
    for (const includeTokenUsage of [null, 'true', 1, {}, []]) {
      for (const result of [executeListArtifacts(service, { includeTokenUsage }), executeGetArtifact(service, { artifactId: 'missing', includeTokenUsage })]) {
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('includeTokenUsage must be a boolean')
      }
    }
    expect(list).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled()
    const result = data(executeListArtifacts(service, { includeTokenUsage: true }))
    const { tokenUsage, ...payload } = result
    expect(payload).toEqual({ count: 0, artifacts: [] })
    expect(tokenUsage.payloadTokenCount).toBe(tokenizer.countCanonicalTokens(JSON.stringify(payload)).tokenCount)
    expect(executeGetArtifact(service, { artifactId: 'missing', includeTokenUsage: true }).isError).toBe(true)
  })
  it('caps only MCP pages at 20 and continues general and filtered discovery to exhaustion', () => {
    const { service } = setup()
    for (let i = 0; i < 45; i++) service.publish(markdown('Page ' + i, `status: ${i < 25 ? 'PENDING' : 'COMPLETED'}\n`))
    expect(LIST_ARTIFACTS_TOOL.inputSchema.properties).toHaveProperty('limit', { type: 'integer', minimum: 1, maximum: 20, default: 20 })
    expect(data(executeListArtifacts(service, {})).count).toBe(20)
    expect(data(executeListArtifacts(service, { limit: 1 })).count).toBe(1)
    for (const limit of [0, 21, 100, 1.5]) {
      const result = executeListArtifacts(service, { limit })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('INVALID_ARGUMENT')
    }
    for (const filter of [{}, { status: 'PENDING' }]) {
      const expected = service.list({ ...filter, limit: 100 }).artifacts.map(item => item.artifactId)
      const ids: string[] = []
      const sizes: number[] = []
      let cursor: string | undefined
      do {
        const page = data(executeListArtifacts(service, { ...filter, limit: 20, ...(cursor ? { cursor } : {}) }))
        sizes.push(page.count)
        ids.push(...page.artifacts.map((item: { artifactId: string }) => item.artifactId))
        cursor = page.nextCursor
      } while (cursor)
      expect(ids).toEqual(expected)
      expect(new Set(ids).size).toBe(ids.length)
      expect(sizes).toEqual('status' in filter ? [20, 5] : [20, 20, 5])
    }
    const first = data(executeListArtifacts(service, { status: 'PENDING', limit: 20 }))
    expect(executeListArtifacts(service, { status: 'COMPLETED', cursor: first.nextCursor }).isError).toBe(true)
    expect(service.list({ limit: 100 }).artifacts).toHaveLength(45)
  })
  it('publishes open kinds with compact receipts, reads deliberately and updates stable identity with optimistic concurrency', () => {
    const { service } = setup()
    const receipt = data(executePublishArtifact(service, { rawMarkdown: markdown('Local', 'status: BLOCKED\n') }))
    expect(Object.keys(receipt).sort()).toEqual(['artifactId', 'revision', 'success', 'updatedAt'])
    const original = data(executeGetArtifact(service, { artifactId: receipt.artifactId }))
    expect(original.revision).toBe(1); expect(original.rawMarkdown).toBe(markdown('Local', 'status: BLOCKED\n'))
    expect(original).not.toHaveProperty('provenance'); expect(original).not.toHaveProperty('contentHash')
    const changed = data(executeUpdateArtifact(service, { artifactId: receipt.artifactId, expectedRevision: original.revision, rawMarkdown: markdown('Local', 'status: VALIDATED\n', 'Fixed') }))
    expect(changed.artifactId).toBe(receipt.artifactId); expect(changed.revision).toBe(2)
    const conflict = executeUpdateArtifact(service, { artifactId: receipt.artifactId, expectedRevision: 1, rawMarkdown: markdown('Stale') })
    expect(conflict.isError).toBe(true); expect(conflict.content[0].text).toContain('REVISION_CONFLICT')
    expect(data(executeGetArtifact(service, { artifactId: receipt.artifactId })).createdAt).toBe(original.createdAt)
    expect(JSON.stringify(changed)).not.toContain('rawMarkdown')
  })
  it('intersects metadata filters and time, projects only selected keys, and never searches the body', () => {
    const { service } = setup()
    const local = service.publish(markdown('Needle', 'status: PENDING\nexecutionId: exec-1\npriority: 2\nfuture: {a: true, b: [1, 2]}\n', 'secret body'))
    service.publish(markdown('Other')); service.publish(markdown('Third'))
    const list = (args: unknown) => data(executeListArtifacts(service, args))
    expect(list({}).count).toBe(3); expect(list({ query: 'Needle runtime' }).count).toBe(1); expect(list({ query: 'secret body' }).count).toBe(0)
    const result = list({ kind: 'DECISION', status: 'PENDING', query: 'Needle', metadata: { executionId: 'exec-1', future: { b: [1, 2], a: true } }, updatedAfter: '2026-01-01T00:00:00Z' })
    expect(result.count).toBe(1); expect(JSON.stringify(result)).not.toMatch(/rawMarkdown|contentHash|gitHead|priority|future|executionId/)
    expect(list({ metadataKeys: ['priority'] }).artifacts.find((a: { artifactId: string }) => a.artifactId === local.artifactId).metadata).toEqual({ priority: 2 })
    const first = list({ limit: 1 }); const second = list({ limit: 1, cursor: first.nextCursor })
    expect(second.artifacts[0].artifactId).not.toBe(first.artifacts[0].artifactId)
    expect(list({ kind: 'DECISION', status: 'MISSING' }).count).toBe(0)
  })
  it('returns metadata for inbound/outbound/both graph hops without transitive or related content', () => {
    const { service } = setup()
    const c = service.publish(markdown('C', '', 'BODY_C_SENTINEL'))
    const b = service.publish(markdown('B', `relations:\n  - artifactId: ${c.artifactId}\n    kind: validates\n`, 'BODY_B_SENTINEL'))
    const a = service.publish(markdown('A', `relations:\n  - artifactId: ${b.artifactId}\n    kind: implements\n`, 'BODY_A_SENTINEL'))
    const ids = (id: string, direction: string, relationKind?: string) => data(executeListArtifacts(service, { relatedToArtifactId: id, direction, ...(relationKind ? { relationKind } : {}) })).artifacts.map((record: { artifactId: string }) => record.artifactId).sort()
    expect(ids(a.artifactId, 'outbound')).toEqual([b.artifactId]); expect(ids(b.artifactId, 'inbound')).toEqual([a.artifactId])
    expect(ids(b.artifactId, 'outbound')).toEqual([c.artifactId]); expect(ids(b.artifactId, 'both')).toEqual([a.artifactId, c.artifactId].sort())
    expect(ids(b.artifactId, 'both', 'implements')).toEqual([a.artifactId])
    expect(JSON.stringify(executeListArtifacts(service, { relatedToArtifactId: a.artifactId }))).not.toMatch(/BODY_|rawMarkdown/)
    expect(JSON.stringify(executeGetArtifact(service, { artifactId: a.artifactId }))).not.toContain('BODY_B_SENTINEL')
  })
  it('rejects cross-repository selectors, invalid args and broken relations without mutation', () => {
    const { service } = setup()
    for (const args of [{ projectId: 'other' }, { repositoryName: 'other' }, { scope: 'ANY' }, { limit: '2' }, { limit: 101 }, { direction: 'sideways' }, { relationKind: 'x' }, { metadataKeys: ['a', 'a'] }, { cursor: 'invalid' }, { relatedToArtifactId: 'absent' }, { updatedAfter: 'bad' }]) expect(executeListArtifacts(service, args).isError).toBe(true)
    for (const selector of ['projectId', 'repositoryName', 'scope']) {
      expect(executePublishArtifact(service, { rawMarkdown: markdown(), [selector]: 'other' }).isError).toBe(true)
      for (const definition of [LIST_ARTIFACTS_TOOL, PUBLISH_ARTIFACT_TOOL, UPDATE_ARTIFACT_TOOL]) expect(definition.inputSchema.properties).not.toHaveProperty(selector)
    }
    expect(executeGetArtifact(service, { artifactId: 'missing' }).content[0].text).toContain('ARTIFACT_NOT_FOUND')
    expect(executeGetArtifact(service, { artifactId: 'missing', extra: true }).isError).toBe(true)
    expect(executePublishArtifact(service, { rawMarkdown: '# no YAML' }).isError).toBe(true)
    expect(executePublishArtifact(service, { rawMarkdown: markdown('Invalid', 'relations:\n  - artifactId: missing\n    kind: any\n') }).content[0].text).toContain('INVALID_RELATION')
    expect(executeUpdateArtifact(service, { artifactId: 'missing', expectedRevision: 1, rawMarkdown: markdown() }).content[0].text).toContain('ARTIFACT_NOT_FOUND')
    expect(service.list().artifacts).toHaveLength(0)
  })
  it('finds sufficient context in a representative corpus with two metadata acquisitions and one selected body read', () => {
    const { service } = setup()
    for (let i = 0; i < 200; i++) service.publish(markdown('Unrelated-' + i, 'status: COMPLETED\nexecutionId: old-run\n', 'noise'.repeat(100)))
    const source = service.publish(markdown('SpecificImplementation', 'status: BLOCKED\nexecutionId: canonical-run\n', 'SELECTED_CONTEXT'))
    const proof = service.publish(markdown('RelevantProof', `relations:\n  - artifactId: ${source.artifactId}\n    kind: validates\n`, 'SELECTED_PROOF'))
    const discovery = data(executeListArtifacts(service, { query: 'SpecificImplementation runtime', kind: 'DECISION', status: 'BLOCKED', metadata: { executionId: 'canonical-run' } }))
    expect(discovery.count).toBe(1); expect(discovery.nextCursor).toBeUndefined(); expect(discovery.artifacts[0].artifactId).toBe(source.artifactId)
    const related = data(executeListArtifacts(service, { relatedToArtifactId: source.artifactId, direction: 'inbound', relationKind: 'validates' }))
    expect(related.count).toBe(1); expect(related.artifacts[0].artifactId).toBe(proof.artifactId)
    expect(JSON.stringify(discovery).length + JSON.stringify(related).length).toBeLessThan(1000)
    expect(data(executeGetArtifact(service, { artifactId: proof.artifactId })).rawMarkdown).toContain('SELECTED_PROOF')
    expect(JSON.stringify(related)).not.toContain('SELECTED_PROOF')
  })
  it('anticipates literal rawMarkdown token count without bodies in list and structure, matching get_artifact on demand', () => {
    const { service } = setup()
    for (let i = 0; i < 25; i++) {
      service.publish(markdown('Item ' + i, `status: ${i < 15 ? 'PENDING' : 'COMPLETED'}\n`, `# Header ${i}\r\nUnicode \u00e7 \u65e5\u672c\u8a9e \ud83d\ude80\r\n` + 'line\r\n'.repeat(i + 1)))
    }

    const page1Result = executeListArtifacts(service, { limit: 20, includeRawMarkdownTokenCount: true })
    const page1 = data(page1Result)
    expect(page1.count).toBe(20)
    expect(page1.artifacts).toHaveLength(20)
    expect(page1.tokenizerId).toBe('js-tiktoken@1.0.21')
    expect(page1.tokenizerEncoding).toBe('cl100k_base')
    expect(page1.nextCursor).toBeDefined()
    for (const record of page1.artifacts) {
      expect(typeof record.rawMarkdownTokenCount).toBe('number')
      expect(record.rawMarkdownTokenCount).toBeGreaterThan(0)
      expect(record).not.toHaveProperty('rawMarkdown')
      expect(record).not.toHaveProperty('tokenizerId')
    }

    const page2WithoutFlag = data(executeListArtifacts(service, { limit: 20, cursor: page1.nextCursor }))
    expect(page2WithoutFlag.count).toBe(5)
    expect(page2WithoutFlag).not.toHaveProperty('tokenizerId')
    for (const record of page2WithoutFlag.artifacts) {
      expect(record).not.toHaveProperty('rawMarkdownTokenCount')
    }

    const page2WithFlag = data(executeListArtifacts(service, { limit: 20, cursor: page1.nextCursor, includeRawMarkdownTokenCount: true }))
    expect(page2WithFlag.count).toBe(5)
    expect(page2WithFlag.tokenizerId).toBe('js-tiktoken@1.0.21')
    for (const record of page2WithFlag.artifacts) {
      expect(typeof record.rawMarkdownTokenCount).toBe('number')
    }

    const combined = data(executeListArtifacts(service, { limit: 5, status: 'PENDING', includeRawMarkdownTokenCount: true, includeTokenUsage: true }))
    expect(combined.count).toBe(5)
    expect(combined.tokenizerId).toBe('js-tiktoken@1.0.21')
    expect(combined.tokenUsage).toBeDefined()
    expect(combined.tokenUsage.payloadTokenCount).toBeGreaterThan(0)
    for (const record of combined.artifacts) {
      expect(typeof record.rawMarkdownTokenCount).toBe('number')
    }

    const sampleId = page1.artifacts[0].artifactId
    const inspectResult = data(executeArtifactNavigation(service, 'inspect_artifact_structure', { artifactId: sampleId, includeRawMarkdownTokenCount: true }))
    expect(inspectResult.artifactId).toBe(sampleId)
    expect(inspectResult.rawMarkdownTokenCount).toBe(page1.artifacts[0].rawMarkdownTokenCount)
    expect(inspectResult.tokenizerId).toBe('js-tiktoken@1.0.21')
    expect(inspectResult.tokenizerEncoding).toBe('cl100k_base')
    expect(inspectResult.sections).toBeDefined()
    expect(inspectResult).not.toHaveProperty('content')

    const fullArtifact = data(executeGetArtifact(service, { artifactId: sampleId, includeTokenUsage: true }))
    expect(inspectResult.rawMarkdownTokenCount).toBe(fullArtifact.tokenUsage.rawMarkdownTokenCount)

    for (const badValue of ['true', 1, {}, []]) {
      const badList = executeListArtifacts(service, { includeRawMarkdownTokenCount: badValue })
      expect(badList.isError).toBe(true)
      expect(badList.content[0].text).toContain('includeRawMarkdownTokenCount')

      const badInspect = executeArtifactNavigation(service, 'inspect_artifact_structure', { artifactId: sampleId, includeRawMarkdownTokenCount: badValue })
      expect(badInspect.isError).toBe(true)
    }

    const cleanInspect = data(executeArtifactNavigation(service, 'inspect_artifact_structure', { artifactId: sampleId }))
    expect(cleanInspect).not.toHaveProperty('rawMarkdownTokenCount')
    expect(cleanInspect).not.toHaveProperty('tokenizerId')

    const cleanList = data(executeListArtifacts(service, { limit: 5 }))
    expect(cleanList).not.toHaveProperty('tokenizerId')
    for (const record of cleanList.artifacts) {
      expect(record).not.toHaveProperty('rawMarkdownTokenCount')
    }

    const updatedReceipt = data(executeUpdateArtifact(service, {
      artifactId: sampleId,
      expectedRevision: fullArtifact.revision,
      rawMarkdown: fullArtifact.rawMarkdown + '\n\nExtra paragraph for new tokens.'
    }))
    const updatedInspect = data(executeArtifactNavigation(service, 'inspect_artifact_structure', { artifactId: sampleId, includeRawMarkdownTokenCount: true }))
    expect(updatedInspect.revision).toBe(updatedReceipt.revision)
    expect(updatedInspect.rawMarkdownTokenCount).toBeGreaterThan(inspectResult.rawMarkdownTokenCount)
  })
})
