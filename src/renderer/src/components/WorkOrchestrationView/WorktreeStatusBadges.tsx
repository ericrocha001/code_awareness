import React from 'react'
import { CheckCircle2, Clock3, Files, RefreshCw, CircleHelp, AlertCircle, AlertTriangle } from 'lucide-react'
import type { ObservableWorktree } from '../../../../shared/types/work-orchestration-types'
import { reasonLabel } from './work-orchestration-labels'

export function WorktreeStatusBadges({ tree }: { tree: ObservableWorktree }) {
  const verified = tree.observation === 'VERIFIED'
  const states = {
    VERIFIED: ['Observação verificada', 'verified', CheckCircle2],
    NOT_OBSERVED: ['Estado não observado', 'unknown', CircleHelp],
    REVALIDATING: ['Revalidando…', 'working', RefreshCw],
    LAST_KNOWN: ['Último estado conhecido', 'unknown', Clock3],
    STALE: ['Observação obsoleta', 'pending', Clock3],
    UNAVAILABLE: ['Indisponível', 'pending', AlertCircle]
  } as const
  const [title, tone, Icon] = states[tree.observation]
  const count = tree.localChanges?.total
  const knownClean = !tree.conflictCount && (count === 0 || count == null && tree.stagedCount === 0 && tree.unstagedCount === 0 && tree.untrackedCount === 0)
  return <span className="wo-status-badges">
    <span className={`wo-status wo-status--${tone}`} title={tree.reason ? reasonLabel(tree.reason) : title}><Icon size={13} aria-hidden="true" />{title}</span>
    {verified && (count != null || knownClean) && <span className={`wo-status wo-status--${tree.conflictCount ? 'pending' : 'local'}`}><Files size={13} aria-hidden="true" />{knownClean ? 'Sem alterações locais' : `${count} ${count === 1 ? 'caminho local' : 'caminhos locais'}`}</span>}
    {verified && !!tree.conflictCount && <span className="wo-status wo-status--pending"><AlertTriangle size={13} aria-hidden="true" />{tree.conflictCount} em conflito</span>}
    {tree.reason && <span className="wo-status-reason">{reasonLabel(tree.reason)}</span>}
  </span>
}
