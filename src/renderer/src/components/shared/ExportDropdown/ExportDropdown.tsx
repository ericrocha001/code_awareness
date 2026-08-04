/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar botão de pílula com menu suspenso genérico para exportação.
2. Gerenciar abertura/fechamento interno (clique fora, ESC, closeOnSelect).
3. Renderizar children como conteúdo do menu sem saber o que são as opções.

Mapa de Relacionamentos do Script

1. ExportDropdown.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos com prefixo ed-.
   - Criticidade: Alta

2. ChevronDown (lucide-react)
   - Tipo: Dependência Direta
   - Relação: Ícone que gira 180° quando o menu está aberto.
   - Criticidade: Baixa

3. Consumidores futuros (CodeSourceView, CodeCompressionView)
   - Tipo: Dependência Inversa
   - Relação: Fornecem as opções como children.
   - Criticidade: Alta

Invariantes do Script

1. Fecha ao clicar fora do invólucro (ouvinte mousedown no documento).
2. Fecha ao pressionar ESC.
3. Se closeOnSelect, fecha ao clicar dentro do menu (qualquer clique no children).
4. O componente não conhece o conteúdo das opções — apenas renderiza e gerencia o menu.
5. Todo ouvinte é removido na limpeza do efeito.
6. Prefixo CSS ed-.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import './ExportDropdown.css'

interface ExportDropdownProps {
  label?: string
  disabled?: boolean
  children: React.ReactNode
  closeOnSelect?: boolean
  className?: string
}

export const ExportDropdown: React.FC<ExportDropdownProps> = ({
  label = 'Exportar',
  disabled = false,
  children,
  closeOnSelect = true,
  className = ''
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const handleToggle = useCallback(() => {
    if (!disabled) setIsOpen(prev => !prev)
  }, [disabled])

  const handleClose = useCallback(() => {
    setIsOpen(false)
  }, [])

  // Fecha ao clicar fora
  useEffect(() => {
    if (!isOpen) return

    const handleMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        handleClose()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose()
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, handleClose])

  const handleMenuClick = useCallback(() => {
    if (closeOnSelect) {
      handleClose()
    }
  }, [closeOnSelect, handleClose])

  return (
    <div className={`ed-wrapper${className ? ` ${className}` : ''}`} ref={wrapperRef}>
      <button
        className={`app-pill-btn ed-btn`}
        onClick={handleToggle}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={isOpen}
      >
        <span>{label}</span>
        <ChevronDown size={14} strokeWidth={2} className={`ed-caret${isOpen ? ' open' : ''}`} />
      </button>

      {isOpen && (
        <div className="ed-menu" onClick={handleMenuClick} role="menu" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  )
}