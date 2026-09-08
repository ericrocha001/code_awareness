/*
-T ---
*/

import React, { forwardRef } from 'react'
import { Search } from 'lucide-react'
import './SearchBox.css'

interface SearchBoxProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
}

export const SearchBox = forwardRef<HTMLInputElement, SearchBoxProps>(({
  value,
  onChange,
  placeholder = 'Buscar...',
  ariaLabel = 'Buscar'
}, ref) => {
  return (
    <div className="sb-root">
      <span className="sb-icon" aria-hidden="true">
        <Search size={16} strokeWidth={2} />
      </span>
      <input
        ref={ref}
        className="sb-input"
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </div>
  )
})

SearchBox.displayName = 'SearchBox'