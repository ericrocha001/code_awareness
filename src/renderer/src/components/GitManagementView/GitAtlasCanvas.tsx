import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Crown, GitBranch, GitMerge, Tag } from 'lucide-react'
import type { GitAtlasComparison, GitAtlasPage } from '../../../../shared/types/git-atlas-types'
import { firstParentPath, layoutGitAtlas } from './atlas-layout'

const colors = ['var(--color-green)', 'var(--color-warning)', 'var(--status-restored)', 'var(--accent)']
export function GitAtlasCanvas({ page, base, focus, mode, comparison, selected, select, focusTrajectory }: {
  page: GitAtlasPage | null; base: string; focus: string; mode: string; comparison: GitAtlasComparison | null; selected?: string; select: (sha: string) => void; focusTrajectory: (ref: string, sha: string) => void
}) {
  const previous = useRef(new Map<string, number>())
  const scroll = useRef<HTMLDivElement>(null)
  const positionedSnapshot = useRef<string | null>(null)
  const previousHeadX = useRef(0)
  const layout = useMemo(() => {
    const value = layoutGitAtlas(page, base, previous.current)
    previous.current = new Map(value.tracks.map(track => [track.id, track.lane]))
    return value
  }, [page, base])
  const [expanded, setExpanded] = useState(false)
  const [viewport, setViewport] = useState({ x: 0, y: 0, width: 1200, height: 900 })
  const start = Math.min(64, ...layout.points.map(point => point.x))
  const extent = Math.max(1, ...layout.points.map(point => point.x - start))
  const scale = Math.max(.36, (viewport.width - 290) / extent)
  const points = layout.points.map(point => ({ ...point, x: 16 + (point.x - start) * scale }))
  const width = Math.max(extent * scale + 110, viewport.width - 180)
  useLayoutEffect(() => {
    const element = scroll.current
    if (!page || !element) { positionedSnapshot.current = null; previousHeadX.current = 0; return }
    const head = points.find(point => point.node.sha === page.head) ?? points.at(-1)
    if (positionedSnapshot.current !== page.snapshot) {
      element.scrollLeft = Math.max(0, (head?.x ?? 0) + 180 - element.clientWidth * .75)
      element.scrollTop = 0
    } else element.scrollLeft += (head?.x ?? 0) - previousHeadX.current
    positionedSnapshot.current = page.snapshot
    previousHeadX.current = head?.x ?? 0
    setViewport({ x: element.scrollLeft, y: element.scrollTop, width: element.clientWidth, height: element.clientHeight })
  }, [page, layout, viewport.width])
  useLayoutEffect(() => {
    const element = scroll.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewport({ x: element.scrollLeft, y: element.scrollTop, width: element.clientWidth, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const pointBySha = new Map(points.map(point => [point.node.sha, point]))
  const trackById = new Map(layout.tracks.map(track => [track.id, track]))
  const path = firstParentPath(new Map((page?.nodes ?? []).map(node => [node.sha, node])), page?.refs.find(ref => ref.ref === focus)?.sha ?? focus)
  const exclusive = new Set([...(comparison?.exclusive.left ?? []), ...(comparison?.exclusive.right ?? []), ...(comparison?.mergeBases ?? [])])
  const important = new Set(layout.tracks.filter(track => track.ref === base || track.ref === focus || track.shas.includes(selected ?? '')).map(track => track.id))
  const allowedTracks = expanded ? layout.tracks : layout.tracks.filter((track, index) => index < 12 || important.has(track.id))
  const allowed = new Set(allowedTracks.map(track => track.id))
  const lanes = [...new Set(allowedTracks.map(track => track.lane))].sort((a, b) => a - b)
  const rows = new Map(lanes.map((lane, index) => [lane, index]))
  const y = (lane: number) => 158 + (rows.get(lane) ?? 0) * 104
  const shown = points.filter(point => allowed.has(point.track))
  const visible = shown.filter(point => point.x > viewport.x - 100 && point.x < viewport.x + viewport.width + 100 && y(point.lane) > viewport.y - 120 && y(point.lane) < viewport.y + viewport.height + 120)
  const active = (sha: string) => mode === 'Panorama' || (mode === 'Foco' ? path.has(sha) : exclusive.has(sha)) || selected === sha
  const dates: typeof layout.points = []
  let lastDate = -Infinity
  for (const point of shown) if (point.x > lastDate + 100 && new Date(point.node.timestamp).toDateString() !== new Date(dates.at(-1)?.node.timestamp ?? 0).toDateString()) { dates.push(point); lastDate = point.x }
  const height = Math.max(420, lanes.length * 104 + 190)
  const captions = new Set<string>()
  const captionEnds = new Map<number, number>()
  const selectedPoint = shown.find(point => point.node.sha === selected)
  const representative = new Set(allowedTracks.filter(track => track.ref !== base && track.shas.length > 2).map(track => track.shas[Math.floor(track.shas.length / 2)]))
  for (const point of shown) {
    const meaningful = point.node.sha === selected || representative.has(point.node.sha) || point.node.parents.length > 1 || page?.tags.some(tag => tag.sha === point.node.sha)
    if (point.node.sha === selected || meaningful && (!selectedPoint || selectedPoint.lane !== point.lane || Math.abs(selectedPoint.x - point.x) > 165) && point.x - (captionEnds.get(point.lane) ?? -Infinity) > 155) {
      captions.add(point.node.sha); captionEnds.set(point.lane, point.x)
    }
  }
  return <>
    {layout.edges.some(edge => edge.skew) && <div className="gm-atlas-note" role="status">Há datas invertidas entre pais e filhos. Conexões tracejadas preservam o parentesco real.</div>}
    {layout.tracks.length > 12 && <button className="gm-secondary-toggle" onClick={() => setExpanded(value => !value)}>{expanded ? 'Recolher trajetórias secundárias' : `Mostrar trajetórias secundárias (${layout.tracks.length - allowedTracks.length})`}</button>}
    <div ref={scroll} className="gm-atlas-scroll" tabIndex={0} aria-label="Mapa temporal Git; role para explorar" onScroll={event => {
      const element = event.currentTarget
      setViewport({ x: element.scrollLeft, y: element.scrollTop, width: element.clientWidth, height: element.clientHeight })
    }}>
      <div className="gm-atlas-surface" style={{ width: width + 180, height }}>
        <div className="gm-atlas-labels" style={{ height }}>
          {lanes.map(lane => <div className="gm-atlas-lane-label" key={lane} style={{ top: y(lane) - 21 }}>
            {allowedTracks.filter(track => track.lane === lane).slice(0, 2).map(track => <React.Fragment key={track.id}><button title={track.label} onClick={() => focusTrajectory(track.ref ?? track.shas[0], track.shas[0])} style={{ '--trajectory-color': colors[track.color] } as React.CSSProperties}>{track.ref === base ? <Crown size={21} /> : <GitBranch size={21} />}<span>{track.label}</span></button><small>{track.shas.length} commits neste trecho</small></React.Fragment>)}
            {allowedTracks.filter(track => track.lane === lane).length > 2 && <small>+{allowedTracks.filter(track => track.lane === lane).length - 2} trajetórias em outros intervalos</small>}
          </div>)}
        </div>
        <svg className="gm-atlas-lines" width={width} height={height} aria-label="Relações reais entre commits">
          {dates.filter(point => point.x >= viewport.x - 180 && point.x < viewport.x + viewport.width).map(point => <g key={point.node.sha}>
            <line x1={point.x} x2={point.x} y1={66} y2={height - 25} stroke="var(--border)" strokeDasharray="3 5" opacity=".6" />
            <text x={point.x} y={34} textAnchor="middle" fill="var(--text-secondary)" fontSize="12"><tspan x={point.x}>{new Date(point.node.timestamp).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}</tspan><tspan x={point.x} dy="19">{new Date(point.node.timestamp).getFullYear()}</tspan></text>
          </g>)}
          {allowedTracks.map(track => {
            const members = shown.filter(point => point.track === track.id)
            if (!members.length) return null
            return <line key={track.id} x1={Math.min(...members.map(point => point.x))} x2={Math.max(...members.map(point => point.x))} y1={y(track.lane)} y2={y(track.lane)} stroke={colors[track.color]} opacity=".4" strokeDasharray="2 4" />
          })}
          {layout.edges.map(edge => {
            const child = pointBySha.get(edge.child)!, parent = pointBySha.get(edge.parent)!
            if (!allowed.has(child.track) || !allowed.has(parent.track) || Math.max(child.x, parent.x) < viewport.x - 180 || Math.min(child.x, parent.x) > viewport.x + viewport.width) return null
            const cy = y(child.lane), py = y(parent.lane)
            if (Math.max(cy, py) < viewport.y - 100 || Math.min(cy, py) > viewport.y + viewport.height + 100) return null
            const bend = Math.min(50, Math.abs(child.x - parent.x) / 2)
            const direction = child.x >= parent.x ? 1 : -1
            const route = edge.secondary
              ? `M ${parent.x} ${py} L ${child.x - direction * bend * 2} ${py} C ${child.x - direction * bend} ${py}, ${child.x - direction * bend} ${cy}, ${child.x} ${cy}`
              : `M ${parent.x} ${py} C ${parent.x + direction * bend} ${py}, ${parent.x + direction * bend} ${cy}, ${parent.x + direction * bend * 2} ${cy} L ${child.x} ${cy}`
            return <path key={`${edge.child}:${edge.parent}`} data-child={edge.child} data-parent={edge.parent} d={route} fill="none" stroke={colors[trackById.get(edge.secondary ? parent.track : child.track)!.color]} strokeWidth={edge.secondary ? 2.5 : 2} opacity={active(edge.child) && active(edge.parent) ? 1 : .18} strokeDasharray={edge.skew ? '5 3' : undefined}><title>{edge.secondary ? 'Integração topológica; pai secundário' : 'Primeiro pai'}: {edge.parent} → {edge.child}{edge.skew ? ' · datas invertidas; parentesco preservado' : ''}</title></path>
          })}
          {layout.anchors.map(anchor => {
            const point = pointBySha.get(anchor.child)!
            return allowed.has(point.track) && visible.some(item => item.node.sha === point.node.sha) ? <g key={`${anchor.child}:${anchor.parent}`} opacity={.6}><path d={`M ${Math.max(10, point.x - 24)} ${y(point.lane)} L ${point.x - 9} ${y(point.lane)}`} stroke="var(--text-secondary)" strokeDasharray="3 3" /><text x={Math.max(10, point.x - 30)} y={y(point.lane) - 13} fill="var(--text-secondary)" fontSize="11">…<title>Pai {anchor.parent} fora do trecho carregado; continuidade parcial</title></text></g> : null
          })}
        </svg>
        {visible.map(point => {
          const track = trackById.get(point.track)!, tags = page?.tags.filter(tag => tag.sha === point.node.sha) ?? [], detached = page?.detachedHeads.filter(head => head.sha === point.node.sha) ?? []
          return <button className={`gm-commit gm-atlas-node ${point.node.parents.length > 1 ? 'is-merge' : ''} ${active(point.node.sha) ? '' : 'is-muted'}`} style={{ left: point.x + 180, top: y(point.lane), '--trajectory-color': colors[track.color] } as React.CSSProperties} key={point.node.sha} data-sha={point.node.sha} aria-label={`${point.node.parents.length > 1 ? 'Merge: ' : ''}${point.node.subject} · ${point.node.sha.slice(0, 8)}`} aria-pressed={point.node.sha === selected} onClick={() => select(point.node.sha)}>
            <span className="gm-atlas-dot" />
            {(captions.has(point.node.sha) || detached.length > 0) && <span className={`gm-node-caption ${tags.length ? 'is-tag' : ''}`}>{tags.length ? <Tag size={18} /> : point.node.parents.length > 1 ? <GitMerge size={18} /> : null}<span>{tags.length ? tags.map(tag => tag.name).join(', ') : point.node.subject}{detached.length > 0 && <small>HEAD detached / worktree atual</small>}</span></span>}
            <span className="gm-node-tooltip">{track.label}<br />{point.node.subject}<br />{point.node.author} · {new Date(point.node.timestamp).toLocaleString()}<br />{point.node.sha.slice(0, 12)}</span>
          </button>
        })}
      </div>
    </div>
    {!!layout.inactive.length && <details className="gm-inactive"><summary>Pontas fora do trecho carregado ({layout.inactive.length})</summary>{layout.inactive.map(ref => <p key={ref.ref}>{ref.name} · {ref.sha.slice(0, 8)}</p>)}</details>}
  </>
}
