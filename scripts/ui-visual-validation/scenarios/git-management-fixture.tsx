import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GitManagementView } from '../../../src/renderer/src/components/GitManagementView/GitManagementView'
import '../../../src/renderer/src/index.css'
import type { ActiveProjectState } from '../../../src/shared/types/active-project-types'
import { GlobalSidebar } from '../../../src/renderer/src/components/GlobalSidebar/GlobalSidebar'
import type { Tab } from '../../../src/renderer/src/config/navigation'
import '../../../src/renderer/src/App.css'

document.body.dataset.theme = 'dark'
localStorage.setItem('theme-preference', 'dark')
function Fixture() {
  const [state, setState] = useState<ActiveProjectState>({
    revision: -1,
    project: null
  })
  const [sidebar, setSidebar] = useState(true)
  const [tab, setTab] = useState<Tab>('git-management')
  useEffect(() => {
    void window.codeAwareness.getActiveProject().then(setState)
  }, [])
  const activate = (id: string | null) =>
    window.codeAwareness.activateProject(id).then((result) => {
      if (result.data) setState(result.data)
    })
  return (
    <div
      className={`app-layout ${sidebar ? 'sidebar-open' : 'sidebar-closed'}`}
    >
      <GlobalSidebar
        isSidebarOpen={sidebar}
        setIsSidebarOpen={setSidebar}
        activeTab={tab}
        setActiveTab={setTab}
        activeProject={state.project}
        onSelectRepository={(id) => void activate(id)}
        onOpenTags={() => {}}
        onOpenIgnored={() => {}}
      />
      <main className="app-main">
        <div style={{ display: 'flex', gap: 12, padding: 6 }}>
          <button
            data-proof-project="a"
            onClick={() => void activate('proof-a')}
          >
            Repository A
          </button>
          <button
            data-proof-project="b"
            onClick={() => void activate('proof-b')}
          >
            Repository B
          </button>
          <button data-proof-project="none" onClick={() => void activate(null)}>
            No repository
          </button>
          <button
            data-proof-project="non-git"
            onClick={() => void activate('proof-non-git')}
          >
            Non Git
          </button>
        </div>
        {tab === 'git-management' ? (
          <GitManagementView
            key={`${state.project?.id}:${state.revision}`}
            state={state}
          />
        ) : (
          <p>Existing navigation: {tab}</p>
        )}
      </main>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
