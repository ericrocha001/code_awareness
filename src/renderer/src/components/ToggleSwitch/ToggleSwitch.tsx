/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar um componente ToggleSwitch acessível e reutilizável.
2. Gerenciar interações de teclado (Espaço/Enter) e cliques para alternar o estado do switch.

Mapa de Relacionamentos do Script

1. CodeCompressionView.tsx
   - Tipo: Fluxo de Dados
   - Relação: Usado como controle de seleção no lugar de checkboxes tradicionais.
   - Criticidade: Média

2. CodeSourceView.tsx
   - Tipo: Fluxo de Dados
   - Relação: Usado como controle de seleção no lugar de checkboxes tradicionais.
   - Criticidade: Média

Invariantes do Script

1. O componente deve suportar navegação por teclado (foco por Tab, alteração por Space/Enter).
2. Transições visuais de ativação/desativação devem ser fluidas.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import './ToggleSwitch.css'

interface ToggleSwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  indeterminate?: boolean
}

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({ checked, onChange, disabled = false, indeterminate = false }) => {
  const handleToggle = () => {
    if (!disabled) {
      onChange(!checked)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      onChange(!checked)
    }
  }

  const state = indeterminate ? 'indeterminate' : checked ? 'checked' : ''

  return (
    <div
      className={`toggle-switch-container ${state} ${disabled ? 'disabled' : ''}`}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      tabIndex={disabled ? -1 : 0}
      role="switch"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-disabled={disabled}
    >
      <div className="toggle-switch-thumb" />
    </div>
  )
}
