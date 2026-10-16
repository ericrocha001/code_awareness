import type { GitAtlasPage, GitAtlasWindow } from '../../../../shared/types/git-atlas-types'
import type { AtlasLayout } from './atlas-layout'

const dayMs = 86400000
export function presentGitAtlas(layout: AtlasLayout, page: GitAtlasPage | null, window: GitAtlasWindow) {
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
  const days = buckets.map((tracks, index) => {
    const width = Math.max(80, ...[...tracks.values()].map(members => members.length * 28 + 32))
    const day = { x, width, start: start + index * dayMs, end: Math.min(end, start + (index + 1) * dayMs) }
    for (const members of tracks.values()) members.sort((left, right) => order.get(left.node.sha)! - order.get(right.node.sha)!).forEach((point, slot) => points.push({ ...point, lane: rows.get(point.track)!, x: x + width / 2 + (slot - (members.length - 1) / 2) * 28 }))
    x += width
    return day
  })
  return { days, points, width: x, rows }
}
