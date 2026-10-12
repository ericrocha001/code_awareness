import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, RefreshCw } from 'lucide-react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type {
  GitHistoryPage,
  GitOverview
} from '../../../../shared/types/git-management-types'
import { layoutGitGraph } from './graph-layout'
import { GitInspector, type GitSelection } from './GitInspector'
import { GitActions } from './GitActions'
import './GitManagementView.css'

const laneColors = [
  'var(--accent)',
  'var(--color-green)',
  'var(--status-restored)',
  'var(--color-warning)',
  'var(--color-danger)'
]
export function GitManagementView({ state }: { state: ActiveProjectState }) {
  const [history, setHistory] = useState<GitHistoryPage | null>(null)
  const [selection, setSelection] = useState<GitSelection>(null)
  const [overview, setOverview] = useState<GitOverview | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const generation = useRef(0)
  const returnFocus = useRef<HTMLElement | null>(null)
  const context = useMemo(
    () => ({ projectId: state.project?.id ?? '', revision: state.revision }),
    [state.project?.id, state.revision]
  )
  const load = useCallback(
    async (cursor?: string) => {
      if (!state.project) return
      const request = ++generation.current
      setLoading(true)
      setError('')
      try {
        const result = await window.codeAwareness.getGitManagementHistory({
          context: { projectId: state.project.id, revision: state.revision },
          limit: 50,
          cursor
        })
        if (generation.current !== request) return
        if (!result.success) {
          setError(result.code)
          return
        }
        setHistory((previous) =>
          cursor && previous?.snapshot === result.data.snapshot
            ? {
                ...result.data,
                nodes: [...previous.nodes, ...result.data.nodes]
              }
            : result.data
        )
        if (!cursor) {
          const observed =
            await window.codeAwareness.getGitManagementOverview(context)
          if (generation.current !== request) return
          if (observed.success) setOverview(observed.data)
          else {
            setOverview(null)
            setError(observed.code)
          }
        }
      } catch {
        if (generation.current === request)
          setError(
            'Falha ao carregar histórico. Atualize para tentar novamente.'
          )
      } finally {
        if (generation.current === request) setLoading(false)
      }
    },
    [state.project?.id, state.revision]
  )
  useEffect(() => {
    void load()
    const focus = () => void load()
    const unsubscribe = window.codeAwareness.onCodeMapFileModified?.(
      (event) => {
        if (
          event.repoPath.replace(/\\/g, '/').toLowerCase() ===
          state.project?.path.replace(/\\/g, '/').toLowerCase()
        )
          void load()
      }
    )
    window.addEventListener('focus', focus)
    return () => {
      generation.current++
      window.removeEventListener('focus', focus)
      unsubscribe?.()
    }
  }, [load])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drawer) {
        setDrawer(false)
        returnFocus.current?.focus()
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [drawer])
  useEffect(() => {
    setSelection((previous) =>
      previous?.kind === 'BRANCH'
        ? (() => {
            const ref = history?.refs.find(
              (ref) => ref.ref === previous.ref.ref
            )
            return ref ? { kind: 'BRANCH' as const, ref } : null
          })()
        : previous
    )
  }, [history?.snapshot])
  const graph = useMemo(() => layoutGitGraph(history?.nodes ?? []), [history])
  const selected =
    selection?.kind === 'COMMIT' ? selection.sha : selection?.ref.sha
  const select = (sha: string) => {
    returnFocus.current = document.activeElement as HTMLElement
    setSelection({ kind: 'COMMIT', sha })
    setDrawer(true)
  }
  if (!state.project)
    return (
      <section className="gm-empty">
        <GitBranch size={32} />
        <h2>Git Management</h2>
        <p>Abra um repositório para explorar seu histórico.</p>
      </section>
    )
  return (
    <section className="gm-view" aria-label="Git Management">
      <header className="gm-header">
        <div>
          <h1>
            <GitBranch size={20} /> Git Management
          </h1>
          <p>
            {state.project.name}{' '}
            <span>
              {' '}
              /{' '}
              {history?.branch ??
                (history?.head ? 'detached HEAD' : 'sem commits')}
              {overview
                ? ` · ${overview.changes.length} arquivos alterados`
                : ''}
            </span>
          </p>
        </div>
        <div className="gm-toolbar">
          <label>
            Branch{' '}
            <select
              aria-label="Branch no histórico"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value)
                const ref = history?.refs.find(
                  (ref) => ref.ref === event.target.value
                )
                setSelection(ref ? { kind: 'BRANCH', ref } : null)
                setDrawer(true)
              }}
            >
              <option value="">Todas as branches</option>
              {history?.refs
                .filter((ref) => ref.kind !== 'HEAD')
                .map((ref) => (
                  <option key={ref.ref} value={ref.ref}>
                    {ref.name}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={loading}
            onClick={() => void load()}
            aria-label="Atualizar Git"
          >
            <RefreshCw size={16} /> Atualizar
          </button>
          <button
            onClick={() => {
              setSelection(null)
              setFilter('')
              setDrawer(true)
            }}
          >
            Alterações
          </button>
          <button className="gm-context-toggle" onClick={() => setDrawer(true)}>
            Detalhes
          </button>
        </div>
      </header>
      {error && (
        <div className="gm-error" role="alert">
          {error === 'NOT_GIT_REPOSITORY'
            ? 'Este projeto não é um repositório Git.'
            : error}
        </div>
      )}
      <div className="gm-workspace">
        <div className="gm-history" aria-busy={loading}>
          <div className="gm-pane-heading">
            <strong>Histórico</strong>
            <span>{history?.nodes.length ?? 0} commits carregados</span>
          </div>
          <div className="gm-history-scroll">
            <div
              className="gm-graph"
              style={
                {
                  '--graph-width': `${Math.max(84, graph.laneCount * 22 + 24)}px`
                } as React.CSSProperties
              }
            >
              <svg
                className="gm-lines"
                width={Math.max(84, graph.laneCount * 22 + 24)}
                height={graph.points.length * 68 + 34}
                aria-label="Relações entre commits"
              >
                {graph.edges.map((edge) => {
                  const x = 22 + edge.fromLane * 22,
                    targetX = 22 + edge.toLane * 22,
                    y = edge.fromRow * 68 + 34,
                    targetY = edge.toRow * 68 + 34
                  return (
                    <path
                      key={`${edge.from}:${edge.to}`}
                      d={`M ${x} ${y} C ${x} ${y + 34}, ${targetX} ${y + 34}, ${targetX} ${Math.min(targetY, y + 68)} L ${targetX} ${targetY}`}
                      stroke={laneColors[edge.toLane % laneColors.length]}
                      strokeWidth="2"
                      fill="none"
                      strokeDasharray={edge.pending ? '4 4' : undefined}
                    >
                      <title>
                        {edge.from} → {edge.to}
                        {edge.pending ? ' (fora da página)' : ''}
                      </title>
                    </path>
                  )
                })}
                {graph.points.map((point) => (
                  <circle
                    key={point.node.sha}
                    cx={22 + point.lane * 22}
                    cy={point.row * 68 + 34}
                    r={point.node.sha === selected ? 7 : 5}
                    fill="var(--bg-primary)"
                    stroke={laneColors[point.lane % laneColors.length]}
                    strokeWidth="3"
                  />
                ))}
              </svg>
              {graph.points.map(({ node }) => (
                <button
                  className="gm-commit"
                  key={node.sha}
                  aria-pressed={node.sha === selected}
                  onClick={() => select(node.sha)}
                >
                  <span className="gm-commit-title">{node.subject}</span>
                  <span className="gm-commit-meta">
                    {node.author} ·{' '}
                    {new Date(node.timestamp).toLocaleDateString()} ·{' '}
                    {node.sha.slice(0, 7)}
                  </span>
                  <span className="gm-refs">
                    {node.decorations.map((ref) => (
                      <span
                        key={ref.ref}
                        title={
                          ref.kind === 'REMOTE'
                            ? 'Branch de rastreamento remoto'
                            : ref.kind === 'LOCAL'
                              ? 'Branch local: referência móvel para um commit'
                              : ref.name
                        }
                      >
                        {ref.name}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
            {!history?.nodes.length && (
              <p className="gm-placeholder">
                {loading
                  ? 'Carregando histórico…'
                  : error
                    ? 'Histórico indisponível.'
                    : 'Nenhum commit neste repositório.'}
              </p>
            )}
            {history?.nextCursor && (
              <button
                className="gm-load-more"
                disabled={loading}
                onClick={() => void load(history.nextCursor!)}
              >
                Carregar anteriores
              </button>
            )}
          </div>
        </div>
        <aside
          className={`gm-inspector ${drawer ? 'is-open' : ''}`}
          aria-label="Detalhes Git"
        >
          <div className="gm-pane-heading">
            <strong>
              {selection?.kind === 'COMMIT'
                ? 'Commit selecionado'
                : selection?.kind === 'BRANCH'
                  ? 'Branch selecionada'
                  : 'Repositório'}
            </strong>
            <button
              className="gm-context-toggle"
              onClick={() => setDrawer(false)}
            >
              Fechar
            </button>
          </div>
          <div className="gm-inspector-scroll">
            {error && !overview ? (
              <p>Estado Git indisponível.</p>
            ) : (
              <GitInspector
                context={context}
                overview={overview}
                selection={selection}
              />
            )}
            {overview && (
              <div hidden={!!selection}>
                <GitActions
                  context={context}
                  overview={overview}
                  history={history}
                  refresh={() => load()}
                  blocked={loading || !!error}
                />
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  )
}
