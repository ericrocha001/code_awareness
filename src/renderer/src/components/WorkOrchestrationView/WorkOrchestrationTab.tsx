import React, { useEffect, useState } from 'react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type { ArtifactNavigation } from './BranchExecutions'
import { BranchManagerView } from './BranchManagerView'
import type { OrchestrationAttention } from '../../../../shared/types/work-orchestration-attention-types'
import type { CommitNavigationIntent } from '../../../../shared/types/worktree-integration-evidence-types'
export function WorkOrchestrationTab({ state, active, attention, onCommit, onArtifact }: { state: ActiveProjectState; active: boolean; attention?: OrchestrationAttention | null; onCommit?: (intent: CommitNavigationIntent) => void; onArtifact?: (intent: ArtifactNavigation) => void }) {
  const [visited, setVisited] = useState(false)
  useEffect(() => { if (active) setVisited(true) }, [active])
  return <div className="wo-tab" hidden={!active} aria-hidden={!active} style={{ height: '100%', minHeight: 0 }}>
    {(active || visited) && <BranchManagerView state={state} active={active} onCommit={onCommit} onArtifact={onArtifact} />}
  </div>
}
