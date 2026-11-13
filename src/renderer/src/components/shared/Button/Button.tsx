import React, { forwardRef } from 'react'
import { ChevronDown } from 'lucide-react'
import './Button.css'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'pill' | 'ghost' | 'solid' | 'outline' | 'subtle'
  intent?: 'primary' | 'neutral' | 'danger'
  size?: 'comfortable' | 'compact'
  iconOnly?: boolean
  selected?: boolean
  icon?: React.ReactNode
  chevron?: boolean
  open?: boolean
  busy?: boolean
  busyLabel?: string
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'pill',
      intent = 'neutral',
      size = 'comfortable',
      iconOnly = false,
      selected,
      icon,
      chevron = false,
      open = false,
      busy = false,
      busyLabel,
      onClick,
      children,
      type = 'button',
      className = '',
      ...rest
    },
    ref
  ) => {
    const modern = variant !== 'pill' && variant !== 'ghost'
    const baseClass = modern
      ? `ui-button ui-button--${variant} ui-button--${intent} ui-button--${size}${iconOnly ? ' ui-button--icon' : ''}`
      : `app-${variant}-btn`
    const combinedClass = `${baseClass}${className ? ` ${className}` : ''}`

    return (
      <button
        ref={ref}
        type={type}
        className={combinedClass}
        aria-pressed={selected}
        aria-busy={busy || undefined}
        aria-disabled={busy || undefined}
        data-busy={busy || undefined}
        {...rest}
        onClick={busy ? undefined : onClick}
      >
        {busy ? <span className="btn-spinner" aria-hidden="true" /> : icon && <span className="btn-icon" aria-hidden="true">{icon}</span>}
        {children}
        {busy && busyLabel && <span className="btn-busy-status" role="status">{busyLabel}</span>}
        {chevron && (
          <ChevronDown
            size={14}
            strokeWidth={2}
            className={`btn-chevron${open ? ' btn-chevron--open' : ''}`}
            aria-hidden="true"
          />
        )}
      </button>
    )
  }
)

Button.displayName = 'Button'
