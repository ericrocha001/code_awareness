/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a área de seleção de projeto dentro da GlobalSidebar.

Mapa de Relacionamentos do Script

1. GlobalSidebar.tsx
   - Tipo: Dependência Direta
   - Relação: Usa este bloco para compor a sidebar.
   - Criticidade: Alta

2. ProjectDropdown.tsx
   - Tipo: Dependência Direta
   - Relação: Componente de dropdown de projetos.
   - Criticidade: Alta

Invariantes do Script

1. Não deve modificar comportamentos do ProjectDropdown original.
2. Deve manter responsividade e acessibilidade herdadas.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { ProjectDropdown } from '../ProjectDropdown/ProjectDropdown'

interface GlobalSidebarProjectProps {
  activeProject: { path: string; name: string } | null
  onSelectProject: (project: { path: string; name: string } | null) => void
}

export const GlobalSidebarProject: React.FC<GlobalSidebarProjectProps> = ({
  activeProject,
  onSelectProject
}) => {
  return (
    <div className="global-sidebar-project">
      <ProjectDropdown
        activeProject={activeProject}
        onSelectProject={onSelectProject}
      />
    </div>
  )
}