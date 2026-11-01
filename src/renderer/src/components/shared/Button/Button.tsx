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
        {...rest}
      >
        {icon && <span className="btn-icon" aria-hidden="true">{icon}</span>}
        {children}
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
