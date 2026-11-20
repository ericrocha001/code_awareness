import React from 'react'
import { createRoot } from 'react-dom/client'
import { DevelopmentMenu } from '../../../src/renderer/src/components/GlobalSidebar/DevelopmentMenu'
import '../../../src/renderer/src/index.css'
import '../../../src/renderer/src/components/GlobalSidebar/GlobalSidebar.css'

window.codeAwareness = {
  toggleDevTools: async () => ({ success: true }),
  getDevUpdateStatus: async () => ({
    available: true,
    branch: 'feat/dev-update',
    head: '132e49d0',
    supervisorConnected: true
  }),
  requestDevUpdate: async () => ({
    operationId: 'visual-fixture',
    status: 'ALREADY_CURRENT',
    head: '132e49d0',
    message: 'Fixture only'
  })
} as unknown as Window['codeAwareness']

document.body.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(
  <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-primary)' }}>
    <aside className="global-sidebar sidebar-open" style={{ position: 'relative', height: '100vh' }}>
      <div className="global-sidebar-header">
        <span className="global-sidebar-logo-title">Code Awareness</span>
      </div>
      <div className="global-sidebar-nav" />
      <div className="global-sidebar-footer">
        <DevelopmentMenu isSidebarOpen={true} />
      </div>
    </aside>
  </div>
)
