/*
-T ---
*/

import React from 'react'
import { ProjectSwitcher } from '../ProjectSwitcher/ProjectSwitcher'

interface GlobalSidebarProjectProps {
  activeProject: { path: string; name: string } | null
  selectionLocked?: boolean
  onSelectRepository: (repositoryId: string) => void
}

export const GlobalSidebarProject: React.FC<GlobalSidebarProjectProps> = ({
  activeProject,
  selectionLocked,
  onSelectRepository
}) => {
  return (
    <div className="global-sidebar-project">
      <ProjectSwitcher
        disabled={selectionLocked}
        activeProject={activeProject}
        onSelectRepository={onSelectRepository}
      />
    </div>
  )
}
