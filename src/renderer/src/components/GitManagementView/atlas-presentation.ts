import type { GitAtlasPage, GitAtlasWindow } from '../../../../shared/types/git-atlas-types'
import type { AtlasLayout } from './atlas-layout'

const dayMs = 86400000
export function atlasWindowPage(page: GitAtlasPage | null, window: GitAtlasWindow): GitAtlasPage | null {
  if (!page || window === 'ALL') return page
  const end = Date.parse(page.anchorAt ?? page.queriedAt), start = end - window * dayMs
  const nodes = page.nodes.filter(node => {
    const timestamp = Date.parse(node.timestamp)
    return timestamp >= start && timestamp <= end
  })
  const since = new Date(start).toISOString()
  return nodes.length === page.nodes.length && page.since === since ? page : { ...page, nodes, since }
}

export function presentGitAtlas(layout: AtlasLayout, page: GitAtlasPage | null, window: GitAtlasWindow, minimumWidth = 0, visibleRange?: { left: number; right: number }) {
  const end = Date.parse(page?.anchorAt ?? page?.queriedAt ?? new Date().toISOString())
  const earliest = layout.points.reduce((time, point) => Math.min(time, Date.parse(point.node.timestamp)), end)
  const span = window === 'ALL' ? (end - earliest) / dayMs : window
  const unit: 'DAY' | 'WEEK' | 'MONTH' = span <= 15 ? 'DAY' : span <= 90 ? 'WEEK' : 'MONTH'
  const days = atlasDateBands(layout.points, unit, visibleRange)
  return { days, points: layout.points, width: Math.max(layout.width, minimumWidth), rows: new Map(layout.tracks.map(track => [track.id, track.lane])), unit }
}

export function atlasDateBands(points: AtlasLayout['points'], unit: 'DAY' | 'WEEK' | 'MONTH', visibleRange?: { left: number; right: number }) {
  const key = (time: number) => {
    const date = new Date(time)
    if (unit === 'MONTH') return `${date.getUTCFullYear()}-${date.getUTCMonth()}`
    const day = Math.floor(time / dayMs)
    return String(unit === 'WEEK' ? Math.floor((day + 3) / 7) : day)
  }
  const days: Array<{ x: number; width: number; start: number; end: number }> = []
  let previousKey = ''
  let start = 0, end = points.length
  if (visibleRange) {
    if (visibleRange.right < visibleRange.left) return days
    let low = 0, high = points.length
    while (low < high) { const middle = Math.floor((low + high) / 2); if (points[middle].x < visibleRange.left) low = middle + 1; else high = middle }
    start = Math.max(0, low - 1)
    low = start; high = points.length
    while (low < high) { const middle = Math.floor((low + high) / 2); if (points[middle].x <= visibleRange.right) low = middle + 1; else high = middle }
    end = Math.min(points.length, low + 1)
  }
  for (let index = start; index < end; index++) {
    const point = points[index]
    const time = Date.parse(point.node.timestamp), currentKey = key(time)
    if (currentKey === previousKey) {
      const band = days[days.length - 1]
      band.width = point.x + 28 - band.x
      band.start = Math.min(band.start, time); band.end = Math.max(band.end, time)
    } else {
      days.push({ x: point.x - 28, width: 56, start: time, end: time })
      previousKey = currentKey
    }
  }
  return days
}
