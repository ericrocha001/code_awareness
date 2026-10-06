import { afterEach, describe, expect, it } from 'vitest'
import { executeListArtifacts, executeGetArtifact, executePublishArtifact, executeUpdateArtifact, LIST_ARTIFACTS_TOOL, PUBLISH_ARTIFACT_TOOL, UPDATE_ARTIFACT_TOOL } from './continuum-mcp'
import { fixture, markdown } from './continuum-test-fixtures'
import type { McpToolResult } from '../mcp/context-navigation-mcp-adapter'
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup) close(); cleanup.length = 0 })
function data(result: McpToolResult) { expect(result.isError).not.toBe(true); return JSON.parse(result.content[0].text) }
describe('Repository Continuum MCP contracts', () => {
  function setup() { const f = fixture(); cleanup.push(f.close); return f }
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
})
