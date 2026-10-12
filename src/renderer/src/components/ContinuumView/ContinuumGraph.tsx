import React, { useEffect, useRef, useState } from 'react'
import cytoscape from 'cytoscape'
import type { ContinuumGraph as Graph, ContinuumGraphEdge } from '../../../../shared/types/continuum-graph-types'
import type { ContinuumPeriod, ContinuumScalar } from '../../../../shared/types/continuum-ui-types'
import type { ContinuumSuggestion } from '../../../../shared/types/continuum-suggestion-types'
import './ContinuumGraph.css'

interface Props {
  repositoryId: string
  query: string
  metadata: Record<string, ContinuumScalar>
  periods: Record<string, ContinuumPeriod>
  refresh: number
  selectedId: string | null
  onSelect(id: string): void
}
interface SuggestedEdge extends ContinuumSuggestion { sourceId: string }
type Edge = ContinuumGraphEdge | SuggestedEdge
const nodeId = (id: string) => 'artifact:' + id
const edgeId = (edge: Edge) => JSON.stringify('sourceId' in edge && 'targetId' in edge
  ? [edge.sourceId, edge.targetId, edge.nature, edge.kind] : [edge.sourceId, edge.targetArtifactId, 'SUGGESTED', edge.proposedKind])
const nature = (edge: Edge) => 'nature' in edge ? edge.nature : edge.origin
function describe(edge: Edge): string {
  if ('reasons' in edge) return edge.reasons.map(reason => {
    if (reason.signal === 'shared-terms') return 'Termos: ' + reason.terms.join(', ')
    if (reason.signal === 'shared-neighbor') return 'Vizinhos compartilhados: ' + reason.artifactIds.join(', ')
    if (reason.signal === 'shared-execution') return 'Execução: ' + reason.executionId
    if (reason.signal === 'shared-metadata') return `${reason.key}: ${reason.value}`
    return 'Tipo: ' + reason.kind
  }).join(' · ')
  return `${edge.kind} · ${edge.origin} · revisão ${edge.sourceRevision}`
}

function mergeGraph(current: Graph, next: Graph): Graph {
  if (current.repositoryId !== next.repositoryId || current.revision !== next.revision) throw new Error('O grafo mudou. Atualize a consulta.')
  const allNodes = [...new Map([...current.nodes, ...next.nodes].map(node => [node.artifactId, node])).values()]
  const nodes = allNodes.slice(0, 100)
  const ids = new Set(nodes.map(node => node.artifactId))
  const allEdges = [...new Map([...current.edges, ...next.edges].map(edge => [edgeId(edge), edge])).values()]
    .filter(edge => ids.has(edge.sourceId) && ids.has(edge.targetId))
  const groups = new Map(current.executionGroups.map(group => [group.executionId, group]))
  for (const group of next.executionGroups) groups.set(group.executionId, { ...group,
    memberIds: [...new Set([...(groups.get(group.executionId)?.memberIds ?? []), ...group.memberIds])].filter(id => ids.has(id)) })
  return { ...current, nodes, edges: allEdges.slice(0, 500), executionGroups: [...groups.values()],
    freshness: current.freshness === 'BACKFILL_PENDING' || next.freshness === 'BACKFILL_PENDING' ? 'BACKFILL_PENDING' : 'CURRENT',
    truncated: { nodes: current.truncated.nodes || next.truncated.nodes || allNodes.length > 100,
      edges: current.truncated.edges || next.truncated.edges || allEdges.length > 500 } }
}

function styles(container: HTMLElement): cytoscape.StylesheetJson {
  const css = getComputedStyle(container)
  const accent = css.getPropertyValue('--accent').trim() || '#7852ee'
  const text = css.getPropertyValue('--text-primary').trim() || '#dedee8'
  const secondary = css.getPropertyValue('--text-secondary').trim() || '#9295a9'
  const surface = css.getPropertyValue('--bg-secondary').trim() || '#181a23'
  return [
    { selector: 'node[artifactId]', style: { 'background-color': accent, 'background-opacity': .55, 'border-width': 1, 'border-color': accent,
      width: 'data(size)', height: 'data(size)', label: 'data(label)', color: text, 'font-size': 10,
      'text-valign': 'bottom', 'text-margin-y': 7, 'text-background-color': surface, 'text-background-opacity': .85, 'text-background-padding': '3px',
      'text-opacity': 0, 'overlay-opacity': 0 } },
    { selector: 'node.show-label, node.focused, node.neighbor, node.hovered', style: { 'text-opacity': 1 } },
    { selector: 'node.focused', style: { 'background-opacity': 1, 'border-width': 3 } },
    { selector: 'node.neighbor', style: { 'background-opacity': .8 } },
    { selector: ':parent', style: { label: 'data(label)', 'font-size': 10, color: secondary, 'background-color': accent,
      'background-opacity': .04, 'border-width': 1, 'border-style': 'dashed', 'border-color': accent, padding: '20px', 'text-valign': 'top' } },
    { selector: 'edge', style: { width: 1.5, 'line-color': secondary, 'target-arrow-color': secondary, 'target-arrow-shape': 'triangle',
      'curve-style': 'bezier', opacity: .6, 'arrow-scale': .7, 'overlay-opacity': 0 } },
    { selector: 'edge[nature="DECLARED"]', style: { 'line-style': 'solid' } },
    { selector: 'edge[nature="DERIVED"]', style: { 'line-style': 'dotted' } },
    { selector: 'edge[nature="SUGGESTED"]', style: { 'line-style': 'dashed', opacity: .35, 'line-color': accent, 'target-arrow-color': accent } },
    { selector: 'edge:selected', style: { width: 3, opacity: 1, 'line-color': accent, 'target-arrow-color': accent } }
  ]
}

