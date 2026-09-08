/*
-T ---
*/

import React from 'react'
import './DrawerFieldRow.css'

interface DrawerFieldRowProps {
  icon?: React.ReactNode
  label: string
  value: React.ReactNode
  accent?: boolean
}

/**
 * Linha de ficha: ícone + rótulo cinza à esquerda, valor à direita.
 * Usada para montar fichas de metadados (Status, Criado em, etc.).
 */
export const DrawerFieldRow: React.FC<DrawerFieldRowProps> = ({ icon, label, value, accent }) => {
  return (
    <div className="df-row">
      <span className="df-label">
        {icon && <span className="df-icon">{icon}</span>}
        {label}
      </span>
      <span className={`df-value${accent ? ' df-value--accent' : ''}`}>
        {value}
      </span>
    </div>
  )
}

DrawerFieldRow.displayName = 'DrawerFieldRow'
