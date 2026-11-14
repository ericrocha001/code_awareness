import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, CheckCircle2, Circle, RefreshCw, X } from 'lucide-react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type { WorkBoardArtifact, WorkBoardCard, WorkBoardColumn, WorkBoardInspection, WorkBoardPage, WorkBoardSelection } from '../../../../shared/types/work-board-types'
import type { ArtifactNavigation } from './BranchExecutions'

const columns = {
  WORK: [{ perspective: 'WORK', column: 'PENDING' }, { perspective: 'WORK', column: 'COMPLETED' }],
  IDEAS: [{ perspective: 'IDEAS', column: 'NOT_IMPLEMENTED' }, { perspective: 'IDEAS', column: 'IMPLEMENTED' }]
} as const satisfies Record<WorkBoardSelection['perspective'], readonly WorkBoardSelection[]>
const columnLabels = { PENDING: 'Pendentes', COMPLETED: 'Concluídos', NOT_IMPLEMENTED: 'Não implementadas', IMPLEMENTED: 'Implementadas' }
const statusLabels: Record<string, string> = { PENDING: 'Pendente', COMPLETED: 'Concluído', NOT_IMPLEMENTED: 'Não implementada',
  IMPLEMENTED: 'Implementada', CANCELLED: 'Cancelado', VALIDATED: 'Validado', BLOCKED: 'Bloqueado' }
const status = (artifact: WorkBoardArtifact) => artifact.status ? statusLabels[artifact.status] ?? artifact.status : undefined
interface Lane { page?: WorkBoardPage; loading: boolean; error?: string }
const emptyLane: Lane = { loading: false }
const date = (value: string) => new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
const kind = (artifact: WorkBoardArtifact) => artifact.kind === 'FEATURE_IDEA' ? 'Ideia' : artifact.kind === 'EXECUTABLE_PLAN' ? 'Plano executável' : artifact.kind === 'WORK_ITEM' ? 'Work Item' : artifact.kind === 'IMPLEMENTATION_HANDOFF' ? 'Handoff' : artifact.kind

interface WorkBoardProps {
  state: ActiveProjectState; active: boolean; onArtifact?: (intent: ArtifactNavigation) => void
}

export function WorkBoard(props: WorkBoardProps) {
  const [perspective, setPerspective] = useState<WorkBoardSelection['perspective']>('WORK')
  const [ideasVisited, setIdeasVisited] = useState(false)
  return <section className="wb-board" aria-label="Work Board">
    <nav className="wb-perspectives" aria-label="Perspectivas do Work Board">
      <button type="button" aria-pressed={perspective === 'WORK'} onClick={() => setPerspective('WORK')}>Trabalhos</button>
      <button type="button" aria-pressed={perspective === 'IDEAS'} onClick={() => { setIdeasVisited(true); setPerspective('IDEAS') }}>Ideias</button>
    </nav>
    <BoardPerspective {...props} perspective="WORK" active={props.active && perspective === 'WORK'} hidden={perspective !== 'WORK'}/>
    {ideasVisited && <BoardPerspective {...props} perspective="IDEAS" active={props.active && perspective === 'IDEAS'} hidden={perspective !== 'IDEAS'}/>}
  </section>
}

