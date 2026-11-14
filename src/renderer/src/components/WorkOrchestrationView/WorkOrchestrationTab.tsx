import React, { useEffect, useState } from 'react'
import { PanelsTopLeft } from 'lucide-react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import type { ArtifactNavigation } from './BranchExecutions'
import { WorkBoard } from './WorkBoard'
import './WorkOrchestrationView.css'
import './WorkBoard.css'

export function WorkOrchestrationTab({ state, active, onArtifact }: { state: ActiveProjectState; active: boolean; onArtifact?: (intent: ArtifactNavigation) => void }) {
  const [visited, setVisited] = useState(false)
  useEffect(() => { if (active) setVisited(true) }, [active])
  return <div className="wo-tab" hidden={!active} aria-hidden={!active} style={{ height: '100%', minHeight: 0 }}>
    <div className="wo-view wb-feature">
      <header className="wo-header"><div className="wo-feature-identity">
        <span className="wo-feature-icon"><PanelsTopLeft size={34} aria-hidden="true"/></span>
        <div><h1>Work Board</h1><p>Trabalhos e ideias do Continuum</p></div>
      </div></header>
      {(active || visited) && <WorkBoard key={`${state.project?.id}:${state.revision}:${state.context?.repositoryId}`} state={state} active={active} onArtifact={onArtifact}/>}
    </div>
  </div>
}
