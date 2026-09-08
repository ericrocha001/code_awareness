/*
-T ---
*/

import React from 'react'
import './ActionMenuItem.css'

interface ActionMenuItemProps {
  icon?: React.ReactNode
  children: React.ReactNode
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
}

export const ActionMenuItem: React.FC<ActionMenuItemProps> = ({
  icon,
  children,
  onClick,
  danger = false,
  disabled = false
}) => {
  return (
    <button
      type="button"
      className={`am-item${danger ? ' am-item--danger' : ''}`}
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
    >
      {icon && <span className="am-item-icon">{icon}</span>}
      <span className="am-item-label">{children}</span>
    </button>
  )
}

ActionMenuItem.displayName = 'ActionMenuItem'