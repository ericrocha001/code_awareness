import React from 'react'
import { createRoot } from 'react-dom/client'
import type { ContinuumListRequest } from '../../../src/shared/types/continuum-ui-types'
import { ContinuumView } from '../../../src/renderer/src/components/ContinuumView/ContinuumView'
import '../../../src/renderer/src/index.css'

const pagination = document.documentElement.dataset.pagination === 'true'
const items = Array.from({ length: pagination ? 95 : 18 }, (_, index) => ({ artifactId: `fixture-${index}`, name: index === 0 ? 'Executable plan — long content' : `Observation ${index}`, description: 'Explicit synthetic fixture for visual validation', kind: 'IMPLEMENTATION_PLAN', occurred: `2026-${index < 12 ? '10-31' : '11-01'}T23:${String((30 + index) % 60).padStart(2, '0')}:00-03:00`, updatedAt: '2026-10-06T18:00:00Z', revision: 1, rawMarkdownTokenCount: 3018, relationCount: 0 }))
const pageRequests: { cursor?: string; query?: string; size?: number }[] = []
let activePages = 0
async function list(request: ContinuumListRequest) {
  const short = pagination && request.query === 'short'
  const filtered = short ? items.slice(0, 3) : items.filter((item, index) => (!request.periods?.occurred?.month || (request.periods.occurred.month === 10 ? index < 12 : index >= 12)) && item.name.toLowerCase().includes((request.query || '').toLowerCase()))
  const projected = filtered.map(item => ({ ...item, ...(request.sortBy === 'createdAt' ? { createdAt: '2026-10-01T18:00:00Z' } : {}), ...(request.includeTags ? { tags: item.artifactId === 'fixture-0' ? ['fixture', 'canonical', 'fallback', 'remaining'] : [] } : {}) }))
  if (!pagination) return { repositoryId: request.repositoryId, artifacts: projected }
  const record = { cursor: request.cursor, query: request.query, size: 0 }
  pageRequests.push(record); document.body.dataset.pageRequests = JSON.stringify(pageRequests)
  if (request.cursor) {
    activePages++
    document.body.dataset.maxConcurrentPages = String(Math.max(Number(document.body.dataset.maxConcurrentPages || 0), activePages))
  }
  try {
    if (request.cursor && document.body.dataset.holdNextPage === 'true') await new Promise<void>(resolve => document.addEventListener('release-page', () => resolve(), { once: true }))
    if (request.cursor && document.body.dataset.failNextPage === 'true') { delete document.body.dataset.failNextPage; throw new Error('Falha sintética recuperável') }
    const offset = Number(request.cursor ?? 0), size = short ? 1 : 30
    const artifacts = projected.slice(offset, offset + size)
    record.size = artifacts.length; document.body.dataset.pageRequests = JSON.stringify(pageRequests)
    return { repositoryId: request.repositoryId, artifacts, ...(offset + size < filtered.length ? { nextCursor: String(offset + size) } : {}) }
  } finally { if (request.cursor) activePages-- }
}
window.codeAwareness = {
  getContinuumTags: async () => ({ repositoryId: 'visual-fixture', tags: [{ slug: 'fixture', name: 'Fixture', description: 'Synthetic documents', count: 18 }] }),
  getContinuumTagTokens: async () => ({ repositoryId: 'visual-fixture', totals: [{ slug: 'fixture', count: 18, rawMarkdownTokenCount: 54321, tokenizerId: 'fixture', tokenizerEncoding: 'cl100k_base' }] }),
  resolveContinuumSelection: async request => ({ repositoryId: request.repositoryId, artifacts: items }),
  getContinuumSelectionTokens: async (repositoryId, selected) => ({ repositoryId, artifacts: selected.map(item => ({ artifactId: item.artifactId, rawMarkdownTokenCount: 3018 })) }),
  mutateContinuumTags: async request => ({ repositoryId: request.repositoryId, tags: [{ slug: 'fixture', name: 'Fixture', description: 'Synthetic documents', count: 18 }] }),
  continuumBuilder: async request => {
    if (request.action === 'resolve') return { id: crypto.randomUUID(), source: request.source, members: request.source.kind === 'artifact' ? request.source.selected.map(source => items.find(item => item.artifactId === source.artifactId)!) : items }
    return { repositoryId: request.repositoryId, outcome: 'cancelled' }
  },
  getContinuumFacets: async () => ({ repositoryId: 'visual-fixture', facets: [{ key: 'occurred', values: [], years: [{ year: 2026, count: 18, months: [{ month: 11, count: 6 }, { month: 10, count: 12 }] }] }, { key: 'kind', values: [{ value: 'IMPLEMENTATION_PLAN', count: items.length }] }] }),
  listContinuumArtifacts: list,
  getContinuumArtifact: async (repositoryId: string, artifactId: string) => ({ repositoryId, artifact: { artifactId, revision: 1, metadata: { name: items.find(item => item.artifactId === artifactId)!.name, kind: 'IMPLEMENTATION_PLAN', occurred: items.find(item => item.artifactId === artifactId)!.occurred, longValue: 'LongMetadata'.repeat(40) }, body: '# Visual validation\n\n' + Array.from({ length: 35 }, (_, i) => `## Section ${i}\n\nControlled long content for real scrolling.\n\n\`\`\`typescript\nconst veryLongLine = "${'content'.repeat(80)}"\n\`\`\``).join('\n\n'), createdAt: '2026-10-06T18:00:00Z', updatedAt: '2026-10-06T18:00:00Z' } }),
  onContinuumChanged: () => () => {}
} as unknown as Window['codeAwareness']
document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<ContinuumView activeProject={{ id: 'fixture', path: '/visual-fixture', name: 'Visual Fixture Repository' }} />)
