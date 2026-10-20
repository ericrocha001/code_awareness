import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Crown, GitBranch, Tag } from 'lucide-react'
import type { GitAtlasComparison, GitAtlasPage, GitAtlasWindow } from '../../../../shared/types/git-atlas-types'
import type { GitAtlasCoreEvidence, GitAtlasPrEvidence, GitAtlasEvidenceEvent } from '../../../../shared/types/git-atlas-evidence-types'
import { firstParentPath, layoutGitAtlas } from './atlas-layout'
import { atlasWindowPage, presentGitAtlas } from './atlas-presentation'

export function GitAtlasCanvas({ page, core, enrichment, choosePr, windowDays, base, focus, mode, comparison, selected, select, focusTrajectory, requestMore, loading }: {
  page: GitAtlasPage | null; windowDays: GitAtlasWindow; base: string; focus: string; mode: string; comparison: GitAtlasComparison | null; selected?: string; select: (sha: string) => void; focusTrajectory: (ref: string, sha: string) => void
  core?: GitAtlasCoreEvidence | null; enrichment?: GitAtlasPrEvidence | null; choosePr?: (number: number) => void
  requestMore?: () => void; loading?: boolean
}) {
  const previous = useRef(new Map<string, number>())
  const scroll = useRef<HTMLDivElement>(null)
  const positionedSnapshot = useRef<string | null>(null)
  const previousHeadX = useRef(0)
  const previousWidth = useRef(0)
  const budget = useRef(1)
  const [demand, setDemand] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const windowPage = useMemo(() => atlasWindowPage(page, windowDays), [page, windowDays])
  const layout = useMemo(() => {
    const value = layoutGitAtlas(windowPage, base, previous.current)
    previous.current = new Map(value.tracks.map(track => [track.id, track.lane]))
    return value
  }, [windowPage, base])
  const [viewport, setViewport] = useState({ x: 0, y: 0, width: 1200, height: 900 })
  const { points, width, days, unit } = useMemo(() => presentGitAtlas(layout, windowPage, windowDays, Math.max(0, viewport.width - 240)), [layout, windowPage, windowDays, viewport.width])
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
  const labelTracks = new Map<number, typeof allowedTracks[number]>()
  for (const track of allowedTracks) {
    const prior = labelTracks.get(track.lane)
    const distance = (item: typeof track) => Math.max(0, item.start - viewport.x, viewport.x - item.end)
    if (!prior || distance(track) < distance(prior)) labelTracks.set(track.lane, track)
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
      element.scrollLeft = Math.max(0, (head?.x ?? 0) + 240 - element.clientWidth * .75)
      element.scrollTop = 0
    } else if (selected && previousWidth.current !== element.clientWidth) {
      const anchor = pointBySha.get(selected)
      if (anchor) element.scrollLeft = Math.max(0, anchor.x + 240 - element.clientWidth * .65)
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
  const demandMore = () => { budget.current = 1; setDemand(value => value + 1) }
  return <>
    <div className="gm-atlas-visibility">
      <span>{allowedTracks.length} trajetórias visíveis{hidden ? ` · ${hidden} sem referência atual ou integração visível ocultas` : ''}</span>
      {(hidden > 0 || showAll) && <button aria-pressed={showAll} onClick={() => setShowAll(value => !value)}>{showAll ? 'Mostrar relevantes' : `Mostrar todas (${layout.tracks.length})`}</button>}
      <details><summary>Localizar trajetória ou referência</summary><div className="gm-atlas-track-list">
        {layout.tracks.map(track => <button key={track.id} onClick={() => { setShowAll(true); focusTrajectory(track.ref ?? track.shas[0], track.shas[0]); const point = pointBySha.get(track.shas[0]); if (point && scroll.current) { scroll.current.scrollLeft = Math.max(0, point.x - 180); scroll.current.scrollTop = Math.max(0, y(point.lane) - 180) } }}>{track.label}</button>)}
        {layout.inactive.map(ref => <button key={ref.ref} onClick={() => focusTrajectory(ref.ref, ref.sha)}>{ref.name} · ponta fora do trecho carregado</button>)}
      </div></details>
    </div>
    {core?.checkout.head && !pointBySha.has(core.checkout.head) && <p className="gm-atlas-note">Você está aqui: {core.checkout.head.slice(0, 8)} · HEAD fora do trecho visível.</p>}
    {layout.edges.some(edge => edge.skew) && <div className="gm-atlas-note" role="status">Há datas invertidas. A ordem causal é preservada; conexões correspondentes são tracejadas.</div>}
    <div ref={scroll} className="gm-atlas-scroll" tabIndex={0} aria-label="Mapa Git por eventos; role para explorar" onWheel={demandMore} onPointerDown={demandMore} onKeyDown={demandMore} onScroll={event => {
      const element = event.currentTarget
      setViewport({ x: element.scrollLeft, y: element.scrollTop, width: element.clientWidth, height: element.clientHeight })
    }}>
      <div className="gm-atlas-surface" style={{ width: width + 240, height }}>
        <div className="gm-atlas-labels" style={{ height }}>
          <div className="gm-atlas-corner">Trajetórias · faixas reutilizáveis</div>
          {[...labelTracks.values()].map(track => <div className="gm-atlas-lane-label" data-track={track.id} key={track.id} style={{ top: y(track.lane) - 21 }}>
            <button title={track.label} onClick={() => focusTrajectory(track.ref ?? track.shas[0], track.shas[0])}>{track.ref === base ? <Crown size={18} /> : <GitBranch size={18} />}<span>{track.label}</span></button>
            <small>{track.shas.length} commits no trecho</small>
          </div>)}
        </div>
        <svg className="gm-atlas-lines" width={width} height={height} aria-label="Relações reais entre commits">
          {days.filter(day => day.x + day.width >= viewport.x - 240 && day.x <= viewport.x + viewport.width).map(day => <line key={day.x} x1={day.x} x2={day.x} y1={66} y2={height} stroke="var(--border)" strokeDasharray="2 8" opacity=".35" />)}
          {layout.edges.map(edge => {
            const child = pointBySha.get(edge.child), parent = pointBySha.get(edge.parent)
            if (!child || !parent || !allowed.has(child.track) || !allowed.has(parent.track)) return null
            if (child.x < viewport.x - 240 || parent.x > viewport.x + viewport.width) return null
            const cy = y(child.lane), py = y(parent.lane)
            if (Math.max(cy, py) < viewport.y - 100 || Math.min(cy, py) > viewport.y + viewport.height + 100) return null
            const bend = Math.max(12, (child.x - parent.x) * .5)
            return <path key={`${edge.child}:${edge.parent}`} data-child={edge.child} data-parent={edge.parent} d={`M ${parent.x} ${py} C ${parent.x + bend} ${py}, ${child.x - bend} ${cy}, ${child.x} ${cy}`} fill="none" stroke={edge.secondary ? 'var(--accent)' : 'var(--text-secondary)'} strokeWidth={edge.secondary ? 2.5 : 1.8} opacity={active(edge.child) && active(edge.parent) ? .9 : .18} strokeDasharray={edge.skew ? '5 3' : undefined}><title>{edge.secondary ? 'Merge topológico · pai secundário' : 'Primeiro pai'}: {edge.parent} → {edge.child}{edge.skew ? ' · datas invertidas' : ''}</title></path>
          })}
          {layout.anchors.map(anchor => {
            const point = pointBySha.get(anchor.child)
            return point && visible.some(item => item.node.sha === anchor.child) ? <g key={`${anchor.child}:${anchor.parent}`}><path d={`M ${point.x - 24} ${y(point.lane)} L ${point.x - 9} ${y(point.lane)}`} stroke="var(--text-secondary)" strokeDasharray="3 3" /><text x={point.x - 30} y={y(point.lane) - 13} fill="var(--text-secondary)" fontSize="11">…<title>Pai {anchor.parent} fora do trecho carregado</title></text></g> : null
          })}
        </svg>
        <div className="gm-atlas-date-axis" style={{ width, marginTop: -height }} aria-label={`Datas por ${unit === 'DAY' ? 'dia' : unit === 'WEEK' ? 'semana' : 'mês'}; ordem dos eventos preservada`}>
          {days.filter(day => day.x + day.width >= viewport.x - 240 && day.x <= viewport.x + viewport.width).map(day => <div key={day.x} className="gm-atlas-date" style={{ left: day.x, width: day.width }} title={`${new Date(day.start).toLocaleString()} — ${new Date(day.end).toLocaleString()}`}><span>{new Date(day.start).toLocaleDateString(undefined, unit === 'MONTH' ? { month: 'short', year: 'numeric' } : { day: '2-digit', month: 'short' })}</span>{day.end !== day.start && unit !== 'MONTH' && <small>até {new Date(day.end).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}</small>}</div>)}
        </div>
        {annotations.filter(group => group.x >= viewport.x - 240 && group.x <= viewport.x + viewport.width).map(group => <details key={`${group.created}:${group.x}`} className={`gm-pr-annotation ${group.created ? 'is-created' : 'is-integrated'}`} style={{ left: group.x + 240, top: group.created ? 78 : 106 }}>
          <summary aria-label={`${group.created ? 'PR criado' : 'PR integrado'} #${group.events[0].prNumber}${group.events.length > 1 ? ` e mais ${group.events.length - 1}` : ''}`} title="Anotação temporal aproximada; não representa um commit nem comprova intervalo aberto">{group.created ? '+' : '↗'} #{group.events[0].prNumber}{group.events.length > 1 ? ` +${group.events.length - 1}` : ''}</summary>
          <div>{group.events.map(event => <button key={`${event.kind}:${event.prNumber}`} onClick={() => choosePr?.(event.prNumber)}>#{event.prNumber} · {new Date(event.at).toLocaleString()}{event.kind === 'PR_MERGED' && event.integrationMethod === 'MERGED_METHOD_UNKNOWN' ? ' · método não identificado' : ''}</button>)}</div>
        </details>)}
        {visible.map(point => {
          const track = trackById.get(point.track)!, tags = page?.tags.filter(tag => tag.sha === point.node.sha) ?? []
          const merge = point.node.parents.length > 1
          const head = core?.checkout.head === point.node.sha
          return <button className={`gm-commit gm-atlas-node ${merge ? 'is-merge' : ''} ${head ? 'is-checkout' : ''} ${active(point.node.sha) ? '' : 'is-muted'}`} style={{ left: point.x + 240, top: y(point.lane) } as React.CSSProperties} key={point.node.sha} data-sha={point.node.sha} aria-label={`${head ? 'Você está aqui. ' : ''}${merge ? 'Merge topológico: ' : ''}${point.node.subject} · ${point.node.sha.slice(0, 8)}`} aria-pressed={point.node.sha === selected} onClick={() => select(point.node.sha)}>
            <span className="gm-atlas-dot">{merge ? 'M' : null}</span>
            {head && <span className="gm-checkout-marker">Você está aqui</span>}
            {(point.node.sha === selected || tags.length > 0) && <span className="gm-node-caption">{tags.length > 0 && <Tag size={15} />}<span>{tags.length ? tags.map(tag => tag.name).join(', ') : point.node.subject}</span></span>}
            <span className="gm-node-tooltip">{track.label}<br />{point.node.subject}<br />{point.node.author} · {new Date(point.node.timestamp).toLocaleString()}<br />{point.node.sha.slice(0, 12)}{page?.detachedHeads.filter(item => item.sha === point.node.sha).map((item, index) => <React.Fragment key={`${item.name}:${index}`}><br />HEAD detached observado · {item.name}</React.Fragment>)}</span>
          </button>
        })}
      </div>
    </div>
  </>
}
