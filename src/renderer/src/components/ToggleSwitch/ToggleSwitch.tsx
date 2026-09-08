/*
-T ---
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
