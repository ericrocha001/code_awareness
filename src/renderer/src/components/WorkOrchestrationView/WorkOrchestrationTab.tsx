import React, { useEffect, useState } from 'react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import { WorkOrchestrationView } from './WorkOrchestrationView'
import type { OrchestrationAttention } from '../../../../shared/types/work-orchestration-attention-types'
import type { CommitNavigationIntent } from '../../../../shared/types/worktree-integration-evidence-types'
export function WorkOrchestrationTab({ state, active, attention, onCommit }: { state: ActiveProjectState; active: boolean; attention?: OrchestrationAttention | null; onCommit?: (intent: CommitNavigationIntent) => void }) {
  const [visited, setVisited] = useState(false)
  useEffect(() => { if (active) setVisited(true) }, [active])
  return <div className="wo-tab" hidden={!active} aria-hidden={!active} style={{ height: '100%', minHeight: 0 }}>
    {(active || visited) && <WorkOrchestrationView state={state} active={active} attention={attention} onCommit={onCommit} />}
  </div>
}
