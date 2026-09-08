/*
-T ---
*/

import React from 'react'
import { FileText } from 'lucide-react'
import './BlueprintBar.css'

interface BlueprintBarProps {
  instructions?: string
  agentSummary?: string
}

/**
 * Indicador de dois segmentos que mostra, de forma imediata, se uma
 * implementação possui Instrução e Resultado preenchidos. Componente puro
 * com React.memo: apenas lê os metadados e renderiza o estado visual.
 */
export const BlueprintBar: React.FC<BlueprintBarProps> = React.memo(({ instructions, agentSummary }) => {
  const hasInstructions = (instructions ?? '').trim().length > 0
  const hasAgentSummary = (agentSummary ?? '').trim().length > 0

  // Rótulo descritivo: comunica claramente o estado de cada campo
  const label = `Blueprint: Instrução ${hasInstructions ? 'preenchida' : 'vazia'}, Resultado ${hasAgentSummary ? 'preenchido' : 'vazio'}`

  return (
    <div
      className="bpb-bar"
      role="img"
      aria-label={label}
      title={label}
    >
      <FileText
        className="bpb-icon"
        size={12}
        aria-hidden="true"
      />
      <span className={`bpb-segment${hasInstructions ? ' filled' : ''}`} aria-hidden="true" />
      <span className={`bpb-segment${hasAgentSummary ? ' filled' : ''}`} aria-hidden="true" />
    </div>
  )
})

BlueprintBar.displayName = 'BlueprintBar'