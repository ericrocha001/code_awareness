import type { GitAtlasPage, GitAtlasWindow } from '../../../../shared/types/git-atlas-types'
import type { AtlasLayout } from './atlas-layout'

const dayMs = 86400000
export function atlasWindowPage(page: GitAtlasPage | null, window: GitAtlasWindow): GitAtlasPage | null {
  if (!page || window === 'ALL') return page
  const end = Date.parse(page.queriedAt), start = end - window * dayMs
  const nodes = page.nodes.filter(node => {
    const timestamp = Date.parse(node.timestamp)
    return timestamp >= start && timestamp <= end
  })
  const since = new Date(start).toISOString()
  return nodes.length === page.nodes.length && page.since === since ? page : { ...page, nodes, since }
}

export function presentGitAtlas(layout: AtlasLayout, page: GitAtlasPage | null, window: GitAtlasWindow, minimumWidth = 0) {
  const end = Date.parse(page?.queriedAt ?? new Date().toISOString())
  const earliest = Math.min(end, ...layout.points.map(point => Date.parse(point.node.timestamp)))
  const count = window === 'ALL' ? Math.max(1, Math.ceil((end - earliest) / dayMs)) : window
  const start = window === 'ALL' ? end - count * dayMs : Date.parse(page?.since ?? new Date(end - count * dayMs).toISOString())
  const rows = new Map(layout.tracks.map((track, index) => [track.id, index]))
  const order = new Map(layout.tracks.flatMap(track => [...track.shas].reverse().map((sha, index) => [sha, index] as const)))
  const buckets = Array.from({ length: count }, () => new Map<string, typeof layout.points>())
  for (const point of layout.points) {
    const day = Math.max(0, Math.min(count - 1, Math.floor((Date.parse(point.node.timestamp) - start) / dayMs)))
    const members = buckets[day].get(point.track) ?? []
    members.push(point); buckets[day].set(point.track, members)
  }
  let x = 0
  const points: typeof layout.points = []
  const widths = buckets.map(tracks => Math.max(80, ...[...tracks.values()].map(members => members.length * 28 + 32)))
  const extra = Math.max(0, minimumWidth - widths.reduce((sum, width) => sum + width, 0)) / count
  const days = buckets.map((tracks, index) => {
    const width = widths[index] + extra
    const day = { x, width, start: start + index * dayMs, end: Math.min(end, start + (index + 1) * dayMs) }
    for (const members of tracks.values()) members.sort((left, right) => order.get(left.node.sha)! - order.get(right.node.sha)!).forEach((point, slot) => points.push({ ...point, lane: rows.get(point.track)!, x: x + width / 2 + (slot - (members.length - 1) / 2) * 28 }))
    x += width
    return day
  })
  return { days, points, width: x, rows }
}
