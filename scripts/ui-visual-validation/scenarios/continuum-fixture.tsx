import React from 'react'
import { createRoot } from 'react-dom/client'
import type { ContinuumListRequest } from '../../../src/shared/types/continuum-ui-types'
import { ContinuumView } from '../../../src/renderer/src/components/ContinuumView/ContinuumView'
import '../../../src/renderer/src/index.css'

const items = Array.from({ length: 18 }, (_, index) => ({ artifactId: `fixture-${index}`, name: index === 0 ? 'Executable plan — long content' : `Observation ${index}`, description: 'Explicit synthetic fixture for visual validation', kind: 'IMPLEMENTATION_PLAN', occurred: `2026-${index < 12 ? '10-31' : '11-01'}T23:${String(30 + index).padStart(2, '0')}:00-03:00`, updatedAt: '2026-10-06T18:00:00Z', revision: 1, rawMarkdownTokenCount: 3018, relationCount: 0 }))
window.codeAwareness = {
  getContinuumTags: async () => ({ repositoryId: 'visual-fixture', tags: [{ slug: 'fixture', name: 'Fixture', description: 'Synthetic documents', count: 18 }] }),
  getContinuumTagTokens: async () => ({ repositoryId: 'visual-fixture', totals: [{ slug: 'fixture', count: 18, rawMarkdownTokenCount: 54321, tokenizerId: 'fixture', tokenizerEncoding: 'cl100k_base' }] }),
  resolveContinuumSelection: async request => ({ repositoryId: request.repositoryId, artifacts: items }),
  getContinuumSelectionTokens: async (repositoryId, selected) => ({ repositoryId, artifacts: selected.map(item => ({ artifactId: item.artifactId, rawMarkdownTokenCount: 3018 })) }),
  mutateContinuumTags: async request => ({ repositoryId: request.repositoryId, tags: [{ slug: 'fixture', name: 'Fixture', description: 'Synthetic documents', count: 18 }] }),
  prepareContinuumBundle: async request => {
    const source = request.source ?? { kind: 'tag' as const, slug: request.slug! }
    const members = (source.kind === 'selection' ? source.selected.map(selected => items.find(item => item.artifactId === selected.artifactId)!) : items).map(item => ({ artifactId: item.artifactId, revision: 1, name: item.name, kind: item.kind }))
    return { repositoryId: request.repositoryId, snapshotId: 'synthetic-snapshot', slug: source.kind === 'tag' ? source.slug : '', tagName: source.kind === 'tag' ? 'Fixture' : 'Seleção avulsa', tagDescription: '', generatedAt: '2026-10-24', members, markdown: members.map(item => `# ${item.name}\n\nSynthetic literal source`).join('\n\n'), markdownBytes: members.length * 150, tokenCount: members.length * 50, tokenizerEncoding: 'cl100k_base', hasVisuals: false, source, compositionAvailable: true }
  },
  discardContinuumBundle: async () => {},
  exportContinuumBundle: async request => { document.body.dataset.fixtureExport = request.intent; return { outcome: request.intent === 'copy' ? 'copied' : 'saved', snapshotId: request.snapshotId } },
  getContinuumFacets: async () => ({ repositoryId: 'visual-fixture', facets: [{ key: 'occurred', values: [], years: [{ year: 2026, count: 18, months: [{ month: 11, count: 6 }, { month: 10, count: 12 }] }] }, { key: 'kind', values: [{ value: 'IMPLEMENTATION_PLAN', count: items.length }] }] }),
  listContinuumArtifacts: async (request: ContinuumListRequest) => ({ repositoryId: request.repositoryId, artifacts: items.filter((item, index) => (!request.periods?.occurred?.month || (request.periods.occurred.month === 10 ? index < 12 : index >= 12)) && item.name.toLowerCase().includes((request.query || '').toLowerCase())) }),
  getContinuumArtifact: async (repositoryId: string, artifactId: string) => ({ repositoryId, artifact: { artifactId, revision: 1, metadata: { name: items.find(item => item.artifactId === artifactId)!.name, kind: 'IMPLEMENTATION_PLAN', occurred: items.find(item => item.artifactId === artifactId)!.occurred, longValue: 'LongMetadata'.repeat(40) }, body: '# Visual validation\n\n' + Array.from({ length: 35 }, (_, i) => `## Section ${i}\n\nControlled long content for real scrolling.\n\n\`\`\`typescript\nconst veryLongLine = "${'content'.repeat(80)}"\n\`\`\``).join('\n\n'), createdAt: '2026-10-06T18:00:00Z', updatedAt: '2026-10-06T18:00:00Z' } }),
  onContinuumChanged: () => () => {}
} as unknown as Window['codeAwareness']
document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<ContinuumView activeProject={{ id: 'fixture', path: '/visual-fixture', name: 'Visual Fixture Repository' }} />)
