/*
-T ---
*/

import React from 'react'
import './ActionBar.css'

interface ActionBarProps {
  left?: React.ReactNode
  right: React.ReactNode
  className?: string
}

export const ActionBar: React.FC<ActionBarProps> = ({
  left,
  right,
  className = ''
}) => {
  return (
    <div className={`ab-root${className ? ` ${className}` : ''}`}>
      <div className="ab-left">
        {left}
      </div>
      <div className="ab-right">
        {right}
      </div>
    </div>
  )
}