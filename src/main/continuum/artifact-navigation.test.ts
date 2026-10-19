import { afterEach, expect, it } from 'vitest'
import { fixture, markdown } from './continuum-test-fixtures'
import { executeArtifactNavigation, executeGetArtifact } from './continuum-mcp'
import { ContinuumService } from './continuum-service'
import { ArtifactStore } from './artifact-store'
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()))
function setup(id = 'catalog-A') { const f = fixture(id); cleanup.push(f.close); return f }

it('paginates structure and literal sections without leaking bodies; disambiguates repeated titles and reads direct blocks', () => {
  const { service } = setup()
  const body = '# Same\r\n' + 'x'.repeat(12279) + '🚀'.repeat(9000) + '\r\n\r\n## Child\r\nchild secret\r\n# Same\r\n- one\r\n- two\r\n'
  const { artifactId } = service.publish(markdown('Rich', '', body))
  const first = service.inspectStructure({ artifactId, limit: 1 })
  expect(JSON.stringify(first)).not.toMatch(/child secret|rawMarkdown|xxxx/)
  const second = service.inspectStructure({ artifactId, limit: 1, cursor: first.nextCursor })
  expect(second.sections![0].parentSectionId).toBe(first.sections![0].sectionId)
  const all = service.inspectStructure({ artifactId }).sections!
  expect(all[0].sectionId).not.toBe(all[2].sectionId)
  const query = { artifactId, sectionId: all[0].sectionId, expectedRevision: 1 }
  let page = service.readSection(query), contents = [page.content]
  while (page.nextCursor) {
    const next = service.readSection({ ...query, cursor: page.nextCursor })
    expect(next.start).toBe(page.end); expect(next.content.length).toBeLessThanOrEqual(12288)
    contents.push(next.content); page = next
  }
  expect(Buffer.concat(contents.map(text => Buffer.from(text)))).toEqual(Buffer.from(body.slice(0, body.lastIndexOf('# Same'))))
  expect(service.readSection({ ...query, includeDescendants: false }).content).not.toContain('child secret')
  const blocks = service.inspectStructure({ artifactId, sectionId: all[2].sectionId, includeBlocks: true }).blocks!
  expect(blocks.map(b => b.type)).toEqual(['list'])
  expect(service.readSection({ ...query, sectionId: all[2].sectionId, blockId: blocks[0].blockId }).content).toBe('- one\r\n- two')
})

it('rejects stale, manipulated, cross-repository and wrong-scope cursors/selectors while preserving legacy reads', () => {
  const a = setup(), b = setup('catalog-B')
  const input = { artifactId: 'same', metadata: { name: 'A', description: 'A', kind: 'DOCUMENT' }, rawMarkdown: '# A\n' + 'body'.repeat(8000) + '\n# B\ntext' }
  a.store.create(input); b.store.create(input)
  const outline = a.service.inspectStructure({ artifactId: 'same', limit: 1 })
  const query = { artifactId: 'same', sectionId: outline.sections![0].sectionId, expectedRevision: 1 }
  const read = a.service.readSection(query)
  expect(() => b.service.readSection(query)).toThrow(/STRUCTURE_STALE/)
  expect(() => b.service.inspectStructure({ artifactId: 'same', limit: 1, cursor: outline.nextCursor })).toThrow(/STRUCTURE_STALE/)
  expect(() => a.service.inspectStructure({ artifactId: 'same', limit: 2, cursor: outline.nextCursor })).toThrow(/STRUCTURE_STALE/)
  expect(() => a.service.readSection({ ...query, includeDescendants: false, cursor: read.nextCursor })).toThrow(/STRUCTURE_STALE/)
  expect(() => a.service.readSection({ ...query, cursor: read.nextCursor! + 'x' })).toThrow(/STRUCTURE_STALE/)
  expect(() => a.service.readSection({ ...query, blockId: 'invalid' })).toThrow(/STRUCTURE_STALE/)
  a.store.update({ ...input, expectedRevision: 1, rawMarkdown: '# Updated' })
  expect(() => a.service.readSection(query)).toThrow(/REVISION_CONFLICT/)
  expect(() => a.service.readSection({ ...query, expectedRevision: 2 })).toThrow(/STRUCTURE_STALE/)
  expect(() => a.service.inspectStructure({ artifactId: 'same', limit: 1, cursor: outline.nextCursor })).toThrow(/STRUCTURE_STALE/)
  expect(executeGetArtifact(a.service, { artifactId: 'same' }).isError).not.toBe(true)
})

it('uses identical MCP/service responses and preserves validation and active-context errors', () => {
  const { service, store } = setup(), { artifactId } = service.publish(markdown())
  const result = executeArtifactNavigation(service, 'inspect_artifact_structure', { artifactId })
  expect(JSON.parse(result.content[0].text)).toEqual(service.inspectStructure({ artifactId }))
  const sectionId = service.inspectStructure({ artifactId }).sections![0].sectionId
  for (const [name, args] of [
    ['inspect_artifact_structure', { artifactId, limit: 101 }],
    ['inspect_artifact_structure', { artifactId, includeBlocks: 'true' }],
    ['inspect_artifact_structure', { artifactId, includeBlocks: true }],
    ['read_artifact_section', { artifactId, sectionId }],
    ['read_artifact_section', { artifactId, sectionId, expectedRevision: 1, includeDescendants: null }]
  ] as const) expect(executeArtifactNavigation(service, name, args).isError).toBe(true)
  const inactive = new ContinuumService(store, undefined, () => false)
  expect(() => inactive.inspectStructure({ artifactId })).toThrow(/REPOSITORY_CONTEXT_CHANGED/)
  expect(() => inactive.readSection({ artifactId, sectionId, expectedRevision: 1 })).toThrow(/REPOSITORY_CONTEXT_CHANGED/)
})

it('paginates ephemeral blocks and resumes signed cursors after SQLite reopen', () => {
  const f = setup(), body = '# Blocks\n\n' + Array.from({ length: 103 }, (_, i) => `paragraph ${i}`).join('\n\n')
  const { artifactId } = f.service.publish(markdown('Blocks', '', body))
  const sectionId = f.service.inspectStructure({ artifactId }).sections![0].sectionId
  const query = { artifactId, sectionId, includeBlocks: true, limit: 50 }
  const first = f.service.inspectStructure(query)
  expect(first.blocks).toHaveLength(50)
  f.store.close()
  const reopened = new ArtifactStore(f.path, 'catalog-A'); cleanup.push(() => reopened.close())
  const service = new ContinuumService(reopened)
  const second = service.inspectStructure({ ...query, cursor: first.nextCursor })
  const third = service.inspectStructure({ ...query, cursor: second.nextCursor })
  expect(third.blocks).toHaveLength(3); expect(third.nextCursor).toBeUndefined()
  const blocks = [...first.blocks!, ...second.blocks!, ...third.blocks!]
  expect(new Set(blocks.map(b => b.blockId)).size).toBe(103)
  expect(service.readSection({ artifactId, sectionId, expectedRevision: 1, blockId: blocks[102].blockId }).content).toBe('paragraph 102')
})
