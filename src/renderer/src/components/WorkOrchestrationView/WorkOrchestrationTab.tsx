import React, { useEffect, useState } from 'react'
import { GitBranch } from 'lucide-react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type { ArtifactNavigation } from './BranchExecutions'
import { BranchManagerView } from './BranchManagerView'
import type { OrchestrationAttention } from '../../../../shared/types/work-orchestration-attention-types'
import type { CommitNavigationIntent } from '../../../../shared/types/worktree-integration-evidence-types'
import type { WorkBoardBranch } from '../../../../shared/types/work-board-types'
import { WorkBoard } from './WorkBoard'
import './WorkBoard.css'

export function WorkOrchestrationTab({ state, active, attention, onCommit, onArtifact }: { state: ActiveProjectState; active: boolean; attention?: OrchestrationAttention | null; onCommit?: (intent: CommitNavigationIntent) => void; onArtifact?: (intent: ArtifactNavigation) => void }) {
  const [view, setView] = useState<'board' | 'branches'>('board')
  const [visited, setVisited] = useState({ board: false, branches: false })
  const [branch, setBranch] = useState<WorkBoardBranch>()
  useEffect(() => { if (active) setVisited(current => current[view] ? current : { ...current, [view]: true }) }, [active, view])
  const boardActive = active && view === 'board'
  const branchesActive = active && view === 'branches'
  return <div className="wo-tab" hidden={!active} aria-hidden={!active} style={{ height: '100%', minHeight: 0 }}>
    <div className="wo-view wb-feature">
      <header className="wo-header"><div className="wo-feature-identity">
        <span className="wo-feature-icon"><GitBranch size={34} aria-hidden="true"/></span>
        <div><h1>Work Orchestration</h1><p>Trabalho planejado, branches e entregas</p></div>
      </div></header>
      <nav className="wb-views" aria-label="Visões de Work Orchestration">
        <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>Work Board</button>
        <button type="button" aria-pressed={view === 'branches'} onClick={() => setView('branches')}>Branches &amp; Worktrees</button>
      </nav>
      {(boardActive || visited.board) && <div className="wb-panel" hidden={view !== 'board'}>
        <WorkBoard key={`${state.project?.id}:${state.revision}:${state.context?.repositoryId}`} state={state} active={boardActive} onArtifact={onArtifact}
          onBranch={branch => { setBranch(branch); setView('branches') }}/>
      </div>}
      {(branchesActive || visited.branches) && <div className="wb-panel" hidden={view !== 'branches'}>
        <BranchManagerView state={state} active={branchesActive} embedded branchIntent={branch} onCommit={onCommit} onArtifact={onArtifact}/>
      </div>}
    </div>
  </div>
}
