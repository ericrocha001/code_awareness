/*
-T ---
*/

import React from 'react'
import { ProjectSwitcher } from '../ProjectSwitcher/ProjectSwitcher'

interface GlobalSidebarProjectProps {
  activeProject: { path: string; name: string } | null
  onSelectRepository: (repositoryId: string) => void
}

export const GlobalSidebarProject: React.FC<GlobalSidebarProjectProps> = ({
  activeProject,
  onSelectRepository
}) => {
  return (
    <div className="global-sidebar-project">
      <ProjectSwitcher
        activeProject={activeProject}
        onSelectRepository={onSelectRepository}
      />
    </div>
  )
}
