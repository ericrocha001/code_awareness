import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Crown, GitBranch, Tag } from 'lucide-react'
import type { GitAtlasComparison, GitAtlasPage, GitAtlasWindow } from '../../../../shared/types/git-atlas-types'
import type { GitAtlasCoreEvidence, GitAtlasPrEvidence, GitAtlasEvidenceEvent } from '../../../../shared/types/git-atlas-evidence-types'
import { atlasMergeDescriptions, firstParentPath, layoutGitAtlas, type AtlasMergeContext } from './atlas-layout'
import { atlasDateBands, atlasWindowPage, presentGitAtlas } from './atlas-presentation'
import { atlasBoundsIntersect, atlasVisibilityIndex } from './atlas-viewport'

interface AtlasLabelBox { left: number; top: number; width: number; height: number }

function connectionGeometry(px: number, py: number, cx: number, cy: number, secondary: boolean, contribution = 0, contributions = 1) {
  const direction = cx >= px ? 1 : -1
  const side = py === cy ? contribution % 2 === 0 ? -1 : 1 : Math.sign(py - cy)
  const angle = Math.PI / 6 + Math.PI / 6 * contribution / Math.max(1, contributions - 1)
  const start = { x: px + direction * 7, y: py }
  const end = { x: cx - direction * (secondary ? Math.cos(angle) * 20 : 12), y: cy + (secondary ? side * Math.sin(angle) * 20 : 0) }
  const room = Math.max(1, Math.abs(end.x - start.x)), approach = Math.min(18, room / 3)
  const gate = { x: end.x - direction * Math.cos(angle) * approach, y: end.y + side * Math.sin(angle) * approach }
  const transition = secondary ? Math.min(room - approach, Math.max(32, Math.abs(gate.y - py) * .5)) : Math.min(room * .65, Math.max(28, Math.abs(cy - py) * .5))
  const curveStart = secondary ? { x: gate.x - direction * transition, y: py } : start
  const curveEnd = secondary ? gate : { x: start.x + direction * transition, y: cy }
  const xs = [curveStart.x, (curveStart.x + curveEnd.x) / 2, (curveStart.x + curveEnd.x) / 2, curveEnd.x]
  const d = `M ${start.x} ${start.y}${secondary ? ` L ${curveStart.x} ${curveStart.y}` : ''} C ${xs[1]} ${curveStart.y}, ${xs[2]} ${curveEnd.y}, ${curveEnd.x} ${curveEnd.y} L ${end.x} ${end.y}`
  const crosses = (box: AtlasLabelBox) => {
    const top = box.top - 4, bottom = box.top + box.height + 4
    const left = box.left - 4, right = box.left + box.width + 4
    const lineCrosses = (a: { x: number; y: number }, b: { x: number; y: number }) => right >= Math.min(a.x, b.x) && left <= Math.max(a.x, b.x) && bottom >= Math.min(a.y, b.y) && top <= Math.max(a.y, b.y)
    if (lineCrosses(start, curveStart) || lineCrosses(curveEnd, end)) return true
    if (bottom < Math.min(curveStart.y, curveEnd.y) || top > Math.max(curveStart.y, curveEnd.y) || right < Math.min(xs[0], xs[3]) || left > Math.max(xs[0], xs[3])) return false
    if (curveStart.y === curveEnd.y) return true
    const parameter = (target: number) => {
      const ratio = Math.max(0, Math.min(1, (target - curveStart.y) / (curveEnd.y - curveStart.y)))
      let low = 0, high = 1
      for (let step = 0; step < 12; step++) { const t = (low + high) / 2; if (t * t * (3 - 2 * t) < ratio) low = t; else high = t }
      return (low + high) / 2
    }
    const xAt = (t: number) => (1 - t) ** 3 * xs[0] + 3 * (1 - t) ** 2 * t * xs[1] + 3 * (1 - t) * t * t * xs[2] + t ** 3 * xs[3]
    const limits = [xAt(parameter(top)), xAt(parameter(bottom))]
    return left <= Math.max(...limits) && right >= Math.min(...limits)
  }
  const left = Math.min(start.x, curveStart.x, curveEnd.x, end.x), top = Math.min(start.y, curveStart.y, curveEnd.y, end.y)
  return { d, crosses, bounds: { left: left - 8, top: top - 8, width: Math.max(start.x, curveStart.x, curveEnd.x, end.x) - left + 16, height: Math.max(start.y, curveStart.y, curveEnd.y, end.y) - top + 16 } }
}

