/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Exibir visualmente o nível de importância arquitetural de um arquivo (critical, high, medium, low).
2. Permitir override manual da classificação via dropdown interativo.
3. Indicar visualmente quando a classificação foi definida manualmente pelo usuário.

Mapa de Relacionamentos do Script

1. shared/types.ts
   - Tipo: Dependência Direta
   - Relação: Consome os tipos ImportanceLevel e ImportanceSource para tipagem das props.
   - Criticidade: Alta

2. CodeCompressionView.tsx (futuro)
   - Tipo: Fluxo de Dados
   - Relação: Será renderizado na sidebar para cada arquivo tracked.
   - Criticidade: Alta

3. CodeSourceView.tsx (futuro)
   - Tipo: Fluxo de Dados
   - Relação: Será renderizado na sidebar para cada arquivo tracked.
   - Criticidade: Alta

Invariantes do Script

1. O componente deve ser puramente visual — não faz chamadas IPC diretamente.
2. O dropdown deve fechar ao clicar fora do componente.
3. Se onChange não for fornecido, o badge não deve ser clicável.
4. O ícone de edição (✏️) só deve aparecer se source === 'manual'.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useRef, useEffect } from 'react'
import { ImportanceLevel, ImportanceSource } from '../../../../shared/types'
import './ImportanceBadge.css'

interface ImportanceBadgeProps {
  level: ImportanceLevel
  source: ImportanceSource
  onChange?: (newLevel: ImportanceLevel) => void
}

// Mapeamento estático de cada nível para sua configuração visual
const LEVEL_CONFIG = {
  critical: { emoji: '🔴', label: 'Crítico', className: 'badge-critical' },
  high: { emoji: '🟠', label: 'Alto', className: 'badge-high' },
  medium: { emoji: '🟡', label: 'Médio', className: 'badge-medium' },
  low: { emoji: '⚪', label: 'Baixo', className: 'badge-low' }
}

export const ImportanceBadge: React.FC<ImportanceBadgeProps> = ({ level, source, onChange }) => {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Fecha o dropdown ao clicar fora do componente
  useEffect(() => {
    if (!isDropdownOpen) return
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isDropdownOpen])

  const config = LEVEL_CONFIG[level]

  // Só abre o dropdown se onChange foi fornecido (badge interativo)
  const handleClick = () => {
    if (onChange) setIsDropdownOpen((prev) => !prev)
  }

  // Chama onChange com o novo nível e fecha o dropdown
  const handleLevelChange = (newLevel: ImportanceLevel) => {
    if (onChange) {
      onChange(newLevel)
      setIsDropdownOpen(false)
    }
  }

  return (
    <div className="importance-badge-wrapper" ref={dropdownRef}>
      {/* Badge principal */}
      <div
        className={`importance-badge ${config.className} ${onChange ? 'clickable' : ''}`}
        onClick={handleClick}
        title={source === 'manual' ? 'Classificado manualmente' : 'Classificado automaticamente'}
      >
        <span className="badge-emoji">{config.emoji}</span>
        <span className="badge-label">{config.label}</span>
        {/* Ícone de edição aparece apenas quando a classificação é manual */}
        {source === 'manual' && <span className="badge-manual-icon">✏️</span>}
      </div>

      {/* Dropdown com as 4 opções de nível — só renderizado quando aberto e onChange existe */}
      {isDropdownOpen && onChange && (
        <div className="importance-dropdown">
          {(Object.keys(LEVEL_CONFIG) as ImportanceLevel[]).map((lvl) => {
            const lvlConfig = LEVEL_CONFIG[lvl]
            return (
              <div
                key={lvl}
                className={`importance-dropdown-item ${lvlConfig.className}`}
                onClick={() => handleLevelChange(lvl)}
              >
                <span className="badge-emoji">{lvlConfig.emoji}</span>
                <span className="badge-label">{lvlConfig.label}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
