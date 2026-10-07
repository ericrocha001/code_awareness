import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'

const defaultSplit = { context: 0.16, timeline: 0.48 }
const storageKey = (path: string) => `continuum:columns:${path}`
type Split = typeof defaultSplit

function loadSplit(path: string | null): Split {
  if (path) {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey(path)) ?? 'null') as Split | null
      if (value && Number.isFinite(value.context) && Number.isFinite(value.timeline) &&
        value.context > 0 && value.timeline > 0 && value.context + value.timeline < 1) return value
    } catch {}
  }
  return defaultSplit
}

export function useContinuumColumns(path: string | null) {
  const [split, setSplit] = useState(() => loadSplit(path))
  const current = useRef(split)
  const workspace = useRef<HTMLDivElement>(null)
  useEffect(() => { const loaded = loadSplit(path); current.current = loaded; setSplit(loaded) }, [path])

  const drag = useCallback((boundary: 'context' | 'inspector', delta: number) => {
    const root = workspace.current
    if (!root) return
    const context = root.querySelector<HTMLElement>('.continuum-context')!
    const timeline = root.querySelector<HTMLElement>('.continuum-timeline')!
    const inspector = root.querySelector<HTMLElement>('.continuum-inspector')!
    const wide = getComputedStyle(inspector).position !== 'absolute'
    if (boundary === 'inspector' && !wide) return
    const widths = [context.getBoundingClientRect().width, timeline.getBoundingClientRect().width,
      wide ? inspector.getBoundingClientRect().width : 0]
    const left = boundary === 'context' ? 0 : 1
    const minimumLeft = left === 0 ? 160 : 280
    const room = widths[left] + widths[left + 1]
    if (room < minimumLeft + 280) return
    const newLeft = Math.max(minimumLeft, Math.min(room - 280, widths[left] + delta))
    widths[left] = newLeft; widths[left + 1] = room - newLeft
    const total = widths.reduce((sum, width) => sum + width, 0)
    const visibleShare = wide ? 1 : current.current.context + current.current.timeline
    const next = { context: widths[0] / total * visibleShare, timeline: widths[1] / total * visibleShare }
    current.current = next; setSplit(next)
  }, [])
  const dragContext = useCallback((delta: number) => drag('context', delta), [drag])
  const dragInspector = useCallback((delta: number) => drag('inspector', delta), [drag])
  const persist = useCallback(() => {
    if (path) { try { localStorage.setItem(storageKey(path), JSON.stringify(current.current)) } catch {} }
  }, [path])
  const style = {
    '--continuum-context-track': `${split.context}fr`,
    '--continuum-timeline-track': `${split.timeline}fr`,
    '--continuum-inspector-track': `${1 - split.context - split.timeline}fr`
  } as CSSProperties
  return { workspace, style, dragContext, dragInspector, persist }
}
