import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Crown, GitBranch, Tag } from 'lucide-react'
import type { GitAtlasComparison, GitAtlasPage, GitAtlasWindow } from '../../../../shared/types/git-atlas-types'
import type { GitAtlasCoreEvidence, GitAtlasPrEvidence, GitAtlasEvidenceEvent } from '../../../../shared/types/git-atlas-evidence-types'
import { atlasMergeDescriptions, firstParentPath, layoutGitAtlas, type AtlasMergeContext } from './atlas-layout'
import { atlasWindowPage, presentGitAtlas } from './atlas-presentation'

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
  return { d, crosses }
}

export function GitAtlasCanvas({ page, core, enrichment, choosePr, windowDays, base, focus, mode, comparison, selected, select, focusTrajectory, requestMore, loading }: {
  page: GitAtlasPage | null; windowDays: GitAtlasWindow; base: string; focus: string; mode: string; comparison: GitAtlasComparison | null; selected?: string; select: (sha: string) => void; focusTrajectory: (ref: string, sha: string) => void
  core?: GitAtlasCoreEvidence | null; enrichment?: GitAtlasPrEvidence | null; choosePr?: (number: number) => void
  requestMore?: () => void; loading?: boolean
}) {
  const mergeArrowId = `atlas-merge-${useId().replace(/:/g, '')}`
  const previous = useRef(new Map<string, number>())
  const scroll = useRef<HTMLDivElement>(null)
  const positionedSnapshot = useRef<string | null>(null)
  const previousHeadX = useRef(0)
  const previousWidth = useRef(0)
  const budget = useRef(1)
  const pendingTrack = useRef<string | null>(null)
  const [demand, setDemand] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const windowPage = useMemo(() => atlasWindowPage(page, windowDays), [page, windowDays])
  const layout = useMemo(() => {
    const value = layoutGitAtlas(windowPage, base, previous.current)
    previous.current = new Map(value.tracks.map(track => [track.id, track.lane]))
    return value
  }, [windowPage, base])
  const [viewport, setViewport] = useState({ x: 0, y: 0, width: 1200, height: 900 })
  const { points, width, days, unit } = useMemo(() => presentGitAtlas(layout, windowPage, windowDays, viewport.width), [layout, windowPage, windowDays, viewport.width])
  const pointBySha = useMemo(() => new Map(points.map(point => [point.node.sha, point])), [points])
  const integrated = new Set(layout.edges.filter(edge => edge.secondary).map(edge => pointBySha.get(edge.parent)?.track))
  const allowedTracks = layout.tracks.filter(track => showAll || track.ref || track.detached || integrated.has(track.id) || track.shas.includes(selected ?? '') || track.shas.includes(page?.head ?? '') || track.id === focus || track.shas.includes(focus))
  const hidden = layout.tracks.length - allowedTracks.length
  const allowed = new Set(allowedTracks.map(track => track.id))
  const shown = points.filter(point => allowed.has(point.track))
  const laneRows = new Map([...new Set(allowedTracks.map(track => track.lane))].sort((a, b) => a - b).map((lane, index) => [lane, index]))
  const y = (lane: number) => 150 + (laneRows.get(lane) ?? lane) * 88
  const height = Math.max(360, laneRows.size * 88 + 180)
  const visible = shown.filter(point => point.x > viewport.x - 100 && point.x < viewport.x + viewport.width + 100 && y(point.lane) > viewport.y - 100 && y(point.lane) < viewport.y + viewport.height + 100)
  const trackById = new Map(layout.tracks.map(track => [track.id, track]))
  const path = firstParentPath(new Map((page?.nodes ?? []).map(node => [node.sha, node])), page?.refs.find(ref => ref.ref === focus)?.sha ?? focus)
  const exclusive = new Set([...(comparison?.exclusive.left ?? []), ...(comparison?.exclusive.right ?? []), ...(comparison?.mergeBases ?? [])])
  const active = (sha: string) => mode === 'Panorama' || (mode === 'Foco' ? path.has(sha) : exclusive.has(sha)) || selected === sha
  const connections = layout.edges.flatMap(edge => {
    const child = pointBySha.get(edge.child), parent = pointBySha.get(edge.parent)
    if (!child || !parent || !allowed.has(child.track) || !allowed.has(parent.track) || Math.max(child.x, parent.x) < viewport.x - 120 || Math.min(child.x, parent.x) > viewport.x + viewport.width) return []
    const cy = y(child.lane), py = y(parent.lane)
    if (Math.max(cy, py) < viewport.y - 100 || Math.min(cy, py) > viewport.y + viewport.height + 100) return []
    const mergeContext: AtlasMergeContext = child.mergeContext ?? 'UNKNOWN'
    return [{ edge, mergeContext, ...connectionGeometry(parent.x, py, child.x, cy, edge.secondary, Math.max(0, child.node.parents.indexOf(edge.parent) - 1), child.node.parents.length - 1) }]
  })
  const overlaps = (a: AtlasLabelBox, b: AtlasLabelBox) => a.left < b.left + b.width + 6 && a.left + a.width + 6 > b.left && a.top < b.top + b.height + 4 && a.top + a.height + 4 > b.top
  const protectedBoxes: AtlasLabelBox[] = [{ left: viewport.x, top: viewport.y, width: viewport.width, height: 66 }, { left: viewport.x, top: 0, width: viewport.width, height: 136 }, ...visible.flatMap(point => {
    const boxes = [{ left: point.x - 18, top: y(point.lane) - 18, width: 36, height: 36 }]
    if (point.node.sha === selected || page?.tags.some(tag => tag.sha === point.node.sha)) boxes.push({ left: point.x - 84, top: y(point.lane) - 105, width: 168, height: 70 })
    if (point.node.sha === core?.checkout.head) boxes.push({ left: point.x - 64, top: y(point.lane) + 30, width: 128, height: 28 })
    return boxes
  })]
  const priority = (track: typeof allowedTracks[number]) => Number(track.id === focus || track.references.some(ref => ref.ref === focus) || track.shas.includes(selected ?? '')) * 2 + Number(track.ref === base)
  const inlineLabels: Array<AtlasLabelBox & { track: typeof allowedTracks[number]; continued: boolean }> = []
  for (const track of [...allowedTracks].sort((a, b) => priority(b) - priority(a) || a.lane - b.lane || a.start - b.start || a.id.localeCompare(b.id))) {
    const first = pointBySha.get(track.shas[track.shas.length - 1])!, last = pointBySha.get(track.shas[0])!
    const left = Math.max(first.x - 20, viewport.x + 12), right = Math.min(last.x + 20, viewport.x + viewport.width - 12)
    if (right <= left || y(track.lane) < viewport.y + 110 || y(track.lane) > viewport.y + viewport.height + 60) continue
    const width = Math.min(192, Math.max(36, viewport.x + viewport.width - 12 - left))
    const candidates = [left, Math.min(right - width, left + 56), right - width]
    let box: AtlasLabelBox | undefined
    for (const top of [y(track.lane) - 42, y(track.lane) + 48, y(track.lane) - 66]) {
      for (const x of candidates) {
        const candidate = { left: Math.max(left, x), top, width, height: 24 }
        if (!protectedBoxes.some(item => overlaps(candidate, item)) && !inlineLabels.some(item => overlaps(candidate, item)) && !connections.some(item => item.crosses(candidate))) { box = candidate; break }
      }
      if (box) break
    }
    if (!box) {
      const candidate = { left, top: y(track.lane) - 42, width: 36, height: 24 }
      if (!protectedBoxes.some(item => overlaps(candidate, item)) && !inlineLabels.some(item => overlaps(candidate, item)) && !connections.some(item => item.crosses(candidate))) box = candidate
    }
    if (box) inlineLabels.push({ ...box, track, continued: first.x < viewport.x || first.node.parents.length > 0 })
  }
  const annotations = useMemo(() => {
    const groups = new Map<string, { x: number; created: boolean; events: Array<Exclude<GitAtlasEvidenceEvent, { kind: 'GIT_MERGE_COMMIT' }>> }>()
    if (!page || !enrichment || enrichment.gitSnapshot !== page.snapshot || !points.length) return []
    const start = Date.parse(windowPage?.since ?? '1970-01-01'), end = Date.parse(page.queriedAt)
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
  useEffect(() => {
    if (!page || !requestMore || loading || budget.current <= 0 || !points.length) return
    const first = points[0]
    if (viewport.x <= first.x + 160) { budget.current--; requestMore() }
  }, [page, loading, demand, viewport.x, points, requestMore])
  useLayoutEffect(() => {
    const element = scroll.current
    if (!page || !element) { positionedSnapshot.current = null; previousHeadX.current = 0; return }
    const head = pointBySha.get(page.head ?? '') ?? points.at(-1)
    if (positionedSnapshot.current !== page.snapshot) {
      element.scrollLeft = Math.max(0, (head?.x ?? 0) - element.clientWidth * .75)
      element.scrollTop = 0
    } else if (selected && previousWidth.current !== element.clientWidth) {
      const anchor = pointBySha.get(selected)
      if (anchor) element.scrollLeft = Math.max(0, anchor.x - element.clientWidth * .65)
    } else element.scrollLeft += (head?.x ?? 0) - previousHeadX.current
    previousWidth.current = element.clientWidth
    positionedSnapshot.current = page.snapshot
    previousHeadX.current = head?.x ?? 0
    setViewport({ x: element.scrollLeft, y: element.scrollTop, width: element.clientWidth, height: element.clientHeight })
  }, [page, layout, viewport.width, selected])
  useLayoutEffect(() => {
    const element = scroll.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewport({ x: element.scrollLeft, y: element.scrollTop, width: element.clientWidth, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const element = scroll.current, track = pendingTrack.current ? trackById.get(pendingTrack.current) : null
    if (!element || !track) return
    const point = pointBySha.get(track.shas[0])
    if (!point) return
    pendingTrack.current = null
    element.scrollLeft = Math.max(0, point.x - 180)
    element.scrollTop = Math.max(0, y(point.lane) - 180)
    setViewport({ x: element.scrollLeft, y: element.scrollTop, width: element.clientWidth, height: element.clientHeight })
  }, [showAll, layout, selected])
  const demandMore = () => { budget.current = 1; setDemand(value => value + 1) }
  return <>
    <div className="gm-atlas-visibility">
      <span>{allowedTracks.length} trajetórias visíveis{hidden ? ` · ${hidden} sem referência atual ou integração visível ocultas` : ''}</span>
      {(hidden > 0 || showAll) && <button aria-pressed={showAll} onClick={() => setShowAll(value => !value)}>{showAll ? 'Mostrar relevantes' : `Mostrar todas (${layout.tracks.length})`}</button>}
      <details><summary>Localizar trajetória ou referência</summary><div className="gm-atlas-track-list">
        {layout.tracks.map(track => <button key={track.id} onClick={() => { pendingTrack.current = track.id; setShowAll(true); focusTrajectory(track.ref ?? track.shas[0], track.shas[0]) }}>{track.label}</button>)}
        {layout.inactive.map(ref => <button key={ref.ref} onClick={() => focusTrajectory(ref.ref, ref.sha)}>{ref.name} · ponta fora do trecho carregado</button>)}
        {page?.refs.filter(ref => ref.kind !== 'HEAD' && !layout.tracks.some(track => track.ref === ref.ref) && !layout.inactive.some(item => item.ref === ref.ref)).map(ref => <button key={ref.ref} onClick={() => focusTrajectory(ref.ref, ref.sha)}>{ref.name} · referência atual no trecho compartilhado</button>)}
      </div></details>
    </div>
    {core?.checkout.head && !pointBySha.has(core.checkout.head) && <p className="gm-atlas-note">Você está aqui: {core.checkout.head.slice(0, 8)} · HEAD fora do trecho visível.</p>}
    {layout.edges.some(edge => edge.skew) && <div className="gm-atlas-note" role="status">Há datas invertidas. A ordem causal é preservada; conexões correspondentes são tracejadas.</div>}
    <div ref={scroll} className="gm-atlas-scroll" tabIndex={0} aria-label="Mapa Git por eventos; role para explorar" onWheel={demandMore} onPointerDown={demandMore} onKeyDown={demandMore} onScroll={event => {
      const element = event.currentTarget
      setViewport({ x: element.scrollLeft, y: element.scrollTop, width: element.clientWidth, height: element.clientHeight })
    }}>
      <div className="gm-atlas-surface" style={{ width, height }}>
        <svg className="gm-atlas-lines" width={width} height={height} aria-label="Relações reais entre commits">
          <defs>{(['base', 'neutral'] as const).map(tone => <marker key={tone} id={`${mergeArrowId}-${tone}`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={6} markerHeight={6} markerUnits="userSpaceOnUse" orient="auto"><path d="M 1 1 L 7 4 L 1 7" fill="none" stroke={tone === 'base' ? 'var(--accent)' : 'var(--text-secondary)'} strokeWidth={1.6} /></marker>)}</defs>
          {days.filter(day => day.x + day.width >= viewport.x - 120 && day.x <= viewport.x + viewport.width).map(day => <line key={day.x} x1={day.x} x2={day.x} y1={66} y2={height} stroke="var(--border)" strokeDasharray="2 8" opacity=".35" />)}
          {connections.map(({ edge, d, mergeContext }) => <path key={`${edge.child}:${edge.parent}`} data-child={edge.child} data-parent={edge.parent} data-receiving-track={edge.receivingTrack} d={d} fill="none" stroke={edge.secondary && mergeContext === 'BASE' ? 'var(--accent)' : 'var(--text-secondary)'} strokeWidth={edge.secondary && mergeContext === 'BASE' ? 2.5 : 1.8} markerEnd={edge.secondary ? `url(#${mergeArrowId}-${mergeContext === 'BASE' ? 'base' : 'neutral'})` : undefined} opacity={active(edge.child) && active(edge.parent) ? .9 : .18} strokeDasharray={edge.skew ? '5 3' : undefined}><title>{edge.secondary ? `${atlasMergeDescriptions[mergeContext]} · contribuição secundária → M; nome histórico de destino não inferido` : 'Continuidade do primeiro pai'}: {edge.parent} → {edge.child}{edge.skew ? ' · datas invertidas' : ''}</title></path>)}
          {layout.anchors.map(anchor => {
            const point = pointBySha.get(anchor.child)
            return point && visible.some(item => item.node.sha === anchor.child) ? <g key={`${anchor.child}:${anchor.parent}`}><path d={`M ${point.x - 24} ${y(point.lane)} L ${point.x - 9} ${y(point.lane)}`} stroke="var(--text-secondary)" strokeDasharray="3 3" /><text x={point.x - 30} y={y(point.lane) - 13} fill="var(--text-secondary)" fontSize="11">…<title>Pai {anchor.parent} fora do trecho carregado</title></text></g> : null
          })}
        </svg>
        <div className="gm-atlas-date-axis" style={{ width }} aria-label={`Datas por ${unit === 'DAY' ? 'dia' : unit === 'WEEK' ? 'semana' : 'mês'}; ordem dos eventos preservada`}>
          {days.filter(day => day.x + day.width >= viewport.x - 120 && day.x <= viewport.x + viewport.width).map(day => <div key={day.x} className="gm-atlas-date" style={{ left: day.x, width: day.width }} title={`${new Date(day.start).toLocaleString()} — ${new Date(day.end).toLocaleString()}`}><span>{new Date(day.start).toLocaleDateString(undefined, unit === 'MONTH' ? { month: 'short', year: 'numeric' } : { day: '2-digit', month: 'short' })}</span>{day.end !== day.start && unit !== 'MONTH' && <small>até {new Date(day.end).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}</small>}</div>)}
        </div>
        {inlineLabels.map(({ track, left, top, width, continued }) => <button className={`gm-atlas-inline-label ${width < 80 ? 'is-compact' : ''}`} key={track.id} data-track={track.id} style={{ left, top, width }} title={`${track.label}${track.references.length ? ` · referências atuais no trecho: ${track.references.map(ref => ref.name).join(', ')}` : ''}. Rótulo de contexto; não marca criação ou encerramento de branch.`} aria-label={`Trajetória ${track.label}${continued ? ', continuidade anterior' : ''}`} aria-pressed={track.id === focus || track.references.some(ref => ref.ref === focus)} onClick={() => focusTrajectory(track.ref ?? track.shas[0], track.shas[0])}>
          {track.ref === base ? <Crown size={13} /> : <GitBranch size={13} />}<span>{continued ? '… ' : ''}{track.label}</span>{track.references.filter(ref => ref.kind !== 'HEAD').length > 1 && <small>+{track.references.filter(ref => ref.kind !== 'HEAD').length - 1}</small>}
        </button>)}
        {annotations.filter(group => group.x >= viewport.x - 120 && group.x <= viewport.x + viewport.width).map(group => <details key={`${group.created}:${group.x}`} className={`gm-pr-annotation ${group.created ? 'is-created' : 'is-integrated'}`} style={{ left: group.x, top: group.created ? 78 : 106 }}>
          <summary aria-label={`${group.created ? 'PR criado' : 'PR integrado'} #${group.events[0].prNumber}${group.events.length > 1 ? ` e mais ${group.events.length - 1}` : ''}`} title="Anotação temporal aproximada; não representa um commit nem comprova intervalo aberto">{group.created ? '+' : '↗'} #{group.events[0].prNumber}{group.events.length > 1 ? ` +${group.events.length - 1}` : ''}</summary>
          <div>{group.events.map(event => <button key={`${event.kind}:${event.prNumber}`} onClick={() => choosePr?.(event.prNumber)}>#{event.prNumber} · {new Date(event.at).toLocaleString()}{event.kind === 'PR_MERGED' && event.integrationMethod === 'MERGED_METHOD_UNKNOWN' ? ' · método não identificado' : ''}</button>)}</div>
        </details>)}
        {visible.map(point => {
          const track = trackById.get(point.track)!, tags = page?.tags.filter(tag => tag.sha === point.node.sha) ?? []
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
