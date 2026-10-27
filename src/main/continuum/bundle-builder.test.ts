import { afterEach, expect, it, vi } from 'vitest'
import { fixture, markdown } from './continuum-test-fixtures'
import { ContextBundle } from './context-bundle'
import { consolidateBundle, type BundleComposition } from '../../shared/types/continuum-builder-types'

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()) })
function setup() { const f = fixture(); cleanups.push(f.close); return f }
it('captures paginated query snapshots, intersects predicates and unions groups with exclusions and manual order', async () => {
  const f = setup()
  for (let index = 0; index < 121; index++) f.service.publishHuman(markdown(`Source ${index}`).replace('kind: DECISION', `kind: DECISION\nartifactRole: ${index < 67 ? 'ARCHITECTURE_MAP' : 'OTHER'}`))
  const all = await f.service.resolveBuilderComponent('catalog-A', { kind: 'query', filter: { metadata: { kind: 'DECISION' } } })
  const subset = await f.service.resolveBuilderComponent('catalog-A', { kind: 'query', filter: { metadata: { kind: 'DECISION', artifactRole: 'ARCHITECTURE_MAP' } } })
  expect(all.members).toHaveLength(121); expect(subset.members).toHaveLength(67)
  expect(all.members.every(item => item.rawMarkdownTokenCount! > 0 && !('rawMarkdown' in item))).toBe(true)
  const composition: BundleComposition = { repositoryId: 'catalog-A', components: [all, subset], excluded: [all.members[0].artifactId], order: [all.members[1].artifactId] }
  const members = consolidateBundle(composition)
  expect(members).toHaveLength(120); expect(members[0].artifactId).toBe(all.members[1].artifactId)
  const selected = members.map(item => ({ artifactId: item.artifactId, expectedRevision: item.revision! }))
  const bundle = ContextBundle.prepareBuilder(f.service, 'catalog-A', selected, composition.order)
  expect(bundle.preview.members).toHaveLength(120)
  f.service.publishHuman(markdown('Later'))
  expect(consolidateBundle(composition)).toHaveLength(120)
  bundle.assertFresh()
  const original = f.service.get(selected[0].artifactId)!
  f.service.update(original.artifactId, original.revision, original.rawMarkdown + '\nchanged')
  expect(() => bundle.assertFresh()).toThrow(/REVISION_CONFLICT|STALE/)
  expect(() => ContextBundle.prepareBuilder(f.service, 'other', selected, [])).toThrow(/REPOSITORY_CONTEXT_CHANGED/)
})
it('preserves legacy limits and rejects empty, conflicting and invalid snapshots', async () => {
  const f = setup()
  expect(() => ContextBundle.prepareBuilder(f.service, 'catalog-A', [], [])).toThrow(/INVALID_SELECTION|EMPTY/)
  await expect(f.service.resolveBuilderComponent('catalog-A', { kind: 'query', filter: { metadata: { kind: 'ABSENT' } } })).rejects.toThrow('BUNDLE_EMPTY')
  const receipt = f.service.publishHuman(markdown('One'))
  const component = await f.service.resolveBuilderComponent('catalog-A', { kind: 'artifact', selected: [{ artifactId: receipt.artifactId, expectedRevision: 1 }] })
  expect(() => consolidateBundle({ repositoryId: 'catalog-A', components: [component, { ...component, members: [{ ...component.members[0], revision: 2 }] }], excluded: [], order: [] })).toThrow('BUNDLE_SNAPSHOT_STALE')
  const get = vi.spyOn(f.service, 'get')
  await f.service.resolveBuilderComponent('catalog-A', { kind: 'query', filter: {} })
  expect(get).not.toHaveBeenCalled()
  expect(() => f.service.assertSelection(Array.from({ length: 101 }, () => ({ artifactId: receipt.artifactId, expectedRevision: 1 })))).toThrow('INVALID_SELECTION')
})
