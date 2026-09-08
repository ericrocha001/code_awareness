/*
-T ---
*/

import React, { forwardRef } from 'react'
import { ChevronDown } from 'lucide-react'
import './Button.css'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'pill' | 'ghost'
  icon?: React.ReactNode
  chevron?: boolean
  open?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'pill',
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
    const baseClass = `app-${variant}-btn`
    const combinedClass = `${baseClass}${className ? ` ${className}` : ''}`

    return (
      <button
        ref={ref}
        type={type}
        className={combinedClass}
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