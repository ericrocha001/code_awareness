import { expect, it } from 'vitest'
import type { GitAtlasPage } from '../../../../shared/types/git-atlas-types'
import { layoutGitAtlas } from './atlas-layout'
import { presentGitAtlas } from './atlas-presentation'

const end = Date.parse('2026-10-16T12:00:00Z')
function fixture(days: number): GitAtlasPage {
  return { snapshot: 'fixture', head: 'late', branch: 'main', primaryRef: 'refs/heads/main', queriedAt: new Date(end).toISOString(), since: new Date(end - days * 86400000).toISOString(), nodes: ['early', 'late'].map((sha, index) => ({ sha, parents: [], author: 'Author', subject: sha, timestamp: new Date(end - (index ? 1 : days - 1) * 86400000).toISOString(), decorations: [] })), refs: ['main', 'topic'].map((name, index) => ({ ref: `refs/heads/${name}`, name, sha: index ? 'early' : 'late', kind: 'LOCAL', upstream: null })), detachedHeads: [], detachedCoverage: 'COMPLETE', tags: [], coverage: 'COMPLETE_WINDOW', boundary: [], pendingParents: [], nextCursor: null }
}
it.each([7, 15, 30, 60, 90] as const)('shows every one of %i daily periods including empty days', days => {
  const page = fixture(days)
  const result = presentGitAtlas(layoutGitAtlas(page), page, days)
  expect(result.days).toHaveLength(days)
  expect(result.days[0].start).toBe(Date.parse(page.since!))
  expect(result.days.at(-1)!.end).toBe(end)
  result.days.forEach((day, index) => {
    expect(day.end - day.start).toBe(86400000)
    if (index) expect(day.start).toBe(result.days[index - 1].end)
  })
  expect(result.points).toHaveLength(2)
})
it('gives independent rows to trajectories whose topological lanes are reused', () => {
  const page = fixture(30), layout = layoutGitAtlas(page)
  expect(new Set(layout.tracks.map(track => track.lane)).size).toBe(1)
  const result = presentGitAtlas(layout, page, 30)
  expect(new Set(result.points.map(point => point.lane)).size).toBe(2)
  expect(new Set(result.rows.values()).size).toBe(2)
})
it('keeps dense commits inside their daily column with disjoint hit targets', () => {
  const page = fixture(30)
  page.nodes = Array.from({ length: 40 }, (_, index) => ({ ...page.nodes[1], sha: `n${index}`, parents: index ? [`n${index - 1}`] : [] }))
  page.refs = [{ ...page.refs[0], sha: 'n39' }]
  const result = presentGitAtlas(layoutGitAtlas(page), page, 30)
  const points = [...result.points].sort((a, b) => a.x - b.x)
  for (let index = 1; index < points.length; index++) expect(points[index].x - points[index - 1].x).toBeGreaterThanOrEqual(28)
  const day = result.days.find(day => Date.parse(page.nodes[0].timestamp) >= day.start && Date.parse(page.nodes[0].timestamp) < day.end)!
  expect(points.every(point => point.x > day.x && point.x < day.x + day.width)).toBe(true)
  const bySha = new Map(points.map(point => [point.node.sha, point]))
  for (const point of points) for (const parent of point.node.parents) expect(bySha.get(parent)!.x).toBeLessThan(point.x)
})
