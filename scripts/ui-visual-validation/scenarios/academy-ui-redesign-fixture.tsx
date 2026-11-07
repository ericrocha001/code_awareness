import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AcademyView, type AcademyNavigationGuard } from '../../../src/renderer/src/components/AcademyView/AcademyView'
import { GlobalSidebar } from '../../../src/renderer/src/components/GlobalSidebar/GlobalSidebar'
import { NAV_ITEMS, type Tab } from '../../../src/renderer/src/config/navigation'
import logo from '../../../src/renderer/public/logo.svg'
import '../../../src/renderer/src/index.css'
import '../../../src/renderer/src/App.css'

function Fixture() {
  const [tab, setTab] = useState<Tab>('academy')
  const [sidebar, setSidebar] = useState(true)
  const guard = useRef<AcademyNavigationGuard | null>(null)
  const bind = useCallback((value: AcademyNavigationGuard | null) => { guard.current = value }, [])
  useEffect(() => { const image = document.querySelector<HTMLImageElement>('.global-sidebar-logo-img'); if (image) image.src = logo }, [])
  const navigate = (next: Tab) => { if (next !== 'academy' && guard.current) guard.current(() => setTab(next)); else setTab(next) }
  return <div className={`app-layout ${sidebar ? 'sidebar-open' : 'sidebar-closed'}`}>
    <GlobalSidebar isSidebarOpen={sidebar} setIsSidebarOpen={setSidebar} activeTab={tab} setActiveTab={navigate} activeProject={{ name: 'code_awareness', path: 'fixture://project' }} onSelectRepository={() => {}} onOpenTags={() => {}} onOpenIgnored={() => {}} items={NAV_ITEMS.filter(item => ['home', 'channel', 'academy', 'git-management', 'code-map'].includes(item.id))} />
    <main className="app-main">{tab === 'academy' ? <AcademyView onNavigationGuardChange={bind} /> : <p>Destino sintético de navegação</p>}</main>
  </div>
}

document.body.dataset.theme = 'dark'
localStorage.setItem('theme-preference', 'dark')
createRoot(document.getElementById('root')!).render(<Fixture />)