function BoardPerspective({ state, active, hidden, perspective, onArtifact }: WorkBoardProps & {
  perspective: WorkBoardSelection['perspective']; hidden: boolean
}) {
  const { revision, project } = state
  const repositoryId = state.context?.repositoryId
  const projectId = project?.id
  const context = useMemo(() => repositoryId && projectId ? { repositoryId, projectId, revision } : undefined, [repositoryId, projectId, revision])
  const ready = state.context?.capabilities.continuum.state
  const [lanes, setLanes] = useState<Partial<Record<WorkBoardColumn, Lane>>>({})
  const [selectedId, select] = useState<string>()
  const [inspections, setInspections] = useState<Record<string, WorkBoardInspection>>({})
  const [inspecting, setInspecting] = useState(false)
  const [inspectionError, setInspectionError] = useState(false)
  const queryGeneration = useRef(0)
  const inspectionGeneration = useRef(0)
  const lastContext = useRef(context)
  const activeRef = useRef(active)
  const loaded = useRef<{ ready: typeof ready }>()
  const dirty = useRef(false)
  const inspector = useRef<HTMLElement>(null)
  const refreshButton = useRef<HTMLButtonElement>(null)
  const cardButtons = useRef(new Map<string, HTMLButtonElement>())
  lastContext.current = context
  activeRef.current = active

  const query = useCallback(async (input: WorkBoardSelection & { cursor?: string; inspect?: { artifactId: string; revision: number } }) => {
    if (!context) throw new Error('CONTINUUM_UNAVAILABLE')
    const result = await window.codeAwareness.getWorkBoard({ context, ...input })
    if (!result.success) throw new Error(result.code)
    if (result.context.repositoryId !== context.repositoryId || result.context.projectId !== context.projectId ||
      result.context.revision !== context.revision || result.page.perspective !== input.perspective || result.page.column !== input.column)
      throw new Error('PROJECT_CONTEXT_CHANGED')
    return result.page
  }, [context])
  const load = useCallback(async (selection: WorkBoardSelection, generation: number, cursor?: string) => {
    const { column } = selection
    const current = () => generation === queryGeneration.current && lastContext.current === context && activeRef.current
    setLanes(previous => ({ ...previous, [column]: { ...previous[column], loading: true, error: undefined } }))
    try {
      const page = await query({ ...selection, cursor })
      if (!current()) return
      setLanes(previous => ({ ...previous, [column]: { loading: false, page: cursor
        ? { ...page, cards: [...(previous[column]?.page?.cards ?? []), ...page.cards] }
        : page } }))
    } catch (error) {
      if (!current()) return
      setLanes(previous => ({ ...previous, [column]: { ...previous[column], loading: false,
        error: error instanceof Error && error.message === 'BOARD_CHANGED' ? 'O Continuum mudou. Atualize o quadro para continuar.' : 'Consulta ao Continuum indisponível.' } }))
    }
  }, [context, query])
  const refresh = useCallback(() => {
    if (!context) return
    loaded.current = { ready }
    dirty.current = false
    inspectionGeneration.current++
    setInspecting(false)
    setInspectionError(false)
    setInspections({})
    const generation = ++queryGeneration.current
    for (const selection of columns[perspective]) void load(selection, generation)
  }, [context, load, perspective, ready])
  useEffect(() => {
    if (active && context && (!loaded.current || dirty.current || (ready === 'READY' && loaded.current.ready !== 'READY'))) refresh()
    return () => { queryGeneration.current++; inspectionGeneration.current++ }
  }, [active, context, ready, refresh])
  useEffect(() => {
    if (!context) return
    return window.codeAwareness.onContinuumChanged(change => {
      if (change.repositoryId !== context.repositoryId) return
      if (activeRef.current) refresh()
      else dirty.current = true
    })
  }, [context, refresh])
  useEffect(() => {
    if (!active) {
      setInspecting(false)
      if (Object.values(lanes).some(lane => lane.loading)) dirty.current = true
    }
  }, [active, lanes])
  const inspectionFor = (card: WorkBoardCard) => {
    const value = inspections[card.artifact.artifactId]
    return value?.revision === card.artifact.revision ? value : undefined
  }
  const selected = Object.values(lanes).flatMap(lane => lane.page?.cards ?? []).find(card => card.artifact.artifactId === selectedId)
  const inspection = selected && inspectionFor(selected)
  const close = () => {
    const button = selectedId && cardButtons.current.get(selectedId)
    select(undefined)
    inspectionGeneration.current++
    setInspecting(false)
    if (button) button.focus()
    else refreshButton.current?.focus()
  }
  useEffect(() => {
    if (active && selectedId) inspector.current?.focus({ preventScroll: true })
  }, [active, selectedId])
  useEffect(() => {
    if (selectedId && !selected && !Object.values(lanes).some(lane => lane.loading)) select(undefined)
  }, [selected, selectedId, lanes])
  const inspect = async (card: WorkBoardCard) => {
    const { artifactId, revision } = card.artifact
    const generation = ++inspectionGeneration.current
    const current = () => generation === inspectionGeneration.current && lastContext.current === context && activeRef.current
    setInspecting(true); setInspectionError(false)
    try {
      const page = await query({ perspective: 'WORK', column: card.artifact.status === 'COMPLETED' ? 'COMPLETED' : 'PENDING', inspect: { artifactId, revision } })
      const value = page.inspection
      if (!current()) return
      if (!value || value.artifactId !== artifactId || value.revision !== revision) throw new Error('BOARD_CHANGED')
      setInspections(previous => ({ ...previous, [artifactId]: value }))
    } catch {
      if (current()) setInspectionError(true)
    } finally {
      if (current()) setInspecting(false)
    }
  }
  const choose = (card: WorkBoardCard) => {
    select(card.artifact.artifactId)
    if (perspective === 'WORK') void inspect(card)
  }
  const openArtifact = (artifactId: string) => {
    if (context && context === lastContext.current && activeRef.current) onArtifact?.({ repositoryId: context.repositoryId, artifactId })
  }
  const updatedAt = Object.values(lanes).flatMap(lane => lane.page ? [lane.page.queriedAt] : []).sort().at(-1)
  const error = Object.values(lanes).find(lane => lane.error)?.error

  return <section className="wb-perspective" hidden={hidden} aria-label={perspective === 'WORK' ? 'Trabalhos' : 'Ideias'} onKeyDown={event => {
    if (selected && event.key === 'Escape') { event.stopPropagation(); close() }
  }}>
    <div className="wb-toolbar">
      <div>
        <p role="status">{updatedAt ? `Consulta documental · ${date(updatedAt)}` : context ? 'Consulta documental do Continuum' : 'Selecione um repositório para ver o trabalho.'}</p>
        {error && <p className="wb-read-error" role="alert">{error}</p>}
      </div>
      <button ref={refreshButton} disabled={!context} onClick={refresh}><RefreshCw size={14} aria-hidden="true"/> Atualizar</button>
    </div>
    {context && <div className="wb-workspace">
      <div className="wb-columns" aria-label="Colunas do quadro" tabIndex={0}>
        {columns[perspective].map(selection => {
          const id = selection.column
          const label = columnLabels[id]
          const Icon = id === 'COMPLETED' || id === 'IMPLEMENTED' ? CheckCircle2 : Circle
          const lane = lanes[id] ?? emptyLane
          const cards = lane.page?.cards ?? []
          return <section key={id} className={`wb-lane wb-lane--${id.toLowerCase()}`} aria-labelledby={`wb-${id}`} aria-busy={lane?.loading || undefined}>
            <h2 id={`wb-${id}`}><Icon size={15} aria-hidden="true"/>{label}</h2>
            <div className="wb-cards" tabIndex={0} aria-label={`Cartões em ${label.toLowerCase()}`}>
              {cards.map(card => {
                const { artifact } = card
                const observed = inspectionFor(card)
                return <button type="button" className="wb-card" key={artifact.artifactId} aria-expanded={selectedId === artifact.artifactId}
                  ref={button => { if (button) cardButtons.current.set(artifact.artifactId, button); else cardButtons.current.delete(artifact.artifactId) }}
                  onClick={() => choose(card)}>
                  <small>{kind(artifact)}</small>
                  <strong title={artifact.name}>{artifact.name}</strong>
                  {observed?.reconciliation.sources.length ? <small className={id === 'COMPLETED' ? 'wb-proof' : 'wo-warning'}>
                    {id === 'COMPLETED' ? 'Prova de validação vinculada' : 'Possível divergência'}
                  </small> : null}
                </button>
              })}
              {lane?.error && <p>{lane.page ? 'Exibindo a última consulta.' : 'Dados indisponíveis.'}</p>}
              {lane?.loading && <p role="status">Consultando documentos…</p>}
              {!cards.length && !lane.loading && !lane.error && lane.page && <p>{lane.page.coverage === 'COMPLETE' ? 'Nenhum cartão nesta coluna.' : 'Cobertura documental parcial.'}</p>}
              {lane?.page?.nextCursor && <button disabled={lane.loading || !!lane.error}
                onClick={() => void load(selection, queryGeneration.current, lane.page?.nextCursor)}>Carregar mais</button>}
            </div>
          </section>
        })}
      </div>
      {selected && <aside className="wb-inspector" aria-labelledby={`wb-detail-${perspective}`} ref={inspector} tabIndex={-1}>
        <header><div><small>{kind(selected.artifact)}</small><h2 id={`wb-detail-${perspective}`}>{selected.artifact.name}</h2></div>
          <button onClick={close} aria-label="Fechar detalhes"><X size={17} aria-hidden="true"/></button></header>
        {selected.artifact.description && <p>{selected.artifact.description}</p>}
        <p className="wb-document-meta"><code>{selected.artifact.artifactId}</code><span>Revisão {selected.artifact.revision} · {status(selected.artifact)} no Continuum · {date(selected.artifact.updatedAt)}</span></p>
        <div className="wb-actions">
          <button disabled={!onArtifact} onClick={() => openArtifact(selected.artifact.artifactId)}>Abrir no Continuum <ArrowUpRight size={14} aria-hidden="true"/></button>
        </div>
        {perspective === 'WORK' && <section>
          <h3>Atividade e validação</h3>
          {inspection?.branch && <p>Branch vinculada · <code>{inspection.branch.ref}</code></p>}
          {inspecting && <p role="status">Verificando vínculos e evidências…</p>}
          {inspectionError && <p role="alert">A verificação ficou indisponível.</p>}
          {inspection && <p>{inspection.activity.state === 'ACTIVE' ? `Sessão ativa observada em ${date(inspection.activity.observedAt)}. Observação pontual da execução selecionada.`
            : inspection.activity.state === 'UNAVAILABLE' ? 'Fonte de atividade indisponível.' : 'Atividade atual inconclusiva para esta unidade.'}</p>}
          {inspection?.bindingArtifactId && <p><button disabled={!onArtifact} onClick={() => openArtifact(inspection.bindingArtifactId!)}>Abrir vínculo de execução</button></p>}
          {inspection?.reconciliation.sources.length ? <>
            <h4 className={selected.artifact.status === 'COMPLETED' ? 'wb-proof' : 'wo-warning'}>{selected.artifact.status === 'COMPLETED' ? 'Prova de validação vinculada' : 'Possível divergência'}</h4>
            <ul>{inspection.reconciliation.sources.map(({ artifact, relation, proofIds }) => <li key={artifact.artifactId + relation}>
              <button disabled={!onArtifact} onClick={() => openArtifact(artifact.artifactId)}>{artifact.name}</button>
              <small>{relation} · {proofIds.join(', ')}</small>
            </li>)}</ul>
          </> : inspection && <p>{inspection.reconciliation.coverage === 'UNAVAILABLE' ? 'Reconciliação indisponível.' : 'Cobertura de reconciliação parcial.'}</p>}
          <button disabled={inspecting} onClick={() => void inspect(selected)}>Verificar novamente</button>
        </section>}
        <section>
          <h3>Artifacts ligados</h3>
          {selected.ambiguous && <p>Vínculo de escopo ambíguo. Os cartões relacionados continuam visíveis.</p>}
          {selected.relationCoverage !== 'COMPLETE' && <p>Cobertura de relações parcial.</p>}
          {selected.workItem && !selected.relations.some(relation => relation.artifact.artifactId === selected.workItem!.artifactId) &&
            <button disabled={!onArtifact} onClick={() => openArtifact(selected.workItem!.artifactId)}>{selected.workItem.name}</button>}
          {selected.relations.length ? <ul>{selected.relations.map(({ artifact, kind, direction }) => <li key={artifact.artifactId + kind + direction}>
            <button disabled={!onArtifact} onClick={() => openArtifact(artifact.artifactId)}>{artifact.name}</button>
            <small>{[kind, direction === 'INBOUND' ? 'Recebida' : 'Emitida', status(artifact)].filter(Boolean).join(' · ')}</small><code>{artifact.artifactId}</code>
          </li>)}</ul> : selected.relationCoverage === 'COMPLETE' && !selected.workItem && <p>Sem relações diretas.</p>}
        </section>
      </aside>}
    </div>}
  </section>
}
