/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar campo de busca textual com ícone de lupa.
2. Emitir mudanças de texto via callback onChange, sem gerenciar estado próprio.

Mapa de Relacionamentos do Script

1. SearchBox.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos com prefixo sb-.
   - Criticidade: Alta

2. ViewToolbar.tsx
   - Tipo: Dependência Inversa
   - Relação: É instanciado pela ViewToolbar como slot de busca.
   - Criticidade: Alta

Invariantes do Script

1. Não gerenciar estado próprio — apenas repassar value/onChange.
2. Não saber o que está sendo buscado.
3. O input é controlado pelo pai via props.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { Search } from 'lucide-react'
import './SearchBox.css'

interface SearchBoxProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
}

export const SearchBox: React.FC<SearchBoxProps> = ({
  value,
  onChange,
  placeholder = 'Buscar...',
  ariaLabel = 'Buscar'
}) => {
  return (
    <div className="sb-root">
      <span className="sb-icon" aria-hidden="true">
        <Search size={16} strokeWidth={2} />
      </span>
      <input
        className="sb-input"
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </div>
  )
}