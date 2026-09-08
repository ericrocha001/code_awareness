/*
-T ---
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