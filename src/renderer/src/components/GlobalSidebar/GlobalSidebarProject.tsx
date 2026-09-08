/*
-T ---
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