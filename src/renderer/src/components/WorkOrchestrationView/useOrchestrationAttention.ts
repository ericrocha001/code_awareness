import { useEffect, useRef, useState } from 'react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type { OrchestrationAttention, OrchestrationAttentionChange } from '../../../../shared/types/work-orchestration-attention-types'

export function useOrchestrationAttention(state: ActiveProjectState, active: boolean) {
  const [attention, setAttention] = useState<OrchestrationAttention | null>(null)
  const seen = useRef(new Set<string>())
  const identity = `${state.project?.id}:${state.revision}`
  useEffect(() => {
    let current = true
    seen.current.clear(); setAttention(null)
    if (!state.project || !window.codeAwareness.onWorkOrchestrationChanged) return
    const context = { projectId: state.project.id, revision: state.revision }
    let received = false
    const receive = (change: OrchestrationAttentionChange) => {
      if (current && change.context.projectId === context.projectId && change.context.revision === context.revision) setAttention(change.attention)
    }
    const unsubscribe = window.codeAwareness.onWorkOrchestrationChanged(change => { received = true; receive(change) })
    void window.codeAwareness.getWorkOrchestration({ context, attention: true }).then(result => {
      if (current && !received && result.success && 'alerts' in result.data) receive({ context: result.context, attention: result.data })
    }).catch(() => {})
    return () => { current = false; unsubscribe() }
  }, [identity])
  const token = (alert: NonNullable<OrchestrationAttention>['alerts'][number]) => `${alert.id}:${alert.providerRevision}:${alert.consumerRevision}`
  const unseen = attention?.alerts.filter(a => a.state === 'CURRENT' && !seen.current.has(token(a))).length ?? 0
  useEffect(() => { if (active) for (const alert of attention?.alerts ?? []) seen.current.add(token(alert)) }, [active, attention])
  return { attention, unseen: active ? 0 : unseen }
}
