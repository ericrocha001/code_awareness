import React, { useEffect, useState } from 'react'
import type { ActiveProjectState } from '../../../../shared/types/active-project-types'
import { WorkOrchestrationView } from './WorkOrchestrationView'
export function WorkOrchestrationTab({ state, active }: { state: ActiveProjectState; active: boolean }) {
  const [visited, setVisited] = useState(false)
  useEffect(() => { if (active) setVisited(true) }, [active])
  return <div className="wo-tab" hidden={!active} aria-hidden={!active} style={{ height: '100%', minHeight: 0 }}>
    {(active || visited) && <WorkOrchestrationView state={state} active={active} />}
  </div>
}
