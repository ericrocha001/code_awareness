/*
-T ---
*/

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import './ExportDropdown.css'

interface ExportDropdownProps {
  label?: string
  disabled?: boolean
  children: React.ReactNode
  closeOnSelect?: boolean
  className?: string
}

export const ExportDropdown: React.FC<ExportDropdownProps> = ({
  label = 'Exportar',
  disabled = false,
  children,
  closeOnSelect = true,
  className = ''
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const handleToggle = useCallback(() => {
    if (!disabled) setIsOpen(prev => !prev)
  }, [disabled])

  const handleClose = useCallback(() => {
    setIsOpen(false)
  }, [])

  // Fecha ao clicar fora
  useEffect(() => {
    if (!isOpen) return

    const handleMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        handleClose()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose()
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, handleClose])

  const handleMenuClick = useCallback(() => {
    if (closeOnSelect) {
      handleClose()
    }
  }, [closeOnSelect, handleClose])

  return (
    <div className={`ed-wrapper${className ? ` ${className}` : ''}`} ref={wrapperRef}>
      <button
        className={`app-pill-btn ed-btn`}
        onClick={handleToggle}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={isOpen}
      >
        <span>{label}</span>
        <ChevronDown size={14} strokeWidth={2} className={`ed-caret${isOpen ? ' open' : ''}`} />
      </button>

      {isOpen && (
        <div className="ed-menu" onClick={handleMenuClick} role="menu" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  )
}