import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkOrchestrationTab } from '../../../src/renderer/src/components/WorkOrchestrationView/WorkOrchestrationTab'
import { GitManagementView } from '../../../src/renderer/src/components/GitManagementView/GitManagementView'
import { GlobalSidebarNav } from '../../../src/renderer/src/components/GlobalSidebar/GlobalSidebarNav'
import { NAV_ITEMS, type Tab } from '../../../src/renderer/src/config/navigation'
import type { ActiveProjectState } from '../../../src/shared/types/active-project-types'
import '../../../src/renderer/src/components/GlobalSidebar/GlobalSidebar.css'
import '../../../src/renderer/src/index.css'
function Fixture() {
  const [state, setState] = useState<ActiveProjectState>({ revision: 1, project: { id: 'acceptance-a', path: new URLSearchParams(location.search).get('repositoryPath')!, name: 'Orchestration acceptance' } })
  const [tab, setTab] = useState<Tab>('home')
  useEffect(() => {
    const change = (event: Event) => setState((event as CustomEvent<ActiveProjectState>).detail)
    window.addEventListener('fixture-project', change)
    return () => window.removeEventListener('fixture-project', change)
  }, [])
  return <><aside className="global-sidebar sidebar-open"><div style={{ padding: 20 }}>Code Awareness</div><GlobalSidebarNav items={NAV_ITEMS} activeTab={tab} onSelect={setTab} isSidebarOpen /></aside>
    <div style={{ marginLeft: 224, height: '100%', minWidth: 0 }}><WorkOrchestrationTab key={`${state.project?.id}:${state.revision}`} state={state} active={tab === 'work-orchestration'} />{tab === 'git-management' && <GitManagementView state={state} />}{tab === 'home' && <div data-fixture-home>Home</div>}</div></>
}
document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<Fixture />)
