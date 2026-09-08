/*
-T ---
*/

import React, { useCallback, useEffect, useRef, useState } from 'react'
import './ColumnResizer.css'

interface ColumnResizerProps {
  /** Chamado a cada frame durante o arraste com o delta em pixels desde o último evento. */
  onDrag: (deltaPx: number) => void
  /** Chamado quando o botão do mouse é solto. Opcional — omitir quando não há ação no fim do arraste. */
  onDragEnd?: () => void
}

export const ColumnResizer: React.FC<ColumnResizerProps> = ({ onDrag, onDragEnd }) => {
  const [isDragging, setIsDragging] = useState(false)
  // Posição X do último evento de mouse — usada para calcular o delta frame a frame
  const lastXRef = useRef<number>(0)
  // Sprint 9: acumula deltas entre frames para coalescência por rAF
  const pendingDelta = useRef(0)
  const rafId = useRef<number | null>(null)

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const delta = e.clientX - lastXRef.current
      lastXRef.current = e.clientX
      pendingDelta.current += delta
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(() => {
          onDrag(pendingDelta.current)
          pendingDelta.current = 0
          rafId.current = null
        })
      }
    },
    [onDrag]
  )

  const handleMouseUp = useCallback(() => {
    // Flush: cancela rAF pendente e aplica delta acumulado diretamente
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current)
      rafId.current = null
    }
    if (pendingDelta.current !== 0) {
      onDrag(pendingDelta.current)
      pendingDelta.current = 0
    }
    setIsDragging(false)
    document.body.classList.remove('crs-dragging')
    onDragEnd?.()
  }, [onDrag, onDragEnd])

  // Registra e remove listeners no document durante o arraste
  useEffect(() => {
    if (!isDragging) return

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      // Sprint 9: cancela rAF pendente ao remover os listeners
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current)
        rafId.current = null
      }
    }
  }, [isDragging, handleMouseMove, handleMouseUp])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Apenas botão principal (esquerdo)
    if (e.button !== 0) return
    e.preventDefault()
    lastXRef.current = e.clientX
    setIsDragging(true)
    document.body.classList.add('crs-dragging')
  }, [])

  return (
    <div
      className={`crs-root${isDragging ? ' crs-root--dragging' : ''}`}
      onMouseDown={handleMouseDown}
      aria-hidden="true"
    >
      <div className="crs-line" />
    </div>
  )
}
