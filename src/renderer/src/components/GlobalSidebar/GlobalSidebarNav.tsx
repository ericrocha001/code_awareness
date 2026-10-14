/*
-T ---
*/

import React from 'react'
import { NavId, NavItem } from '../../config/navigation'

interface GlobalSidebarNavProps {
  items: NavItem[]
  activeTab: NavId
  onSelect: (id: NavId) => void
  isSidebarOpen: boolean
  orchestrationAlerts?: number
}

export const GlobalSidebarNav: React.FC<GlobalSidebarNavProps> = ({ items, activeTab, onSelect, isSidebarOpen, orchestrationAlerts = 0 }) => {
  return (
    <nav className="global-sidebar-nav" aria-label="Seções do produto">
      <ul className="global-sidebar-nav-list">
        {items.map((item) => {
          const LucideIconComponent = item.lucideIcon
          return (
            <li key={item.id}>
              <button
                className={`global-sidebar-nav-item ${activeTab === item.id ? 'active' : ''}`}
                onClick={() => onSelect(item.id)}
                aria-current={activeTab === item.id ? 'page' : undefined}
                title={isSidebarOpen ? '' : item.label}
                aria-label={item.id === 'work-orchestration' && orchestrationAlerts ? `${item.label}, ${orchestrationAlerts} novos alertas de interferência` : item.label}
              >
                <span className="global-sidebar-nav-icon" aria-hidden="true">
                  <LucideIconComponent size={18} strokeWidth={2} />
                </span>
                {isSidebarOpen && <span className="global-sidebar-nav-label">{item.label}</span>}
                {item.id === 'work-orchestration' && orchestrationAlerts > 0 && <span className="orchestration-alert-badge" aria-label={`${orchestrationAlerts} novos alertas de interferência`}>{orchestrationAlerts}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
