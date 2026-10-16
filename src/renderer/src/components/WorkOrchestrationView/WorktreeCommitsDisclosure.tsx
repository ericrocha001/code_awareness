import React, { useEffect, useRef, useState } from 'react'
import { GitCommitHorizontal } from 'lucide-react'
import { WorktreeSectionTitle } from './WorktreeSectionTitle'
import type { ObservableWorktree, OrchestrationContext } from '../../../../shared/types/work-orchestration-types'
import type { WorktreeTimelinePage } from '../../../../shared/types/worktree-integration-evidence-types'

const operationLabel = { COMMIT: 'Commit', INITIAL_COMMIT: 'Commit inicial', AMEND: 'Amend', CHERRY_PICK: 'Cherry-pick', REBASE_PICK: 'Rebase (pick)' }
const reachabilityLabel = { HEAD_CURRENT: 'HEAD atual', REACHABLE: 'Alcançável pelo HEAD atual', NOT_REACHABLE: 'Não alcançável pelo HEAD atual', UNKNOWN: 'Alcançabilidade não verificada' }
export function WorktreeCommitsDisclosure({ tree, context, active }: { tree: ObservableWorktree; context: OrchestrationContext; active: boolean }) {
  const [expanded, setExpanded] = useState(false), [page, setPage] = useState<WorktreeTimelinePage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [visible, setVisible] = useState(40)
  const epoch = useRef(0), opened = useRef(false)
  useEffect(() => {
    epoch.current++; opened.current = false; setExpanded(false); setPage(null); setBusy(false); setError(''); setVisible(40)
    return () => { epoch.current++ }
  }, [tree.worktreeId, tree.generation, tree.head, context.projectId, context.revision, active])
  const load = async () => {
    const request = ++epoch.current
    setBusy(true); setError(''); setPage(null); setVisible(40)
    try {
      const result = await window.codeAwareness.getWorkOrchestration({ context, timeline: { worktreeId: tree.worktreeId, generation: tree.generation } })
      if (epoch.current !== request || !opened.current) return
      if (!result.success) throw new Error(result.code)
      if (!('timeline' in result.data)) throw new Error('TIMELINE_UNAVAILABLE')
      setPage(result.data.timeline)
    } catch (failure) {
      if (epoch.current === request && opened.current) setError(`Histórico de commits realizados nesta worktree indisponível ou obsoleto: ${failure instanceof Error ? failure.message : 'erro de leitura'}`)
    } finally { if (epoch.current === request) setBusy(false) }
  }
  const reveal = () => setVisible(value => Math.min(value + 40, page?.items.length ?? value))
  return <details className="wo-commit-dropdown wo-disclosure" open={expanded} onToggle={event => {
    const next = event.currentTarget.open
    if (next === opened.current) return
    opened.current = next; setExpanded(next)
    if (next && active) void load()
    else { epoch.current++; setPage(null); setBusy(false) }
  }}>
    <summary><WorktreeSectionTitle icon={GitCommitHorizontal} meta={page ? `${page.identifiedCount} identificados` : 'Sob demanda'}>Commits desta worktree</WorktreeSectionTitle></summary>
    {expanded && <>
      <p>Procedência: reflog HEAD deste checkout. Instante da operação local; não é a data do commit nem prova de autoria.</p>
      {busy && <p role="status">Consultando operações locais…</p>}{error && <p role="alert">{error}</p>}
      {page && <>
        <p>{page.coverage === 'PARTIAL' ? 'cobertura parcial' : page.coverage === 'UNAVAILABLE' ? 'indisponível' : page.coverage === 'EMPTY_VERIFIED' ? 'escopo observado vazio' : 'cobertura desde a criação comprovada'}</p>
        {(page.coverage === 'PARTIAL' || page.coverage === 'UNAVAILABLE') && <p role="status">Histórico de commits realizados nesta worktree {page.coverage === 'UNAVAILABLE' ? 'indisponível' : 'incompleto'}. Reflogs podem expirar, ser desativados ou alterados; a contagem não representa toda a vida da worktree.</p>}
        {page.truncated && <p>Limite de leitura atingido; há registros fora desta observação.</p>}
        {page.omitted > 0 && <p>{page.omitted} eventos sem objeto ou operação verificável foram omitidos.</p>}
        <div className="wo-commit-dropdown-list" tabIndex={0} aria-label="Lista de commits locais" onScroll={event => {
          const list = event.currentTarget
          if (list.scrollHeight - list.scrollTop - list.clientHeight < 64) reveal()
        }}>
          <ol>{page.items.slice(0, visible).map((item, index) => <li key={item.sha} onFocus={() => { if (index >= visible - 5) reveal() }}>
            <span className="wo-local-commit-title">{item.title || 'Sem título'} · {item.sha.slice(0, 8)}</span>
            <p>{reachabilityLabel[item.reachability]}</p>
            <p>{operationLabel[item.events[0].operation]} · <time dateTime={item.events[0].eventAt}>{new Date(item.events[0].eventAt).toLocaleString('pt-BR')}</time></p>
            {item.events.length > 1 && <details><summary>{item.events.length} operações locais registradas</summary><ul>{item.events.map(event => <li key={event.sequence}>{operationLabel[event.operation]} · {new Date(event.eventAt).toLocaleString('pt-BR')}</li>)}</ul></details>}
          </li>)}</ol>
        </div>
        {visible < page.items.length && <p role="status">{Math.min(visible, page.items.length)}/{page.identifiedCount} registros exibidos; role para continuar.</p>}
        {!page.items.length && page.coverage !== 'UNAVAILABLE' && <p>Nenhum commit identificável nos registros observados. Isso não comprova ausência de trabalho anterior.</p>}
      </>}
    </>}
  </details>
}
