import React, { useEffect, useId, useRef, useState } from 'react'
import { Button } from '../Button/Button'
import { Popover } from '../Popover/Popover'
import './ContextHelp.css'

interface ContextHelpProps {
  label: string
  hint?: string
  children: React.ReactNode
}

export function ContextHelp({ label, hint, children }: ContextHelpProps) {
  const id = useId()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState(false)
  const close = () => { setOpen(false); setPreview(false) }

  useEffect(() => {
    if (!open) return
    // Popover measures while hidden; focus only after its positioned frame is visible.
    const frame = requestAnimationFrame(() => panelRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  return <>
    <Button ref={anchorRef} variant="subtle" iconOnly aria-label={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-describedby={!open && preview && hint ? `${id}-hint` : undefined}
      onMouseEnter={() => setPreview(true)} onMouseLeave={() => setPreview(false)}
      onFocus={() => setPreview(true)} onBlur={() => setPreview(false)}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}
      onClick={() => { setOpen(value => !value); setPreview(false) }}>
      <span aria-hidden="true">i</span>
    </Button>
    <Popover open={open || Boolean(preview && hint)} anchorRef={anchorRef} onClose={close} guardNavigation={false}>
      {open ? <div ref={panelRef} id={id} className="ui-context-help" role="dialog" aria-label={label} tabIndex={-1}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
            anchorRef.current?.focus()
          }
        }}
        onBlur={event => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== anchorRef.current) close()
        }}>
        <strong>{label}</strong>
        <div className="ui-context-help-content">{children}</div>
        <Button variant="subtle" size="compact" onClick={() => { close(); anchorRef.current?.focus() }}>Fechar ajuda</Button>
      </div> : <div id={`${id}-hint`} className="ui-context-help" role="tooltip">{hint}</div>}
    </Popover>
  </>
}
