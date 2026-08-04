/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a navegação principal da sidebar.
2. Aplicar estados visuais de aba ativa e tooltips no modo colapsado.

Mapa de Relacionamentos do Script

1. GlobalSidebar.tsx
   - Tipo: Dependência Direta
   - Criticidade: Alta

Invariantes do Script

1. A aba ativa deve sempre estar visualmente destacada.
2. Os tooltips devem aparecer apenas quando a sidebar está fechada.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { NavId, NavItem } from '../../config/navigation'

interface GlobalSidebarNavProps {
  items: NavItem[]
  activeTab: NavId
  onSelect: (id: NavId) => void
  isSidebarOpen: boolean
}

export const GlobalSidebarNav: React.FC<GlobalSidebarNavProps> = ({ items, activeTab, onSelect, isSidebarOpen }) => {
  return (
    <nav aria-label="Navegação principal">
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
              >
                <span className="global-sidebar-nav-icon" aria-hidden="true">
                  <LucideIconComponent size={18} strokeWidth={2} />
                </span>
                {isSidebarOpen && <span className="global-sidebar-nav-label">{item.label}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
