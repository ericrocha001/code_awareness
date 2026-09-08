/*
-T ---
*/

import React, { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import './Popover.css'

export type PopoverPlacement =
  | 'top-start'
  | 'top-end'
  | 'bottom-start'
  | 'bottom-end'
  | 'auto-start'
  | 'auto-end'

interface PopoverProps {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  children: React.ReactNode
  placement?: PopoverPlacement
  offset?: number
}

const MARGIN = 8

const MANAGED_NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])

export const Popover: React.FC<PopoverProps> = ({
  open,
  anchorRef,
  onClose,
  children,
  placement = 'auto-start',
  offset = 8
}) => {
  const popoverRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [coords, setCoords] = useState<Coords>(null)
  const [measured, setMeasured] = useState(false)

  // --- Medição de geometria (síncrona, antes da pintura) ---
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setMeasured(false)
      setCoords(null)
      return
    }

    const anchor = anchorRef.current
    const popoverEl = popoverRef.current
    if (!popoverEl) return

    const anchorRect = anchor.getBoundingClientRect()
    const popoverRect = popoverEl.getBoundingClientRect()

    const windowWidth = window.innerWidth
    const windowHeight = window.innerHeight

    // Determinar lado vertical
    const spaceBelow = windowHeight - anchorRect.bottom
    const spaceAbove = anchorRect.top

    let vertical: 'top' | 'bottom'
    if (placement.startsWith('auto')) {
      vertical = spaceBelow >= spaceAbove ? 'bottom' : 'top'
    } else {
      vertical = placement.startsWith('top') ? 'top' : 'bottom'
    }

    // Alinhamento horizontal
    const alignEnd = placement.endsWith('end')
    const baloonW = popoverRect.width
    const baloonH = popoverRect.height

    let left: number
    if (alignEnd) {
      left = anchorRect.right - baloonW
    } else {
      left = anchorRect.left
    }

    let top: number
    if (vertical === 'bottom') {
      top = anchorRect.bottom + offset
    } else {
      top = anchorRect.top - offset - baloonH
    }

    // Clamp nas quatro bordas
    left = Math.max(MARGIN, Math.min(left, windowWidth - baloonW - MARGIN))
    top = Math.max(MARGIN, Math.min(top, windowHeight - baloonH - MARGIN))

    setCoords({ top, left })
    setMeasured(true)
  }, [open, placement, offset, anchorRef])

  // --- Ouvintes de fechamento e guarda de teclado ---
  useEffect(() => {
    if (!open) return

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      const inBaloon = popoverRef.current?.contains(target)
      const inAnchor = anchorRef.current?.contains(target)

      if (!inBaloon && !inAnchor) {
        onCloseRef.current()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
      }
    }

    // Guarda de teclado em fase de captura: suprime rolagem nativa de navegação externa
    const handleKeyDownCapture = (e: KeyboardEvent) => {
      if (!MANAGED_NAV_KEYS.has(e.key)) return

      const target = e.target as Node
      const inBaloon = popoverRef.current?.contains(target)

      if (!inBaloon) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    const handleScroll = (e: Event) => {
      // Ignorar scrolls originados dentro do próprio popover (ex.: lista rolável de tags)
      const target = e.target as Node
      if (popoverRef.current?.contains(target)) return
      onCloseRef.current()
    }

    const handleResize = () => {
      onCloseRef.current()
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('keydown', handleKeyDownCapture, { capture: true })
    document.addEventListener('scroll', handleScroll, { capture: true })
    window.addEventListener('resize', handleResize)

    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('keydown', handleKeyDownCapture, { capture: true })
      document.removeEventListener('scroll', handleScroll, { capture: true })
      window.removeEventListener('resize', handleResize)
    }
  }, [open, anchorRef])

  // Sem hooks condicionais — apenas retorno condicional
  if (!open) return null

  return createPortal(
    <div
      ref={popoverRef}
      className={`pop-root${!measured ? ' pop-hidden' : ''}`}
      style={
        coords
          ? { top: coords.top, left: coords.left }
          : undefined
      }
    >
      {children}
    </div>,
    document.body
  )
}