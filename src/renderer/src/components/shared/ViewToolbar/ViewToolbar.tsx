/*
-T ---
*/

import React from 'react'
import { SearchBox } from '../SearchBox/SearchBox'
import './ViewToolbar.css'

interface ViewToolbarProps {
  searchValue: string
  onSearchChange: (value: string) => void
  searchPlaceholder?: string
  searchRef?: React.Ref<HTMLInputElement>
  summary?: React.ReactNode
  controlsSlot?: React.ReactNode
  filterSlot?: React.ReactNode
}

export const ViewToolbar: React.FC<ViewToolbarProps> = ({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Buscar...',
  searchRef,
  summary,
  controlsSlot,
  filterSlot
}) => {
  return (
    <div className="vt-root">
      <div className="vt-search-slot">
        <SearchBox
          ref={searchRef}
          value={searchValue}
          onChange={onSearchChange}
          placeholder={searchPlaceholder}
          ariaLabel="Buscar"
        />
      </div>
      {summary && <div className="vt-summary">{summary}</div>}
      {controlsSlot && <div className="vt-controls-slot">{controlsSlot}</div>}
      {filterSlot && <div className="vt-filter-slot">{filterSlot}</div>}
    </div>
  )
}
