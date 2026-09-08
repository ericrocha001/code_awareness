/*
-T ---
*/

import React, { useState, useRef, useEffect } from 'react'
import { Popover, type PopoverPlacement } from '../Popover/Popover'
import { Button } from '../Button/Button'
import './ActionMenu.css'

interface ActionMenuProps {
  icon: React.ReactNode
  label: React.ReactNode
  children: React.ReactNode
  disabled?: boolean
  placement?: PopoverPlacement
  closeOnSelect?: boolean
  className?: string
  variant?: 'pill' | 'ghost'
}

export const ActionMenu: React.FC<ActionMenuProps> = ({
  icon,
  label,
  children,
  disabled = false,
  placement = 'auto-start',
  closeOnSelect = true,
  className = '',
  variant = 'pill'
}) => {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const handleToggle = () => {
    if (!disabled) setOpen(prev => !prev)
  }

  // ESC em captura: impede que o ESC feche o drawer junto com o menu
  useEffect(() => {
    if (!open) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handleEsc, true)
    return () => document.removeEventListener('keydown', handleEsc, true)
  }, [open])

  return (
    <>
      <Button
        ref={buttonRef}
        variant={variant}
        icon={icon}
        chevron
        open={open}
        onClick={handleToggle}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        className={className}
      >
        {label}
      </Button>

      <Popover
        open={open}
        anchorRef={buttonRef}
        onClose={() => setOpen(false)}
        placement={placement}
      >
        <div className="am-menu" role="menu" onClick={closeOnSelect ? () => setOpen(false) : undefined}>
          {children}
        </div>
      </Popover>
    </>
  )
}

ActionMenu.displayName = 'ActionMenu'