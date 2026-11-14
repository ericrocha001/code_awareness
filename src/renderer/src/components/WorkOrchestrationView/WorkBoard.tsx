import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, CheckCircle2, Circle, CircleDot, RefreshCw, X } from 'lucide-react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type { WorkBoardArtifact, WorkBoardBranch, WorkBoardCard, WorkBoardColumn, WorkBoardInspection, WorkBoardPage, WorkBoardRequest } from '../../../../shared/types/work-board-types'
import type { ArtifactNavigation } from './BranchExecutions'

const columns = [
  { id: 'QUEUED', label: 'Na fila', Icon: Circle },
  { id: 'ACTIVE', label: 'Em andamento', Icon: CircleDot },
  { id: 'COMPLETED', label: 'Concluído', Icon: CheckCircle2 }
] as const
type DocumentColumn = Exclude<WorkBoardColumn, 'ACTIVE'>
interface Lane { page?: WorkBoardPage; loading: boolean; error?: string }
const initial = { QUEUED: { loading: false }, COMPLETED: { loading: false } }
const date = (value: string) => new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
const kind = (artifact: WorkBoardArtifact) => artifact.kind === 'EXECUTABLE_PLAN' ? 'Plano executável' : artifact.kind === 'WORK_ITEM' ? 'Work Item' : artifact.kind === 'IMPLEMENTATION_HANDOFF' ? 'Handoff' : artifact.kind

