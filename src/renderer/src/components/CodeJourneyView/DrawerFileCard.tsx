/*
-T ---
*/

import React from 'react'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import './DrawerFileCard.css'

const CHANGE_TYPE_LABEL: Record<'modified' | 'added' | 'deleted', string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D'
}

interface DrawerFileCardProps {
  name: string
  path: string
  changeType: 'modified' | 'added' | 'deleted'
  checked: boolean
  onToggle: () => void
}

/**
 * Card de arquivo com badge colorido, nome, caminho e toggle de seleção.
 * Separado por vão (gap) no container, não por divisória — produz o respiro da referência.
 */
export const DrawerFileCard: React.FC<DrawerFileCardProps> = ({
  name,
  path,
  changeType,
  checked,
  onToggle
}) => {
  return (
    <div className="dfc-card">
      <div className="dfc-top-row">
        <span className={`dfc-badge dfc-badge--${changeType}`}>
          {CHANGE_TYPE_LABEL[changeType]}
        </span>
        <span className="dfc-name" title={name}>{name}</span>
        <div className="dfc-toggle">
          <ToggleSwitch checked={checked} onChange={onToggle} />
        </div>
      </div>
      <div className="dfc-path" title={path}>{path}</div>
    </div>
  )
}

DrawerFileCard.displayName = 'DrawerFileCard'
