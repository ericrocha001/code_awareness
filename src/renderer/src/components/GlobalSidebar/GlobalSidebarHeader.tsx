/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar o topo da GlobalSidebar com o logo/título.

Mapa de Relacionamentos do Script

1. GlobalSidebar.tsx
   - Tipo: Dependência Direta
   - Relação: Usa este bloco para compor a sidebar.
   - Criticidade: Alta

Invariantes do Script

1. O título é exibido apenas quando a sidebar está expandida.
2. O logo mantém identidade visual consistente com o tema.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'

interface GlobalSidebarHeaderProps {
  isSidebarOpen: boolean
}

export const GlobalSidebarHeader: React.FC<GlobalSidebarHeaderProps> = ({ isSidebarOpen }) => {
  return (
    <div className="global-sidebar-header">
      <span className="global-sidebar-logo-title-container">
        <img
          className="global-sidebar-logo-img"
          src="/logo.svg"
          alt="Code Awareness"
        />
      </span>
    </div>
  )
}
