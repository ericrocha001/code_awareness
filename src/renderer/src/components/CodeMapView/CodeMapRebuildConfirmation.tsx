import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { DatabaseZap } from 'lucide-react'
import { Button } from '../shared/Button/Button'
import './IntegrityCheckModal.css'

interface CodeMapRebuildConfirmationProps {
  onCancel: () => void
  onConfirm: () => void
  returnFocusRef: React.RefObject<HTMLButtonElement>
}

export function CodeMapRebuildConfirmation({ onCancel, onConfirm, returnFocusRef }: CodeMapRebuildConfirmationProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  useEffect(() => {
    cancelRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancelRef.current()
      } else if (event.key === 'Tab') {
        event.preventDefault()
        const next = document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current
        next?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      returnFocusRef.current?.focus()
    }
  }, [returnFocusRef])

  return createPortal(
    <div className="icm-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }}>
      <section className="icm-modal cmh-confirmation" role="dialog" aria-modal="true"
        aria-labelledby="cmh-rebuild-title" aria-describedby="cmh-rebuild-description">
        <header className="icm-header">
          <div className="icm-header-title"><DatabaseZap size={23} /><h2 id="cmh-rebuild-title">Reconstruir o índice do CodeMap?</h2></div>
        </header>
        <div className="icm-body"><p id="cmh-rebuild-description">O índice estrutural será reconstruído completamente. A operação pode levar algum tempo, mas não altera os arquivos do repositório.</p></div>
        <footer className="icm-footer">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel}>Cancelar</Button>
          <Button ref={confirmRef} onClick={onConfirm} icon={<DatabaseZap size={16} />}>Reconstruir índice</Button>
        </footer>
      </section>
    </div>, document.body
  )
}
