/*
-T ---
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
        {isSidebarOpen && <span className="global-sidebar-logo-title">Code Awareness</span>}
      </span>
    </div>
  )
}