export function WorkBoard({ state, active, onArtifact, onBranch }: {
  state: ActiveProjectState; active: boolean; onArtifact?: (intent: ArtifactNavigation) => void; onBranch: (target: WorkBoardBranch) => void
}) {
  const { revision, project } = state
  const repositoryId = state.context?.repositoryId
  const projectId = project?.id
  const context = useMemo(() => repositoryId && projectId ? { repositoryId, projectId, revision } : undefined, [repositoryId, projectId, revision])
  const ready = state.context?.capabilities.continuum.state
  const [lanes, setLanes] = useState<Record<DocumentColumn, Lane>>(initial)
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

  const query = useCallback(async (input: Omit<WorkBoardRequest, 'context'>) => {
    if (!context) throw new Error('CONTINUUM_UNAVAILABLE')
    const result = await window.codeAwareness.getWorkBoard({ context, ...input })
    if (!result.success) throw new Error(result.code)
    if (result.context.repositoryId !== context.repositoryId || result.context.projectId !== context.projectId ||
      result.context.revision !== context.revision || result.page.column !== input.column) throw new Error('PROJECT_CONTEXT_CHANGED')
    return result.page
  }, [context])
  const load = useCallback(async (column: DocumentColumn, generation: number, cursor?: string) => {
    const current = () => generation === queryGeneration.current && lastContext.current === context && activeRef.current
    setLanes(previous => ({ ...previous, [column]: { ...previous[column], loading: true, error: undefined } }))
    try {
      const page = await query({ column, cursor })
      if (!current()) return
      setLanes(previous => ({ ...previous, [column]: { loading: false, page: cursor
        ? { ...page, cards: [...previous[column].page!.cards, ...page.cards] }
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
    void load('QUEUED', generation)
    void load('COMPLETED', generation)
  }, [context, load, ready])
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
      if (lanes.QUEUED.loading || lanes.COMPLETED.loading) dirty.current = true
    }
  }, [active, lanes])
  const queued = lanes.QUEUED.page?.cards ?? []
  const completed = lanes.COMPLETED.page?.cards ?? []
  const inspectionFor = (card: WorkBoardCard) => {
    const value = inspections[card.artifact.artifactId]
    return value?.revision === card.artifact.revision ? value : undefined
  }
  const inProgress = queued.filter(card => inspectionFor(card)?.column === 'ACTIVE')
  const selected = [...queued, ...completed].find(card => card.artifact.artifactId === selectedId)
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
    if (selectedId && !selected && !lanes.QUEUED.loading && !lanes.COMPLETED.loading) select(undefined)
  }, [selected, selectedId, lanes])
  const inspect = async (card: WorkBoardCard) => {
    const { artifactId, revision } = card.artifact
    const generation = ++inspectionGeneration.current
    const current = () => generation === inspectionGeneration.current && lastContext.current === context && activeRef.current
    setInspecting(true); setInspectionError(false)
    try {
      const page = await query({ column: card.artifact.status === 'COMPLETED' ? 'COMPLETED' : 'QUEUED', inspect: { artifactId, revision } })
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
    void inspect(card)
  }
  const openArtifact = (artifactId: string) => {
    if (context && context === lastContext.current && activeRef.current) onArtifact?.({ repositoryId: context.repositoryId, artifactId })
  }
  const updatedAt = [lanes.QUEUED.page?.queriedAt, lanes.COMPLETED.page?.queriedAt].filter(Boolean).sort().at(-1)
  const columnCards = { QUEUED: queued.filter(card => inspectionFor(card)?.column !== 'ACTIVE'), ACTIVE: inProgress, COMPLETED: completed }

  return <section className="wb-board" aria-label="Work Board" onKeyDown={event => {
    if (selected && event.key === 'Escape') { event.stopPropagation(); close() }
  }}>
    <div className="wb-toolbar">
      <div>
        <p role="status">{updatedAt ? `Consulta documental · ${date(updatedAt)}` : context ? 'Consulta documental do Continuum' : 'Selecione um repositório para ver o trabalho.'}</p>
        {(lanes.QUEUED.error || lanes.COMPLETED.error) && <p className="wb-read-error" role="alert">{lanes.QUEUED.error ?? lanes.COMPLETED.error}</p>}
      </div>
      <button ref={refreshButton} disabled={!context} onClick={refresh}><RefreshCw size={14} aria-hidden="true"/> Atualizar</button>
    </div>
    {context && <div className="wb-workspace">
      <div className="wb-columns" aria-label="Colunas do quadro" tabIndex={0}>
        {columns.map(({ id, label, Icon }) => {
          const cards = columnCards[id]
          const lane = id === 'ACTIVE' ? undefined : lanes[id]
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
                  {id === 'ACTIVE' && observed && <small className="wb-activity">Sessão observada às {date(observed.activity.observedAt)}</small>}
                  {observed?.reconciliation.sources.length ? <small className={id === 'COMPLETED' ? 'wb-proof' : 'wo-warning'}>
                    {id === 'COMPLETED' ? 'Prova de validação vinculada' : 'Possível divergência'}
                  </small> : null}
                </button>
              })}
              {lane?.error && <p>{lane.page ? 'Exibindo a última consulta.' : 'Dados indisponíveis.'}</p>}
              {lane?.loading && <p role="status">Consultando documentos…</p>}
              {!cards.length && !lane?.loading && !lane?.error && <p>{id === 'ACTIVE'
                ? 'Selecione um cartão para verificar a atividade da execução.'
                : lane?.page?.coverage === 'COMPLETE' ? 'Nenhum cartão nesta coluna.' : 'Cobertura documental parcial.'}</p>}
              {lane?.page?.nextCursor && <button disabled={lane.loading || !!lane.error}
                onClick={() => { if (id !== 'ACTIVE') void load(id, queryGeneration.current, lane.page?.nextCursor) }}>Carregar mais</button>}
            </div>
          </section>
        })}
      </div>
      {selected && <aside className="wb-inspector" aria-labelledby="wb-detail-title" ref={inspector} tabIndex={-1}>
        <header><div><small>{kind(selected.artifact)}</small><h2 id="wb-detail-title">{selected.artifact.name}</h2></div>
          <button onClick={close} aria-label="Fechar detalhes"><X size={17} aria-hidden="true"/></button></header>
        {selected.artifact.description && <p>{selected.artifact.description}</p>}
        <p className="wb-document-meta"><code>{selected.artifact.artifactId}</code><span>Revisão {selected.artifact.revision} · {selected.artifact.status === 'COMPLETED' ? 'Concluído no Continuum' : 'Pendente no Continuum'} · {date(selected.artifact.updatedAt)}</span></p>
        <div className="wb-actions">
          <button disabled={!onArtifact} onClick={() => openArtifact(selected.artifact.artifactId)}>Abrir no Continuum <ArrowUpRight size={14} aria-hidden="true"/></button>
          {inspection?.branch && <button onClick={() => onBranch(inspection.branch!)}>Ver branch/execução</button>}
        </div>
        <section>
          <h3>Atividade e validação</h3>
          {inspecting && <p role="status">Verificando vínculos e evidências…</p>}
          {inspectionError && <p role="alert">A verificação ficou indisponível.</p>}
          {inspection && <p>{inspection.activity.state === 'ACTIVE' ? `Sessão ativa observada em ${date(inspection.activity.observedAt)}. Observação pontual da execução selecionada.`
            : inspection.activity.state === 'UNAVAILABLE' ? 'Fonte de atividade indisponível.' : 'Atividade atual inconclusiva para esta unidade.'}</p>}
          {inspection?.bindingArtifactId && <p><button disabled={!onArtifact} onClick={() => openArtifact(inspection.bindingArtifactId!)}>Abrir vínculo de execução</button></p>}
          {inspection?.reconciliation.sources.length ? <>
            <h4 className={inspection.column === 'COMPLETED' ? 'wb-proof' : 'wo-warning'}>{inspection.column === 'COMPLETED' ? 'Prova de validação vinculada' : 'Possível divergência'}</h4>
            <ul>{inspection.reconciliation.sources.map(({ artifact, relation, proofIds }) => <li key={artifact.artifactId + relation}>
              <button disabled={!onArtifact} onClick={() => openArtifact(artifact.artifactId)}>{artifact.name}</button>
              <small>{relation} · {proofIds.join(', ')}</small>
            </li>)}</ul>
          </> : inspection && <p>{inspection.reconciliation.coverage === 'UNAVAILABLE' ? 'Reconciliação indisponível.' : 'Cobertura de reconciliação parcial.'}</p>}
          <button disabled={inspecting} onClick={() => void inspect(selected)}>Verificar novamente</button>
        </section>
        <section>
          <h3>Artifacts ligados</h3>
          {selected.ambiguous && <p>Vínculo de escopo ambíguo. Os cartões relacionados continuam visíveis.</p>}
          {selected.relationCoverage !== 'COMPLETE' && <p>Cobertura de relações parcial.</p>}
          {selected.workItem && !selected.relations.some(relation => relation.artifact.artifactId === selected.workItem!.artifactId) &&
            <button disabled={!onArtifact} onClick={() => openArtifact(selected.workItem!.artifactId)}>{selected.workItem.name}</button>}
          {selected.relations.length ? <ul>{selected.relations.map(({ artifact, kind, direction }) => <li key={artifact.artifactId + kind + direction}>
            <button disabled={!onArtifact} onClick={() => openArtifact(artifact.artifactId)}>{artifact.name}</button>
            <small>{kind} · {direction === 'INBOUND' ? 'Recebida' : 'Emitida'}</small><code>{artifact.artifactId}</code>
          </li>)}</ul> : selected.relationCoverage === 'COMPLETE' && !selected.workItem && <p>Sem relações diretas.</p>}
        </section>
      </aside>}
    </div>}
  </section>
}
