import React, { forwardRef, useId } from 'react'
import { ChevronDown } from 'lucide-react'
import './SelectField.css'

interface SelectFieldProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label: string
  description?: string
  error?: string
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, description, error, id, className = '', children, 'aria-describedby': describedBy, ...rest }, ref
) {
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const descriptionId = `${fieldId}-description`
  const errorId = `${fieldId}-error`
  return <div className={`ui-select-field ${className}`}>
    <label htmlFor={fieldId}>{label}</label>
    <div className="ui-select-surface">
      <select {...rest} ref={ref} id={fieldId} aria-invalid={error ? true : rest['aria-invalid']}
        aria-describedby={[describedBy, description && descriptionId, error && errorId].filter(Boolean).join(' ') || undefined}>
        {children}
      </select>
      <ChevronDown size={18} aria-hidden="true" />
    </div>
    {description && <span id={descriptionId} className="ui-select-description">{description}</span>}
    {error && <span id={errorId} className="ui-select-error" role="alert">{error}</span>}
  </div>
})
