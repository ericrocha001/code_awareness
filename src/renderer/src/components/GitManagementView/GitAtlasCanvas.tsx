import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { GitAtlasComparison, GitAtlasPage } from '../../../../shared/types/git-atlas-types'
import { firstParentPath, layoutGitAtlas } from './atlas-layout'

const colors = ['var(--accent)', 'var(--color-green)', 'var(--status-restored)', 'var(--color-warning)', 'var(--color-danger)', 'var(--text-secondary)']
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
  useLayoutEffect(() => {
    const element = scroll.current
    if (!page || !element) { positionedSnapshot.current = null; previousHeadX.current = 0; return }
    const head = layout.points.find(point => point.node.sha === page.head) ?? layout.points.at(-1)
    if (positionedSnapshot.current !== page.snapshot) {
      element.scrollLeft = Math.max(0, (head?.x ?? 0) + 180 - element.clientWidth * .75)
      element.scrollTop = 0
    } else element.scrollLeft += (head?.x ?? 0) - previousHeadX.current
    positionedSnapshot.current = page.snapshot
    previousHeadX.current = head?.x ?? 0
    setViewport({ x: element.scrollLeft, y: element.scrollTop, width: element.clientWidth, height: element.clientHeight })
  }, [page, layout])
  useLayoutEffect(() => {
    const element = scroll.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewport({ x: element.scrollLeft, y: element.scrollTop, width: element.clientWidth, height: element.clientHeight }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const pointBySha = new Map(layout.points.map(point => [point.node.sha, point]))
  const trackById = new Map(layout.tracks.map(track => [track.id, track]))
  const path = firstParentPath(new Map((page?.nodes ?? []).map(node => [node.sha, node])), page?.refs.find(ref => ref.ref === focus)?.sha ?? focus)
  const exclusive = new Set([...(comparison?.exclusive.left ?? []), ...(comparison?.exclusive.right ?? []), ...(comparison?.mergeBases ?? [])])
  const important = new Set(layout.tracks.filter(track => track.ref === base || track.ref === focus || track.shas.includes(selected ?? '')).map(track => track.id))
  const allowedTracks = expanded ? layout.tracks : layout.tracks.filter((track, index) => index < 12 || important.has(track.id))
  const allowed = new Set(allowedTracks.map(track => track.id))
  const lanes = [...new Set(allowedTracks.map(track => track.lane))].sort((a, b) => a - b)
  const rows = new Map(lanes.map((lane, index) => [lane, index]))
  const y = (lane: number) => 100 + (rows.get(lane) ?? 0) * 100
  const shown = layout.points.filter(point => allowed.has(point.track))
  const visible = shown.filter(point => point.x > viewport.x - 100 && point.x < viewport.x + viewport.width + 100 && y(point.lane) > viewport.y - 120 && y(point.lane) < viewport.y + viewport.height + 120)
  const active = (sha: string) => mode === 'Panorama' || (mode === 'Foco' ? path.has(sha) : exclusive.has(sha)) || selected === sha
  const dates: typeof layout.points = []
  let lastDate = -Infinity
  for (const point of shown) if (point.x > lastDate + 130) { dates.push(point); lastDate = point.x }
  const height = Math.max(350, lanes.length * 100 + 140)
  return <>
    <div className="gm-atlas-note">Cor identifica a trajetória exibida · datas reais; espaçamento ampliado para leitura · ◇ merge</div>
    {layout.edges.some(edge => edge.skew) && <div className="gm-atlas-note" role="status">Há datas invertidas entre pais e filhos. Conexões tracejadas preservam o parentesco real.</div>}
    {layout.tracks.length > 12 && <button className="gm-secondary-toggle" onClick={() => setExpanded(value => !value)}>{expanded ? 'Recolher trajetórias secundárias' : `Mostrar trajetórias secundárias (${layout.tracks.length - allowedTracks.length})`}</button>}
    <div ref={scroll} className="gm-atlas-scroll" tabIndex={0} aria-label="Mapa temporal Git; role para explorar" onScroll={event => {
      const element = event.currentTarget
      setViewport({ x: element.scrollLeft, y: element.scrollTop, width: element.clientWidth, height: element.clientHeight })
    }}>
      <div className="gm-atlas-surface" style={{ width: layout.width + 180, height }}>
        <div className="gm-atlas-labels" style={{ height }}>
          {lanes.map(lane => <div className="gm-atlas-lane-label" key={lane} style={{ top: y(lane) - 28 }}>
            {allowedTracks.filter(track => track.lane === lane).slice(0, 2).map(track => <button key={track.id} title={track.label} onClick={() => focusTrajectory(track.ref ?? track.shas[0], track.shas[0])} style={{ borderColor: colors[track.color], color: colors[track.color] }}>{track.label}{track.ref && page?.refs.find(ref => ref.ref === track.ref)?.name === page?.branch ? ' · HEAD' : ''}</button>)}
            {allowedTracks.filter(track => track.lane === lane).length > 2 && <small>+{allowedTracks.filter(track => track.lane === lane).length - 2} trajetórias em outros intervalos</small>}
          </div>)}
        </div>
        <svg className="gm-atlas-lines" width={layout.width} height={height} aria-label="Relações reais entre commits">
          {dates.filter(point => point.x >= viewport.x - 180 && point.x < viewport.x + viewport.width).map(point => <g key={point.node.sha}>
            <line x1={point.x} x2={point.x} y1={60} y2={height - 25} stroke="var(--border)" strokeDasharray="3 6" />
            <text x={point.x} y={35} textAnchor="middle" fill="var(--text-secondary)" fontSize="11">{new Date(point.node.timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' })}</text>
          </g>)}
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
            return allowed.has(point.track) && visible.includes(point) ? <g key={`${anchor.child}:${anchor.parent}`} opacity={.6}><path d={`M ${Math.max(10, point.x - 24)} ${y(point.lane)} L ${point.x - 9} ${y(point.lane)}`} stroke="var(--text-secondary)" strokeDasharray="3 3" /><text x={Math.max(10, point.x - 30)} y={y(point.lane) - 13} fill="var(--text-secondary)" fontSize="11">…<title>Pai {anchor.parent} fora do trecho carregado; continuidade parcial</title></text></g> : null
          })}
        </svg>
        {visible.map(point => {
          const track = trackById.get(point.track)!, tags = page?.tags.filter(tag => tag.sha === point.node.sha) ?? [], detached = page?.detachedHeads.filter(head => head.sha === point.node.sha) ?? []
          return <button className={`gm-commit gm-atlas-node ${point.node.parents.length > 1 ? 'is-merge' : ''} ${active(point.node.sha) ? '' : 'is-muted'}`} style={{ left: point.x + 180, top: y(point.lane), '--trajectory-color': colors[track.color] } as React.CSSProperties} key={point.node.sha} data-sha={point.node.sha} aria-label={`${point.node.parents.length > 1 ? 'Merge: ' : ''}${point.node.subject} · ${point.node.sha.slice(0, 8)}`} aria-pressed={point.node.sha === selected} onClick={() => select(point.node.sha)}>
            <span className="gm-atlas-dot" />
            <span className="gm-node-caption">{point.node.decorations.length ? point.node.decorations.map(ref => ref.name).join(' · ') : point.node.sha === selected ? point.node.subject : ''}{tags.length ? ` · ◈ ${tags.map(tag => tag.name).join(', ')}` : ''}{detached.length ? ' · HEAD detached / worktree atual' : ''}</span>
            <span className="gm-node-tooltip">{track.label}<br />{point.node.subject}<br />{point.node.author} · {new Date(point.node.timestamp).toLocaleString()}<br />{point.node.sha.slice(0, 12)}</span>
          </button>
        })}
      </div>
    </div>
    {!!layout.inactive.length && <details className="gm-inactive"><summary>Pontas fora do trecho carregado ({layout.inactive.length})</summary>{layout.inactive.map(ref => <p key={ref.ref}>{ref.name} · {ref.sha.slice(0, 8)}</p>)}</details>}
  </>
}
