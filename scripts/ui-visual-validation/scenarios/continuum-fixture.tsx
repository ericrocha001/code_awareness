import React from 'react'
import { createRoot } from 'react-dom/client'
import { ContinuumView } from '../../../src/renderer/src/components/ContinuumView/ContinuumView'
import '../../../src/renderer/src/index.css'

const items = Array.from({ length: 18 }, (_, index) => ({ artifactId: `fixture-${index}`, name: index === 0 ? 'Executable plan — long content' : `Observation ${index}`, description: 'Explicit synthetic fixture for visual validation', kind: 'IMPLEMENTATION_PLAN', updatedAt: '2026-10-06T18:00:00Z', relationCount: 0 }))
window.codeAwareness = {
  getContinuumFacets: async () => ({ repositoryId: 'visual-fixture', facets: [{ key: 'kind', values: [{ value: 'IMPLEMENTATION_PLAN', count: items.length }] }] }),
  listContinuumArtifacts: async (request: { repositoryId: string; query?: string }) => ({ repositoryId: request.repositoryId, artifacts: items.filter(item => item.name.toLowerCase().includes((request.query || '').toLowerCase())) }),
  getContinuumArtifact: async (repositoryId: string, artifactId: string) => ({ repositoryId, artifact: { artifactId, revision: 1, metadata: { name: items.find(item => item.artifactId === artifactId)!.name, kind: 'IMPLEMENTATION_PLAN', longValue: 'LongMetadata'.repeat(40) }, body: '# Visual validation\n\n' + Array.from({ length: 35 }, (_, i) => `## Section ${i}\n\nControlled long content for real scrolling.\n\n\`\`\`typescript\nconst veryLongLine = "${'content'.repeat(80)}"\n\`\`\``).join('\n\n'), createdAt: '2026-10-06T18:00:00Z', updatedAt: '2026-10-06T18:00:00Z' } }),
  onContinuumChanged: () => () => {}
} as unknown as Window['codeAwareness']
document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<ContinuumView activeProject={{ id: 'fixture', path: '/visual-fixture', name: 'Visual Fixture Repository' }} />)
