import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Crown, GitBranch, Tag } from 'lucide-react'
import type { GitAtlasComparison, GitAtlasPage } from '../../../../shared/types/git-atlas-types'
import type { GitAtlasCoreEvidence, GitAtlasPrEvidence, GitAtlasEvidenceEvent } from '../../../../shared/types/git-atlas-evidence-types'
import { atlasMergeDescriptions, atlasTrackLabelSize, firstParentPath, layoutGitAtlas, type AtlasMergeContext } from './atlas-layout'
import { atlasTimelineDates, atlasLocalDate, atlasLocalDateRange } from './atlas-presentation'
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
  const left = Math.min(start.x, curveStart.x, curveEnd.x, end.x), top = Math.min(start.y, curveStart.y, curveEnd.y, end.y)
  return { d, bounds: { left: left - 8, top: top - 8, width: Math.max(start.x, curveStart.x, curveEnd.x, end.x) - left + 16, height: Math.max(start.y, curveStart.y, curveEnd.y, end.y) - top + 16 } }
}

export function GitAtlasCanvas({ page, core, enrichment, choosePr, base, focus, mode, comparison, selected, select, focusTrajectory, requestMore, loading }: {
  page: GitAtlasPage | null; base: string; focus: string; mode: string; comparison: GitAtlasComparison | null; selected?: string; select: (sha: string) => void; focusTrajectory: (ref: string, sha: string) => void
  core?: GitAtlasCoreEvidence | null; enrichment?: GitAtlasPrEvidence | null; choosePr?: (number: number) => void
  requestMore?: () => void; loading?: boolean
}) {
  const mergeArrowId = `atlas-merge-${useId().replace(/:/g, '')}`
  const openingSpace = useRef(Math.max(32, window.innerWidth))
  const previous = useRef(new Map<string, number>())
  const scroll = useRef<HTMLDivElement>(null)
  const priorPoints = useRef<ReturnType<typeof layoutGitAtlas>['points']>([])
  const priorRows = useRef(new Map<number, number>())
  const positioned = useRef(false)
  const checkoutSession = useRef<{ branch: string | null; head: string | null } | null>(null)
  const frame = useRef<number | null>(null)
  const pendingDemand = useRef(false)
  const budget = useRef(1)
  const pendingTrack = useRef<string | null>(null)
  const [demand, setDemand] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const layout = useMemo(() => {
    const value = layoutGitAtlas(page, base, previous.current, openingSpace.current)
    if (page) previous.current = new Map(value.tracks.map(track => [track.id, track.lane]))
    return value
  }, [page, base])
  const [viewport, setViewport] = useState({ x: 0, y: 0, width: 1200, height: 900 })
  const viewportSnapshot = useRef(viewport)
  const { points, width: contentWidth } = layout
  const { days, unit } = useMemo(() => atlasTimelineDates(points, { left: viewport.x - 120, right: viewport.x + viewport.width + 120 }), [points, viewport.x, viewport.width])
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
  const labelPlan = useMemo(() => {
    const labels: Array<AtlasLabelBox & { track: typeof layout.tracks[number]; label: string; references: GitAtlasPage['refs']; sha: string; key: string; offset: number }> = []
    for (const track of layout.tracks) {
      const groups = new Map<string, GitAtlasPage['refs']>()
      for (const ref of track.references.filter(ref => ref.kind !== 'HEAD')) groups.set(ref.sha, [...(groups.get(ref.sha) ?? []), ref])
      if (!groups.size) groups.set(track.shas[0], [])
      for (const [sha, references] of groups) {
        const point = pointBySha.get(sha)
        if (!point) continue
        const label = references[0]?.name ?? track.label
        const size = atlasTrackLabelSize(label)
        const width = size.width + (references.length > 1 ? 76 : 0)
        const left = Math.max(16, point.x - Math.min(80, width / 2))
        let offset = sha === page?.head ? 72 : 24
        while (labels.some(item => item.track.lane === track.lane && left < item.left + item.width + 12 && left + width + 12 > item.left && offset < item.offset + item.height + 8 && offset + size.height + 8 > item.offset)) offset += 38
        labels.push({ track, label, references, sha, key: `${track.id}:${sha}`, left, top: 0, width, height: size.height, offset })
      }
    }
    return labels
  }, [layout, pointBySha, page?.head])
  const laneRows = useMemo(() => {
    const heights = new Map<number, number>()
    for (const track of layout.tracks) heights.set(track.lane, 0)
    for (const label of labelPlan) heights.set(label.track.lane, Math.max(heights.get(label.track.lane) ?? 0, label.offset + label.height))
    const rows = new Map<number, number>()
    let offset = 0
    for (const lane of [...heights.keys()].sort((a, b) => a - b)) { rows.set(lane, offset); offset += heights.get(lane)! + 124 }
    return rows
  }, [layout, labelPlan])
  const y = useCallback((lane: number) => 150 + (laneRows.get(lane) ?? 0), [laneRows])
  const nodeHeight = useMemo(() => labelPlan.reduce((height, label) => Math.max(height, y(label.track.lane) + label.offset + label.height + 96), 360), [labelPlan, y])
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
  const labelProjection = useMemo(() => {
    const labels = labelPlan.map(label => ({ ...label, top: y(label.track.lane) + label.offset }))
    const width = labels.reduce((value, label) => Math.max(value, label.left + label.width + 24), contentWidth)
    return { index: atlasVisibilityIndex(labels, item => item), width, height: nodeHeight }
  }, [labelPlan, y, contentWidth, nodeHeight])
  const width = Math.max(labelProjection.width, viewport.width), height = labelProjection.height
  const selectedPoint = selected ? pointBySha.get(selected) : undefined
  const selectedCaption = selectedPoint ? { left: selectedPoint.x - 84, top: y(selectedPoint.lane) - 105, width: 168, height: 70 } : null
  const inlineLabels = labelProjection.index.query(visibleBounds).filter(label => allowed.has(label.track.id) && (!selectedCaption || !atlasBoundsIntersect(label, selectedCaption)))
  const annotations = useMemo(() => {
    const groups = new Map<string, { x: number; created: boolean; events: Array<Exclude<GitAtlasEvidenceEvent, { kind: 'GIT_MERGE_COMMIT' }>> }>()
    if (!page || !enrichment || enrichment.gitSnapshot !== page.snapshot || !points.length) return []
    const start = points.reduce((value, point) => Math.min(value, Date.parse(point.node.timestamp)), Infinity), end = points.reduce((value, point) => Math.max(value, Date.parse(point.node.timestamp)), -Infinity)
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
  }, [enrichment, page, page, points, pointBySha])
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
    const priorCheckout = checkoutSession.current
    if (priorCheckout && (priorCheckout.branch !== page.branch || page.branch === null && priorCheckout.head !== page.head)) positioned.current = false
    checkoutSession.current = { branch: page.branch, head: page.head }
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
      if (anchor && next) { element.scrollLeft += next.x - anchor.x; element.scrollTop += y(next.lane) - (150 + (priorRows.current.get(anchor.lane) ?? 0)) }
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
          {inlineLabels.map(label => {
            const point = pointBySha.get(label.sha)!
            return <path key={`label:${label.key}`} className="gm-atlas-label-anchor" d={`M ${point.x} ${y(point.lane) + 10} L ${point.x} ${label.top}`} fill="none" stroke="var(--border)" strokeWidth={1} />
          })}
        </svg>
        <div className="gm-atlas-date-axis" style={{ width }} aria-label={`Datas por ${unit === 'DAY' ? 'dia' : unit === 'WEEK' ? 'semana' : 'mês'}; ordem dos eventos preservada`}>
          {days.filter(day => day.x + day.width >= viewport.x - 120 && day.x <= viewport.x + viewport.width).map(day => <div key={day.x} className="gm-atlas-date" style={{ left: day.x, width: day.width }} title={atlasLocalDateRange(day.start, day.end, day.repeated)}><span>{day.repeated ? '↶' : atlasLocalDate(day.start, unit)}</span>{!day.repeated && day.end !== day.start && unit !== 'MONTH' && atlasLocalDate(day.start, 'DAY') !== atlasLocalDate(day.end, 'DAY') && <small>até {atlasLocalDate(day.end, 'DAY')}</small>}</div>)}
        </div>
        {inlineLabels.map(({ track, label, references, sha, left, top, width, height, key }) => <div className="gm-atlas-label-group" key={key} data-track={track.id} data-reference-sha={sha} style={{ left, top, width, height }}>
          <button className="gm-atlas-inline-label" title={`${label} · ${references.length ? 'Referência atual neste commit' : 'Trajetória sem nome histórico comprovado'}. Não representa criação ou duração de branch.`} aria-label={`Trajetória ${label}`} aria-pressed={track.id === focus || references.some(ref => ref.ref === focus)} onClick={() => focusTrajectory(references[0]?.ref ?? track.ref ?? sha, sha)}>
            {references.some(ref => ref.ref === base) ? <Crown size={13} /> : <GitBranch size={13} />}<span>{label}</span>
          </button>
          {references.length > 1 && <details className="gm-atlas-ref-aliases"><summary aria-label={`${references.length} referências atuais no mesmo commit`}>+{references.length - 1} refs</summary><div>{references.map(ref => <button key={ref.ref} aria-pressed={ref.ref === focus} onClick={() => focusTrajectory(ref.ref, ref.sha)}>{ref.name}</button>)}</div></details>}
        </div>)}
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