export function ContinuumGraph(props: Props) {
  const { repositoryId, query, metadata, periods, refresh, selectedId } = props
  const [graph, setGraph] = useState<Graph | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [suggestionsOn, setSuggestionsOn] = useState(false)
  const [suggestions, setSuggestions] = useState<SuggestedEdge[]>([])
  const [grouped, setGrouped] = useState(true)
  const [inspected, setInspected] = useState<Edge | null>(null)
  const [hover, setHover] = useState('')
  const [extras, setExtras] = useState(false)
  const canvas = useRef<HTMLDivElement>(null)
  const cy = useRef<cytoscape.Core | null>(null)
  const generation = useRef(0)
  const selection = useRef(selectedId)
  selection.current = selectedId
  const onSelect = useRef(props.onSelect)
  onSelect.current = props.onSelect
  const edges = useRef<Map<string, Edge>>(new Map())
  const seeds = useRef(new Set<string>())

  useEffect(() => {
    const request = ++generation.current
    setLoading(true); setBusy(false); setGraph(null); setSuggestions([]); setInspected(null); setError(''); setExtras(false)
    window.codeAwareness.getContinuumGraph({ repositoryId, query, metadata, periods, nodeLimit: 50, edgeLimit: 200 }).then(result => {
      if (request !== generation.current || result.repositoryId !== repositoryId) return
      seeds.current = new Set(result.nodes.map(node => node.artifactId))
      setGraph(result)
    }).catch(reason => { if (request === generation.current) setError(String(reason)) })
      .finally(() => { if (request === generation.current) setLoading(false) })
    return () => { generation.current++ }
  }, [repositoryId, query, metadata, periods, refresh, retry])

  useEffect(() => {
    const container = canvas.current!
    const instance = cytoscape({ container, elements: [], style: styles(container), layout: { name: 'preset' }, minZoom: .15, maxZoom: 3,
      boxSelectionEnabled: false })
    cy.current = instance
    instance.on('tap', 'node[artifactId]', event => onSelect.current(event.target.data('artifactId')))
    instance.on('tap', 'edge', event => setInspected(edges.current.get(event.target.id()) ?? null))
    instance.on('mouseover', 'node[artifactId]', event => { event.target.addClass('hovered'); setHover(event.target.data('name') + ' · ' + event.target.data('kind')) })
    instance.on('mouseout', 'node[artifactId]', event => { event.target.removeClass('hovered'); setHover('') })
    instance.on('zoom', () => instance.nodes().toggleClass('show-label', instance.nodes('[artifactId]').length <= 20 || instance.zoom() >= 1.3))
    const resize = () => { instance.resize(); if (instance.elements().length) instance.fit(undefined, 35) }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : undefined
    observer?.observe(container)
    const theme = new MutationObserver(() => instance.style(styles(container)))
    theme.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    window.addEventListener('resize', resize)
    return () => { observer?.disconnect(); theme.disconnect(); window.removeEventListener('resize', resize); instance.destroy(); cy.current = null }
  }, [])

  useEffect(() => {
    const instance = cy.current
    if (!instance) return
    const elements: cytoscape.ElementDefinition[] = []
    const parents = new Map<string, string>()
    if (grouped) for (const group of graph?.executionGroups ?? []) {
      if (!group.memberIds.length) continue
      const id = 'execution:' + group.executionId
      elements.push({ data: { id, label: group.executionId.slice(0, 30) } })
      for (const member of group.memberIds) parents.set(member, id)
    }
    for (const node of graph?.nodes ?? []) elements.push({ data: { id: nodeId(node.artifactId), artifactId: node.artifactId,
      name: node.name, kind: node.kind, label: node.name.length > 27 ? node.name.slice(0, 26) + '…' : node.name,
      size: 28 + Math.min(node.relationCount, 15), ...(parents.has(node.artifactId) ? { parent: parents.get(node.artifactId) } : {}) } })
    const visible = new Set(graph?.nodes.map(node => node.artifactId))
    edges.current = new Map([...graph?.edges ?? [], ...suggestions].filter(edge => visible.has(edge.sourceId) && visible.has('targetId' in edge ? edge.targetId : edge.targetArtifactId)).map(edge => [edgeId(edge), edge]))
    for (const [id, edge] of edges.current) elements.push({ data: { id, source: nodeId(edge.sourceId),
      target: nodeId('targetId' in edge ? edge.targetId : edge.targetArtifactId), nature: nature(edge) } })
    const existing = new Map(instance.nodes('[artifactId]').map(node => [node.id(), node.position()] as const))
    const initial = existing.size === 0
    instance.batch(() => {
      instance.elements().remove()
      instance.add(elements)
      for (const [id, position] of existing) { const node = instance.getElementById(id); if (node.length) { node.position(position); node.lock() } }
      instance.nodes().toggleClass('show-label', (graph?.nodes.length ?? 0) <= 20 || instance.zoom() >= 1.3)
    })
    if (elements.length) instance.layout({ name: 'cose', animate: false, randomize: initial, fit: initial, padding: 35, numIter: 250, nodeRepulsion: 8000, idealEdgeLength: 100 }).run()
    instance.nodes().unlock()
  }, [graph, suggestions, grouped])

  useEffect(() => {
    const instance = cy.current
    if (!instance) return
    instance.elements().removeClass('focused neighbor')
    if (selectedId) { const node = instance.getElementById(nodeId(selectedId)); node.addClass('focused'); node.neighborhood('node').addClass('neighbor') }
  }, [selectedId, graph, suggestions, grouped])

  useEffect(() => {
    let cancelled = false
    setSuggestions([]); setInspected(null)
    if (!suggestionsOn || !graph || !selectedId || !graph.nodes.some(node => node.artifactId === selectedId)) return
    const request = generation.current
    window.codeAwareness.getContinuumSuggestions({ repositoryId, artifactId: selectedId, limit: 5, expectedGraphRevision: graph.revision }).then(async result => {
      if (cancelled || request !== generation.current || selection.current !== selectedId || result.repositoryId !== repositoryId || result.graphRevision !== graph.revision) return
      const ids = result.suggestions.map(candidate => candidate.targetArtifactId)
      const missing = ids.filter(id => !graph.nodes.some(node => node.artifactId === id)).slice(0, 100 - graph.nodes.length)
      let visible = graph
      if (missing.length) {
        const targets = await window.codeAwareness.getContinuumGraph({ repositoryId, artifactIds: missing, nodeLimit: missing.length, expectedRevision: graph.revision })
        if (cancelled || request !== generation.current || selection.current !== selectedId) return
        visible = mergeGraph(graph, targets)
      }
      setSuggestions(result.suggestions.filter(candidate => visible.nodes.some(node => node.artifactId === candidate.targetArtifactId)).map(candidate => ({ ...candidate, sourceId: selectedId })))
      if (missing.length) { setGraph(current => current ? mergeGraph(current, visible) : current); setExtras(true) }
    }).catch(reason => { if (!cancelled && request === generation.current) setError(String(reason)) })
    return () => { cancelled = true }
  }, [suggestionsOn, selectedId, graph?.revision, repositoryId, refresh, retry])

  const expand = async (executionId?: string) => {
    if (!graph || busy || (!executionId && !selectedId)) return
    const request = generation.current, selected = selectedId
    setBusy(true); setError('')
    try {
      const result = await window.codeAwareness.getContinuumGraph({ repositoryId, ...(executionId ? { metadata: { executionId } } : { artifactIds: [selectedId!], expand: true }), nodeLimit: 100, edgeLimit: 500, expectedRevision: graph.revision })
      if (request !== generation.current || (!executionId && selection.current !== selected)) return
      setGraph(current => current ? mergeGraph(current, result) : current); setExtras(true)
    } catch (reason) { if (request === generation.current) setError(String(reason)) }
    finally { if (request === generation.current) setBusy(false) }
  }
  const zoom = (factor: number) => { const instance = cy.current; if (instance) instance.zoom({ level: Math.max(.15, Math.min(3, instance.zoom() * factor)), renderedPosition: { x: instance.width() / 2, y: instance.height() / 2 } }) }
  const fit = () => cy.current?.fit(undefined, 35)
  const choose = (id: string) => { if (id) { props.onSelect(id); cy.current?.getElementById(nodeId(id)).emit('select') } }
  const inspectedSource = inspected ? graph?.nodes.find(node => node.artifactId === inspected.sourceId)?.name : ''
  const inspectedTarget = inspected ? graph?.nodes.find(node => node.artifactId === ('targetId' in inspected ? inspected.targetId : inspected.targetArtifactId))?.name : ''
  return <div className="continuum-graph" aria-busy={loading || busy}>
    <div className="continuum-graph-controls">
      <button onClick={() => zoom(1.25)} aria-label="Ampliar grafo">+</button><button onClick={() => zoom(.8)} aria-label="Reduzir grafo">−</button>
      <button onClick={fit}>Ajustar grafo</button><button disabled={!selectedId || busy || !graph?.nodes.some(node => node.artifactId === selectedId)} onClick={() => expand()}>Expandir vizinhança</button>
      <label><input type="checkbox" checked={grouped} onChange={event => setGrouped(event.target.checked)} />Execuções</label>
      <label><input type="checkbox" checked={suggestionsOn} onChange={event => setSuggestionsOn(event.target.checked)} />Sugestões</label>
    </div>
    <div className="continuum-graph-navigation">
      <select aria-label="Selecionar artifact no grafo" value={graph?.nodes.some(node => node.artifactId === selectedId) ? selectedId! : ''} onChange={event => choose(event.target.value)}>
        <option value="">Selecionar artifact…</option>{graph?.nodes.map(node => <option key={node.artifactId} value={node.artifactId}>{node.name}{seeds.current.has(node.artifactId) ? '' : ' · vizinho adicional'}</option>)}
      </select>
      <select aria-label="Inspecionar relação" value={inspected ? edgeId(inspected) : ''} onChange={event => setInspected(edges.current.get(event.target.value) ?? null)}>
        <option value="">Inspecionar relação…</option>{[...graph?.edges ?? [], ...suggestions].filter(edge => graph?.nodes.some(node => node.artifactId === ('targetId' in edge ? edge.targetId : edge.targetArtifactId))).map(edge => <option key={edgeId(edge)} value={edgeId(edge)}>{nature(edge)} · {'targetId' in edge ? edge.kind : edge.proposedKind} · {edge.sourceId} → {'targetId' in edge ? edge.targetId : edge.targetArtifactId}</option>)}
      </select>
    </div>
    <div className="continuum-graph-stage">
      <div className="continuum-graph-canvas" ref={canvas} tabIndex={0} role="img" aria-label="Grafo do Continuum" aria-describedby="continuum-graph-legend" onMouseDown={event => event.currentTarget.focus()} onKeyDown={event => {
        if (event.key === '+' || event.key === '=') zoom(1.25)
        else if (event.key === '-') zoom(.8)
        else if (event.key === 'Home') fit()
        else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) cy.current?.panBy({ x: event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0, y: event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0 })
        else return
        event.preventDefault()
      }} />
      {loading ? <div className="continuum-graph-state" role="status">Carregando grafo…</div> : !graph?.nodes.length && !error ? <div className="continuum-graph-state"><h3>Nenhum artifact encontrado</h3><p>Ajuste a busca ou os filtros.</p></div> : null}
      {error && <div className="continuum-graph-state" role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>Atualizar grafo</button></div>}
      {hover && <div className="continuum-graph-tooltip" role="status">{hover}</div>}
    </div>
    <div className="continuum-graph-footer">
      <div id="continuum-graph-legend" className="continuum-graph-legend"><span className="declared">DECLARED</span><span className="derived">DERIVED</span><span className="suggested">SUGGESTED · candidata</span></div>
      <small>{graph?.nodes.length ?? 0} nós · {graph?.edges.length ?? 0} relações · limite 100 nós / 500 relações{graph && (graph.truncated.nodes || graph.truncated.edges) ? ' · recorte incompleto' : ''}{graph?.freshness === 'BACKFILL_PENDING' ? ' · índice parcial' : ''}</small>
      {extras && <small>Vizinhos adicionais podem estar fora da busca e dos filtros iniciais.</small>}
      {suggestionsOn && <small>Sugestões são candidatas de evidência relativa, sem aprovação automática.{!selectedId ? ' Selecione um artifact.' : ''}</small>}
      {inspected && <div className="continuum-graph-relation" aria-label="Detalhes da relação"><strong>{nature(inspected)} · {inspectedSource} → {inspectedTarget}</strong><span>{describe(inspected)}</span></div>}
      <details><summary>Execuções · {graph?.executionGroups.length ?? 0}</summary>{graph?.executionGroups.map(group => <button key={group.executionId} disabled={busy} onClick={() => expand(group.executionId)} title={group.executionId}>{group.executionId} · {group.memberIds.length}/{group.totalMembers}</button>)}</details>
      <small>Setas: mover · +/−: zoom · Home: ajustar</small>
    </div>
  </div>
}
