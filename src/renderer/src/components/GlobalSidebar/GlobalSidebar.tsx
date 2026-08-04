/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a barra lateral fixa com navegação entre abas.
2. Exibir o ProjectDropdown no topo e manter a navegação responsiva.

Mapa de Relacionamentos do Script

1. ProjectDropdown.tsx
   - Tipo: Dependência Direta
   - Relação: Renderizado dentro da sidebar para seleção de projeto.
   - Criticidade: Alta

2. App.tsx
   - Tipo: Dependência Inversa
   - Relação: Controla aba ativa, projeto ativo e estado da sidebar via hook e props.
   - Criticidade: Alta

3. ProjectDropdown.css e GlobalSidebar.css
   - Tipo: Relação de UI
   - Relação: Definem aparência, transições e layout.
   - Criticidade: Alta

Invariantes do Script

1. A largura da sidebar nunca deve quebrar o layout principal.
2. O estado colapsado/expandido deve ser refletido imediatamente na UI conforme recebido do App.tsx.
3. A navegação deve sempre refletir a aba ativa informada pelo App.tsx.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { GlobalSidebarHeader } from "./GlobalSidebarHeader";
import { GlobalSidebarProject } from "./GlobalSidebarProject";
import { GlobalSidebarNav } from "./GlobalSidebarNav";
import { GlobalSidebarFooter } from "./GlobalSidebarFooter";
import { NAV_ITEMS, Tab } from "../../config/navigation";
import "./GlobalSidebar.css";

interface GlobalSidebarProps {
  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  activeProject: { path: string; name: string } | null;
  onSelectProject: (project: { path: string; name: string } | null) => void;
  onOpenTags: () => void;
  onOpenIgnored: () => void;
}

export const GlobalSidebar: React.FC<GlobalSidebarProps> = ({
  isSidebarOpen,
  setIsSidebarOpen,
  activeTab,
  setActiveTab,
  activeProject,
  onSelectProject,
  onOpenTags,
  onOpenIgnored,
}) => {
  const toggleSidebar = () => setIsSidebarOpen(!isSidebarOpen);

  return (
    <aside
      className={`global-sidebar ${isSidebarOpen ? "sidebar-open" : "sidebar-closed"}`}
      role="navigation"
      aria-label="Navegação principal"
    >
      <GlobalSidebarHeader
        isSidebarOpen={isSidebarOpen}
      />
      <GlobalSidebarProject
        activeProject={activeProject}
        onSelectProject={onSelectProject}
      />
      <GlobalSidebarNav
        items={NAV_ITEMS}
        activeTab={activeTab}
        onSelect={setActiveTab}
        isSidebarOpen={isSidebarOpen}
      />
      <GlobalSidebarFooter 
        isSidebarOpen={isSidebarOpen}
        onToggle={toggleSidebar}
        onOpenTags={onOpenTags} 
        onOpenIgnored={onOpenIgnored} 
      />
    </aside>
  );
};