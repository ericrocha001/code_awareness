/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar um dropdown unificado de ações globais no topo da sidebar (Varrer Mesa, Selecionar Críticos/Altos e alternar ordenação).
2. Gerenciar o estado de abertura/fechamento do dropdown, fechando automaticamente ao clicar fora ou selecionar uma ação.
3. Exibir e alternar modos de ordenação (importância vs recência) na aba Code Diff.

Mapa de Relacionamentos do Script

1. SidebarActions.css
   - Tipo: Relação de UI
   - Relação: Consome estilos CSS do componente.
   - Criticidade: Alta

2. CodeSourceView.tsx
   - Tipo: Relação de UI
   - Relação: Renderizado no cabeçalho da sidebar da aba Code Source.
   - Criticidade: Alta

3. CodeCompressionView.tsx
   - Tipo: Relação de UI
   - Relação: Renderizado no cabeçalho da sidebar da aba Code Compression.
   - Criticidade: Alta

4. CodeDiffView.tsx
   - Tipo: Relação de UI
   - Relação: Renderizado no cabeçalho da sidebar da aba Code Diff, fornecendo as props de ordenação.
   - Criticidade: Alta

Invariantes do Script

1. O dropdown deve fechar automaticamente quando o usuário clicar fora dele ou selecionar uma ação.
2. Os itens do dropdown devem aparecer apenas se suas respectivas condições forem atendidas (ex.: hasNoiseFiles, hasImportanceData).
3. O indicador de classificação (⏳) nunca deve aparecer junto com as ações — apenas substitui o botão durante classificação.
4. Os botões de ordenação por importância e recência só devem ser renderizados quando sortMode e onSortModeChange forem definidos.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useRef, useEffect } from 'react'
import './SidebarActions.css'

interface SidebarActionsProps {
  // Ação de varrer ruídos
  onSweepNoise?: () => void
  hasNoiseFiles: boolean

  // Ação de selecionar críticos e altos
  onSelectCriticalAndHigh?: () => void
  hasImportanceData: boolean

  // Estado de classificação (mostra indicador ⏳)
  isClassifying?: boolean

  // Prefixo de classe para diferenciar entre views (cs, cdf)
  classPrefix: 'cs' | 'cdf'

  // Novas props para toggle de ordenação (apenas Code Diff)
  sortMode?: 'importance' | 'recent'
  onSortModeChange?: (mode: 'importance' | 'recent') => void
}

/**
 * Dropdown unificado de ações no topo da sidebar.
 * Substitui os botões individuais de "Varrer Mesa" e "🎯 Selecionar Críticos",
 * consolidando todas as ações em um único botão "Ações" com menu dropdown.
 */
export const SidebarActions: React.FC<SidebarActionsProps> = ({
  onSweepNoise,
  hasNoiseFiles,
  onSelectCriticalAndHigh,
  hasImportanceData,
  isClassifying,
  classPrefix,
  sortMode,
  onSortModeChange
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Fecha o dropdown ao detectar clique externo
  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const toggleDropdown = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsOpen((prev) => !prev)
  }

  const handleAction = (action: () => void) => {
    action()
    setIsOpen(false)
  }

  // Durante classificação, mostra apenas o indicador ⏳
  if (isClassifying) {
    return <span className={`${classPrefix}-icon-btn`} style={{ cursor: 'default' }}>⏳</span>
  }

  // Se não há ações disponíveis, não renderiza nada
  const hasActions = hasNoiseFiles || hasImportanceData || sortMode !== undefined
  if (!hasActions) return null

  return (
    <div className="sidebar-actions-wrapper" ref={dropdownRef}>
      <button
        className="sidebar-actions-btn"
        onClick={toggleDropdown}
        title="Ações da sidebar"
        aria-label="Ações da sidebar"
        aria-expanded={isOpen}
      >
        <span>Ações</span>
        <span className="sidebar-actions-icon">⋮</span>
      </button>

      {isOpen && (
        <div className="sidebar-actions-menu">
          {/* Varrer Mesa — aparece apenas quando há arquivos de ruído */}
          {hasNoiseFiles && onSweepNoise && (
            <button onClick={() => handleAction(onSweepNoise)}>
              <span className="sidebar-action-emoji">🧹</span>
              <span>Varrer Mesa</span>
            </button>
          )}

          {/* Separador quando ambas as ações estão visíveis */}
          {hasNoiseFiles && hasImportanceData && (
            <div className="sidebar-actions-divider" />
          )}

          {/* Selecionar Críticos e Altos — aparece apenas quando há dados de importância */}
          {hasImportanceData && onSelectCriticalAndHigh && (
            <button onClick={() => handleAction(onSelectCriticalAndHigh)}>
              <span className="sidebar-action-emoji">🎯</span>
              <span>Selecionar Críticos e Altos</span>
            </button>
          )}

          {/* Separador antes do toggle de ordenação */}
          {(hasNoiseFiles || hasImportanceData) && sortMode !== undefined && (
            <div className="sidebar-actions-divider" />
          )}

          {/* Toggle de ordenação (apenas Code Diff) */}
          {sortMode !== undefined && onSortModeChange && (
            <>
              <button
                onClick={() => handleAction(() => onSortModeChange('importance'))}
                style={{
                  background: sortMode === 'importance' ? 'rgba(124, 58, 237, 0.15)' : 'transparent',
                  fontWeight: sortMode === 'importance' ? '600' : '400'
                }}
              >
                <span className="sidebar-action-emoji">🎯</span>
                <span>Ordenar por Importância</span>
              </button>
              <button
                onClick={() => handleAction(() => onSortModeChange('recent'))}
                style={{
                  background: sortMode === 'recent' ? 'rgba(124, 58, 237, 0.15)' : 'transparent',
                  fontWeight: sortMode === 'recent' ? '600' : '400'
                }}
              >
                <span className="sidebar-action-emoji">🕐</span>
                <span>Ordenar por Recência</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
