/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a Camada 1: faixa horizontal com SearchBox, summary, controlsSlot e filterSlot.
2. Organizar os slots de busca, sumário, controles e filtro sem gerenciar estado próprio.

Mapa de Relacionamentos do Script

1. ViewToolbar.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos com prefixo vt-.
   - Criticidade: Alta

2. SearchBox.tsx
   - Tipo: Dependência Direta
   - Relação: Instancia o SearchBox com as props de busca.
   - Criticidade: Alta

3. FilterPopover.tsx
   - Tipo: Dependência Direta (opcional)
   - Relação: Aceita FilterPopover como filterSlot, mas não o instancia.
   - Criticidade: Baixa

Invariantes do Script

1. Não gerenciar estado de busca nem de filtro — apenas repassar props.
2. O summary é um ReactNode opcional — não calcular contagem internamente.
3. O controlsSlot é opcional e renderizado apenas quando fornecido, entre summary e filterSlot.
4. Quando controlsSlot não é fornecido, o layout é idêntico ao anterior.

--- FIM ARQUITETURA DO SCRIPT ---
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
