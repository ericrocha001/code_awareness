/*
-T ---
*/

import React, { useState, useRef, useCallback } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '../Button/Button'
import { Popover } from '../Popover/Popover'
import './FilterPopover.css'

interface FilterPopoverProps {
  activeCount: number
  children: React.ReactNode
  label?: string
  closeOnSelect?: boolean
}

export const FilterPopover: React.FC<FilterPopoverProps> = ({
  activeCount,
  children,
  label = 'Filtros',
  closeOnSelect = false
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)

  const handleClose = useCallback(() => {
    setIsOpen(false)
  }, [])

  const handleToggle = useCallback(() => {
    setIsOpen(prev => !prev)
  }, [])

  return (
    <>
      <Button
        variant="ghost"
        icon={<SlidersHorizontal size={16} strokeWidth={2} />}
        ref={anchorRef}
        onClick={handleToggle}
        aria-expanded={isOpen}
        aria-haspopup="true"
        aria-label={`${label}${activeCount > 0 ? ` (${activeCount} ativo${activeCount !== 1 ? 's' : ''})` : ''}`}
        className="fp-trigger"
      >
        {label}
        {activeCount > 0 && (
          <span className="fp-badge">{activeCount}</span>
        )}
      </Button>

      <Popover
        open={isOpen}
        anchorRef={anchorRef}
        onClose={handleClose}
        placement="auto-start"
      >
        <div className="am-menu" role="menu" aria-label={label} onClick={closeOnSelect ? handleClose : undefined}>
          {children}
        </div>
      </Popover>
    </>
  )
}