export function GitAtlasCanvas({ page, core, enrichment, choosePr, windowDays, base, focus, mode, comparison, selected, select, focusTrajectory, requestMore, loading }: {
  page: GitAtlasPage | null; windowDays: GitAtlasWindow; base: string; focus: string; mode: string; comparison: GitAtlasComparison | null; selected?: string; select: (sha: string) => void; focusTrajectory: (ref: string, sha: string) => void
  core?: GitAtlasCoreEvidence | null; enrichment?: GitAtlasPrEvidence | null; choosePr?: (number: number) => void
  requestMore?: () => void; loading?: boolean
}) {
  const mergeArrowId = `atlas-merge-${useId().replace(/:/g, '')}`
  const previous = useRef(new Map<string, number>())
  const scroll = useRef<HTMLDivElement>(null)
  const priorPoints = useRef<ReturnType<typeof layoutGitAtlas>['points']>([])
  const priorRows = useRef(new Map<number, number>())
  const positioned = useRef(false)
  const frame = useRef<number | null>(null)
  const pendingDemand = useRef(false)
  const budget = useRef(1)
  const pendingTrack = useRef<string | null>(null)
  const [demand, setDemand] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const windowPage = useMemo(() => atlasWindowPage(page, windowDays), [page, windowDays])
  const layout = useMemo(() => {
    const value = layoutGitAtlas(windowPage, base, previous.current)
    if (windowPage) previous.current = new Map(value.tracks.map(track => [track.id, track.lane]))
    return value
  }, [windowPage, base])
  const [viewport, setViewport] = useState({ x: 0, y: 0, width: 1200, height: 900 })
  const viewportSnapshot = useRef(viewport)
  const { points, width: contentWidth, unit } = useMemo(() => presentGitAtlas(layout, windowPage, windowDays, 0, { left: 0, right: -1 }), [layout, windowPage, windowDays])
  const width = Math.max(contentWidth, viewport.width)
  const days = useMemo(() => atlasDateBands(points, unit, { left: viewport.x - 120, right: viewport.x + viewport.width + 120 }), [points, unit, viewport.x, viewport.width])
  const pointBySha = useMemo(() => new Map(points.map(point => [point.node.sha, point])), [points])
  const tagsBySha = useMemo(() => {
    const tags = new Map<string, NonNullable<GitAtlasPage['tags']>>()
    for (const tag of page?.tags ?? []) tags.set(tag.sha, [...(tags.get(tag.sha) ?? []), tag])
    return tags
  }, [page?.tags])
  const hasSkew = useMemo(() => layout.edges.some(edge => edge.skew), [layout])
  const integrated = useMemo(() => new Set(layout.edges.filter(edge => edge.secondary).map(edge => pointBySha.get(edge.parent)?.track)), [layout, pointBySha])
  const allowedTracks = useMemo(() => layout.tracks.filter(track => showAll || track.ref || track.detached || integrated.has(track.id) || track.shas.includes(selected ?? '') || track.shas.includes(page?.head ?? '') || track.id === focus || track.shas.includes(focus)), [layout, showAll, integrated, selected, page?.head, focus])
  const hidden = layout.tracks.length - allowedTracks.length
  const allowed = useMemo(() => new Set(allowedTracks.map(track => track.id)), [allowedTracks])
  const laneRows = useMemo(() => new Map([...new Set(layout.tracks.map(track => track.lane))].sort((a, b) => a - b).map((lane, index) => [lane, index])), [layout])
  const y = useCallback((lane: number) => 150 + (laneRows.get(lane) ?? lane) * 88, [laneRows])
  const height = Math.max(360, laneRows.size * 88 + 180)
  const nodeIndex = useMemo(() => atlasVisibilityIndex(points, point => ({ left: point.x - 100, top: y(point.lane) - 110, width: 200, height: 180 })), [points, y])
  const visibleBounds = { left: viewport.x - 120, top: viewport.y - 100, width: viewport.width + 240, height: viewport.height + 200 }
  const visible = nodeIndex.query(visibleBounds).filter(point => allowed.has(point.track)).sort((a, b) => a.x - b.x)
  const visibleShas = new Set(visible.map(point => point.node.sha))
  const trackById = useMemo(() => new Map(layout.tracks.map(track => [track.id, track])), [layout])
  const path = useMemo(() => firstParentPath(new Map((page?.nodes ?? []).map(node => [node.sha, node])), page?.refs.find(ref => ref.ref === focus)?.sha ?? focus), [page, focus])
  const exclusive = useMemo(() => new Set([...(comparison?.exclusive.left ?? []), ...(comparison?.exclusive.right ?? []), ...(comparison?.mergeBases ?? [])]), [comparison])
  const active = (sha: string) => mode === 'Panorama' || (mode === 'Foco' ? path.has(sha) : exclusive.has(sha)) || selected === sha
  const allConnections = useMemo(() => layout.edges.flatMap(edge => {
    const child = pointBySha.get(edge.child), parent = pointBySha.get(edge.parent)
    if (!child || !parent) return []
    const cy = y(child.lane), py = y(parent.lane)
    const mergeContext: AtlasMergeContext = child.mergeContext ?? 'UNKNOWN'
    return [{ edge, mergeContext, ...connectionGeometry(parent.x, py, child.x, cy, edge.secondary, Math.max(0, child.node.parents.indexOf(edge.parent) - 1), child.node.parents.length - 1) }]
  }), [layout, pointBySha, y])
  const connectionIndex = useMemo(() => atlasVisibilityIndex(allConnections, item => item.bounds), [allConnections])
  const connections = connectionIndex.query(visibleBounds).filter(item => allowed.has(pointBySha.get(item.edge.child)!.track) && allowed.has(pointBySha.get(item.edge.parent)!.track))
  const anchorIndex = useMemo(() => atlasVisibilityIndex(layout.anchors, anchor => {
    const point = pointBySha.get(anchor.child)
    return { left: (point?.x ?? 0) - 40, top: y(point?.lane ?? 0) - 24, width: 40, height: 30 }
  }), [layout, pointBySha, y])
  const anchors = anchorIndex.query(visibleBounds)
  const overlaps = (a: AtlasLabelBox, b: AtlasLabelBox) => a.left < b.left + b.width + 6 && a.left + a.width + 6 > b.left && a.top < b.top + b.height + 4 && a.top + a.height + 4 > b.top
  const labelIndex = useMemo(() => {
    const protectedBoxes: AtlasLabelBox[] = [{ left: 0, top: 0, width: contentWidth, height: 136 }, ...points.flatMap(point => {
      const boxes = [{ left: point.x - 18, top: y(point.lane) - 18, width: 36, height: 36 }]
      if (windowPage?.tags.some(tag => tag.sha === point.node.sha)) boxes.push({ left: point.x - 84, top: y(point.lane) - 105, width: 168, height: 70 })
      if (point.node.sha === windowPage?.head) boxes.push({ left: point.x - 64, top: y(point.lane) + 30, width: 128, height: 28 })
      return boxes
    })]
    const protectedIndex = atlasVisibilityIndex(protectedBoxes, box => ({ left: box.left - 6, top: box.top - 4, width: box.width + 12, height: box.height + 8 }))
    const inlineLabels: Array<AtlasLabelBox & { track: typeof layout.tracks[number]; continued: boolean; key: string }> = []
    for (const track of [...layout.tracks].sort((a, b) => Number(b.ref === base) - Number(a.ref === base) || a.lane - b.lane || a.start - b.start || a.id.localeCompare(b.id))) {
      const first = pointBySha.get(track.shas[track.shas.length - 1])!, last = pointBySha.get(track.shas[0])!
      for (let tile = Math.floor((first.x - 20) / 512); tile <= Math.floor((last.x + 20) / 512); tile++) {
        const left = Math.max(first.x - 20, tile * 512 + 12), right = Math.min(last.x + 20, (tile + 1) * 512 - 12)
        if (right <= left) continue
        const width = Math.min(192, Math.max(36, right - left))
        const candidates = [left, Math.min(right - width, left + 56), right - width]
        let box: AtlasLabelBox | undefined
        for (const top of [y(track.lane) - 42, y(track.lane) + 48, y(track.lane) - 66]) {
          for (const x of candidates) {
            const candidate = { left: Math.max(left, x), top, width, height: 24 }
            if (!protectedIndex.query(candidate).length && !inlineLabels.some(item => overlaps(candidate, item)) && !connectionIndex.query(candidate).some(item => item.crosses(candidate))) { box = candidate; break }
          }
          if (box) break
        }
        if (!box) {
          const candidate = { left, top: y(track.lane) - 42, width: 36, height: 24 }
          if (!protectedIndex.query(candidate).length && !inlineLabels.some(item => overlaps(candidate, item)) && !connectionIndex.query(candidate).some(item => item.crosses(candidate))) box = candidate
        }
        if (box) inlineLabels.push({ ...box, track, key: `${track.id}:${tile}`, continued: first.x < tile * 512 || first.node.parents.length > 0 })
      }
    }
    return atlasVisibilityIndex(inlineLabels, item => item)
  }, [layout, points, pointBySha, y, windowPage, contentWidth, connectionIndex, base])
  const selectedPoint = selected ? pointBySha.get(selected) : undefined
  const selectedCaption = selectedPoint ? { left: selectedPoint.x - 84, top: y(selectedPoint.lane) - 105, width: 168, height: 70 } : null
  const inlineLabels = labelIndex.query(visibleBounds).filter(label => allowed.has(label.track.id) && label.top > viewport.y + 66 && (!selectedCaption || !atlasBoundsIntersect(label, selectedCaption)))
  const annotations = useMemo(() => {
    const groups = new Map<string, { x: number; created: boolean; events: Array<Exclude<GitAtlasEvidenceEvent, { kind: 'GIT_MERGE_COMMIT' }>> }>()
    if (!page || !enrichment || enrichment.gitSnapshot !== page.snapshot || !points.length) return []
    const start = Date.parse(windowPage?.since ?? '1970-01-01'), end = Date.parse(page.anchorAt ?? page.queriedAt)
    const chronological = [...points].sort((a, b) => Date.parse(a.node.timestamp) - Date.parse(b.node.timestamp) || a.node.sha.localeCompare(b.node.sha))
    for (const event of enrichment.events) {
      if (event.kind === 'GIT_MERGE_COMMIT') continue
      const at = Date.parse(event.at)
      if (at < start || at > end) continue
      let low = 0, high = chronological.length - 1
      while (low < high) { const middle = Math.floor((low + high) / 2); if (Date.parse(chronological[middle].node.timestamp) < at) low = middle + 1; else high = middle }
      const exact = event.kind === 'PR_MERGED' && event.mergeCommitSha ? pointBySha.get(event.mergeCommitSha) : null
      const x = exact?.x ?? chronological[low].x, created = event.kind === 'PR_CREATED'
      const key = `${event.kind}:${x}`
      const group = groups.get(key) ?? { x, created, events: [] }
      group.events.push(event); groups.set(key, group)
    }
    return [...groups.values()]
  }, [enrichment, page, windowPage, points, pointBySha])
  const scheduleViewport = useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const element = scroll.current
      if (!element) return
      const next = { x: element.scrollLeft, y: element.scrollTop, width: element.clientWidth, height: element.clientHeight }
      const previous = viewportSnapshot.current
      if (previous.x !== next.x || previous.y !== next.y || previous.width !== next.width || previous.height !== next.height) { viewportSnapshot.current = next; setViewport(next) }
      if (pendingDemand.current) { pendingDemand.current = false; setDemand(value => value + 1) }
    })
  }, [])
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); pendingDemand.current = false }, [])
  useEffect(() => {
    if (!page || !requestMore || loading || budget.current <= 0 || !points.length) return
    const first = points[0]
    if (scroll.current && scroll.current.scrollLeft <= first.x + 160) { budget.current--; requestMore() }
  }, [page, loading, demand, viewport.x, points, requestMore])
  useLayoutEffect(() => {
    const element = scroll.current
    if (!page || !element || !points.length) return
    if (!positioned.current) {
      const head = pointBySha.get(page.head ?? '') ?? points.at(-1)
      element.scrollLeft = Math.max(0, (head?.x ?? 0) - element.clientWidth * .75)
      element.scrollTop = 0
      positioned.current = true
    } else {
      const prior = priorPoints.current
      let low = 0, high = prior.length
      while (low < high) { const middle = Math.floor((low + high) / 2); if (prior[middle].x < element.scrollLeft) low = middle + 1; else high = middle }
      const anchor = prior[Math.min(low, prior.length - 1)]
      const next = anchor ? pointBySha.get(anchor.node.sha) : null
      if (anchor && next) { element.scrollLeft += next.x - anchor.x; element.scrollTop += y(next.lane) - (150 + (priorRows.current.get(anchor.lane) ?? anchor.lane) * 88) }
    }
    priorPoints.current = points
    priorRows.current = laneRows
    scheduleViewport()
  }, [points, pointBySha, y, laneRows, scheduleViewport])
  useLayoutEffect(() => {
    const element = scroll.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(scheduleViewport)
    observer.observe(element)
    return () => observer.disconnect()
  }, [scheduleViewport])
  useLayoutEffect(() => {
    const element = scroll.current, track = pendingTrack.current ? trackById.get(pendingTrack.current) : null
    if (!element || !track) return
    const point = pointBySha.get(track.shas[0])
    if (!point) return
    pendingTrack.current = null
    element.scrollLeft = Math.max(0, point.x - 180)
    element.scrollTop = Math.max(0, y(point.lane) - 180)
    scheduleViewport()
  }, [showAll, trackById, pointBySha, y, scheduleViewport])
  const demandMore = () => {
    if (!requestMore || loading || budget.current > 0 || !points.length || !scroll.current || scroll.current.scrollLeft > points[0].x + 160) return
    budget.current = 1; pendingDemand.current = true; scheduleViewport()
  }
  const trajectoryOptions = useMemo(() => {
    const known = new Set([...layout.tracks.flatMap(track => track.ref ? [track.ref] : []), ...layout.inactive.map(ref => ref.ref)])
    return <div className="gm-atlas-track-list">
      {layout.tracks.map(track => <button key={track.id} onClick={() => { pendingTrack.current = track.id; setShowAll(true); focusTrajectory(track.ref ?? track.shas[0], track.shas[0]) }}>{track.label}</button>)}
      {layout.inactive.map(ref => <button key={ref.ref} onClick={() => focusTrajectory(ref.ref, ref.sha)}>{ref.name} · ponta fora do trecho carregado</button>)}
      {page?.refs.filter(ref => ref.kind !== 'HEAD' && !known.has(ref.ref)).map(ref => <button key={ref.ref} onClick={() => focusTrajectory(ref.ref, ref.sha)}>{ref.name} · referência atual no trecho compartilhado</button>)}
    </div>
  }, [layout, page?.refs, focusTrajectory])
  return <>
    <div className="gm-atlas-visibility">
      <span>{allowedTracks.length} trajetórias visíveis{hidden ? ` · ${hidden} sem referência atual ou integração visível ocultas` : ''}</span>
      {(hidden > 0 || showAll) && <button aria-pressed={showAll} onClick={() => setShowAll(value => !value)}>{showAll ? 'Mostrar relevantes' : `Mostrar todas (${layout.tracks.length})`}</button>}
      <details><summary>Localizar trajetória ou referência</summary>{trajectoryOptions}</details>
    </div>
    {core?.checkout.head && !pointBySha.has(core.checkout.head) && <p className="gm-atlas-note">Você está aqui: {core.checkout.head.slice(0, 8)} · HEAD fora do trecho visível.</p>}
    {hasSkew && <div className="gm-atlas-note" role="status">Há datas invertidas. A ordem causal é preservada; conexões correspondentes são tracejadas.</div>}
    <div ref={scroll} className="gm-atlas-scroll" tabIndex={0} aria-label="Mapa Git por eventos; role para explorar" onWheel={demandMore} onPointerDown={demandMore} onKeyDown={demandMore} onScroll={scheduleViewport}>
      <div className="gm-atlas-surface" style={{ width, height }}>
        <svg className="gm-atlas-lines" width={width} height={height} aria-label="Relações reais entre commits">
          <defs>{(['base', 'neutral'] as const).map(tone => <marker key={tone} id={`${mergeArrowId}-${tone}`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={6} markerHeight={6} markerUnits="userSpaceOnUse" orient="auto"><path d="M 1 1 L 7 4 L 1 7" fill="none" stroke={tone === 'base' ? 'var(--accent)' : 'var(--text-secondary)'} strokeWidth={1.6} /></marker>)}</defs>
          {days.filter(day => day.x + day.width >= viewport.x - 120 && day.x <= viewport.x + viewport.width).map(day => <line key={day.x} x1={day.x} x2={day.x} y1={66} y2={height} stroke="var(--border)" strokeDasharray="2 8" opacity=".35" />)}
          {connections.map(({ edge, d, mergeContext }) => <path key={`${edge.child}:${edge.parent}`} data-child={edge.child} data-parent={edge.parent} data-receiving-track={edge.receivingTrack} d={d} fill="none" stroke={edge.secondary && mergeContext === 'BASE' ? 'var(--accent)' : 'var(--text-secondary)'} strokeWidth={edge.secondary && mergeContext === 'BASE' ? 2.5 : 1.8} markerEnd={edge.secondary ? `url(#${mergeArrowId}-${mergeContext === 'BASE' ? 'base' : 'neutral'})` : undefined} opacity={active(edge.child) && active(edge.parent) ? .9 : .18} strokeDasharray={edge.skew ? '5 3' : undefined}><title>{edge.secondary ? `${atlasMergeDescriptions[mergeContext]} · contribuição secundária → M; nome histórico de destino não inferido` : 'Continuidade do primeiro pai'}: {edge.parent} → {edge.child}{edge.skew ? ' · datas invertidas' : ''}</title></path>)}
          {anchors.map(anchor => {
            const point = pointBySha.get(anchor.child)
            return point && visibleShas.has(anchor.child) ? <g key={`${anchor.child}:${anchor.parent}`}><path d={`M ${point.x - 24} ${y(point.lane)} L ${point.x - 9} ${y(point.lane)}`} stroke="var(--text-secondary)" strokeDasharray="3 3" /><text x={point.x - 30} y={y(point.lane) - 13} fill="var(--text-secondary)" fontSize="11">…<title>Pai {anchor.parent} fora do trecho carregado</title></text></g> : null
          })}
        </svg>
        <div className="gm-atlas-date-axis" style={{ width }} aria-label={`Datas por ${unit === 'DAY' ? 'dia' : unit === 'WEEK' ? 'semana' : 'mês'}; ordem dos eventos preservada`}>
          {days.filter(day => day.x + day.width >= viewport.x - 120 && day.x <= viewport.x + viewport.width).map(day => <div key={day.x} className="gm-atlas-date" style={{ left: day.x, width: day.width }} title={`${new Date(day.start).toLocaleString()} — ${new Date(day.end).toLocaleString()}`}><span>{new Date(day.start).toLocaleDateString(undefined, unit === 'MONTH' ? { month: 'short', year: 'numeric' } : { day: '2-digit', month: 'short' })}</span>{day.end !== day.start && unit !== 'MONTH' && <small>até {new Date(day.end).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}</small>}</div>)}
        </div>
        {inlineLabels.map(({ track, left, top, width, continued, key }) => <button className={`gm-atlas-inline-label ${width < 80 ? 'is-compact' : ''}`} key={key} data-track={track.id} style={{ left, top, width }} title={`${track.label}${track.references.length ? ` · referências atuais no trecho: ${track.references.map(ref => ref.name).join(', ')}` : ''}. Rótulo de contexto; não marca criação ou encerramento de branch.`} aria-label={`Trajetória ${track.label}${continued ? ', continuidade anterior' : ''}`} aria-pressed={track.id === focus || track.references.some(ref => ref.ref === focus)} onClick={() => focusTrajectory(track.ref ?? track.shas[0], track.shas[0])}>
          {track.ref === base ? <Crown size={13} /> : <GitBranch size={13} />}<span>{continued ? '… ' : ''}{track.label}</span>{track.references.filter(ref => ref.kind !== 'HEAD').length > 1 && <small>+{track.references.filter(ref => ref.kind !== 'HEAD').length - 1}</small>}
        </button>)}
        {annotations.filter(group => group.x >= viewport.x - 120 && group.x <= viewport.x + viewport.width).map(group => <details key={`${group.created}:${group.x}`} className={`gm-pr-annotation ${group.created ? 'is-created' : 'is-integrated'}`} style={{ left: group.x, top: group.created ? 78 : 106 }}>
          <summary aria-label={`${group.created ? 'PR criado' : 'PR integrado'} #${group.events[0].prNumber}${group.events.length > 1 ? ` e mais ${group.events.length - 1}` : ''}`} title="Anotação temporal aproximada; não representa um commit nem comprova intervalo aberto">{group.created ? '+' : '↗'} #{group.events[0].prNumber}{group.events.length > 1 ? ` +${group.events.length - 1}` : ''}</summary>
          <div>{group.events.map(event => <button key={`${event.kind}:${event.prNumber}`} onClick={() => choosePr?.(event.prNumber)}>#{event.prNumber} · {new Date(event.at).toLocaleString()}{event.kind === 'PR_MERGED' && event.integrationMethod === 'MERGED_METHOD_UNKNOWN' ? ' · método não identificado' : ''}</button>)}</div>
        </details>)}
        {visible.map(point => {
          const track = trackById.get(point.track)!, tags = tagsBySha.get(point.node.sha) ?? []
          const merge = point.node.parents.length > 1
          const mergeContext = point.mergeContext ?? 'UNKNOWN'
          const head = core?.checkout.head === point.node.sha
          return <button className={`gm-commit gm-atlas-node ${merge ? `is-merge is-merge-${mergeContext.toLowerCase()}` : ''} ${head ? 'is-checkout' : ''} ${active(point.node.sha) ? '' : 'is-muted'}`} style={{ left: point.x, top: y(point.lane) } as React.CSSProperties} key={point.node.sha} data-sha={point.node.sha} aria-label={`${head ? 'Você está aqui. ' : ''}${merge ? `${atlasMergeDescriptions[mergeContext]}. ` : ''}${point.node.subject} · ${point.node.sha.slice(0, 8)}`} aria-pressed={point.node.sha === selected} onClick={() => select(point.node.sha)}>
            <span className="gm-atlas-dot">{merge ? 'M' : null}</span>
            {head && <span className="gm-checkout-marker">Você está aqui</span>}
            {(point.node.sha === selected || tags.length > 0) && <span className="gm-node-caption">{tags.length > 0 && <Tag size={15} />}<span>{tags.length ? tags.map(tag => tag.name).join(', ') : point.node.subject}</span></span>}
            <span className="gm-node-tooltip">{track.label}{merge && <><br />{atlasMergeDescriptions[mergeContext]}</>}<br />{point.node.subject}<br />{point.node.author} · {new Date(point.node.timestamp).toLocaleString()}<br />{point.node.sha.slice(0, 12)}{track.references.filter(ref => ref.sha === point.node.sha).map(ref => <React.Fragment key={ref.ref}><br />Referência atual · {ref.name}</React.Fragment>)}{page?.detachedHeads.filter(item => item.sha === point.node.sha).map((item, index) => <React.Fragment key={`${item.name}:${index}`}><br />HEAD detached observado · {item.name}</React.Fragment>)}</span>
          </button>
        })}
      </div>
    </div>
  </>
}
