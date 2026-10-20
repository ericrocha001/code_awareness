export interface AtlasBounds { left: number; top: number; width: number; height: number }

export function atlasBoundsIntersect(a: AtlasBounds, b: AtlasBounds) {
  return a.left <= b.left + b.width && a.left + a.width >= b.left && a.top <= b.top + b.height && a.top + a.height >= b.top
}

export function atlasVisibilityIndex<T>(items: readonly T[], boundsOf: (item: T) => AtlasBounds) {
  type Entry = { item: T; bounds: AtlasBounds }
  interface Branch { bounds: AtlasBounds; entries?: Entry[]; left?: Branch; right?: Branch }
  const build = (entries: Entry[]): Branch | undefined => {
    if (!entries.length) return undefined
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
    for (const entry of entries) {
      left = Math.min(left, entry.bounds.left); top = Math.min(top, entry.bounds.top)
      right = Math.max(right, entry.bounds.left + entry.bounds.width); bottom = Math.max(bottom, entry.bounds.top + entry.bounds.height)
    }
    const bounds = { left, top, width: right - left, height: bottom - top }
    if (entries.length <= 16) return { bounds, entries }
    const horizontal = bounds.width >= bounds.height
    entries.sort((a, b) => horizontal ? a.bounds.left + a.bounds.width / 2 - b.bounds.left - b.bounds.width / 2 : a.bounds.top + a.bounds.height / 2 - b.bounds.top - b.bounds.height / 2)
    const middle = Math.floor(entries.length / 2)
    return { bounds, left: build(entries.slice(0, middle)), right: build(entries.slice(middle)) }
  }
  const root = build(items.map(item => ({ item, bounds: boundsOf(item) })))
  return {
    query(bounds: AtlasBounds): T[] {
      const found: T[] = []
      const visit = (branch: Branch | undefined) => {
        if (!branch || !atlasBoundsIntersect(branch.bounds, bounds)) return
        if (branch.entries) { for (const entry of branch.entries) { if (atlasBoundsIntersect(entry.bounds, bounds)) found.push(entry.item) } }
        else { visit(branch.left); visit(branch.right) }
      }
      visit(root)
      return found
    }
  }
}
