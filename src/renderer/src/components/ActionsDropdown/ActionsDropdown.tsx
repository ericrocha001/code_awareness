/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar um dropdown de ações para arquivos da sidebar (ocultar, copiar, revelar no sistema).
2. Gerenciar o estado de abertura/fechamento do dropdown, fechando ao clicar fora.

Mapa de Relacionamentos do Script

1. CodeCompressionView.tsx
   - Tipo: Relação de UI
   - Relação: Renderizado como botão de controle para cada arquivo listado na sidebar.
   - Criticidade: Alta

2. CodeSourceView.tsx
   - Tipo: Relação de UI
   - Relação: Renderizado como botão de controle para cada arquivo listado na sidebar.
   - Criticidade: Alta

Invariantes do Script

1. O dropdown deve fechar automaticamente quando o usuário clicar fora dele ou selecionar uma ação.
2. O posicionamento do dropdown deve ser fixo ou absoluto ancorado ao botão "Ações".

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useRef, useEffect } from 'react'
import { EyeOff, FolderOpen, Copy, FileText, Search, FileDiff } from 'lucide-react'
import './ActionsDropdown.css'

interface ActionsDropdownProps {
  relativePath: string
  onHideFile: (relativePath: string) => void
  onHideExtension: (extension: string) => void
  onCopyPath: (relativePath: string) => void
  onCopyName: (name: string) => void
  onRevealInExplorer: (relativePath: string) => void
  onCopySingleFileDiff?: (relativePath: string, e: React.MouseEvent) => void
  copiedFile?: string | null
}

export const ActionsDropdown: React.FC<ActionsDropdownProps> = ({
  relativePath,
  onHideFile,
  onHideExtension,
  onCopyPath,
  onCopyName,
  onRevealInExplorer,
  onCopySingleFileDiff,
  copiedFile
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

  // Extrai nome do arquivo e sua extensão
  const filename = relativePath.split(/[/\\]/).pop() || relativePath
  const dotIndex = filename.lastIndexOf('.')
  const extension = dotIndex !== -1 ? filename.slice(dotIndex + 1) : ''

  const handleAction = (action: () => void) => {
    action()
    setIsOpen(false)
  }

  return (
    <div className="actions-dropdown-wrapper" ref={dropdownRef}>
      <button className="actions-dropdown-btn" onClick={toggleDropdown} title="Ações do arquivo">
        <span>Ações</span>
        <span className="actions-icon">⋮</span>
      </button>

      {isOpen && (
        <div className="actions-dropdown-menu">
          <button onClick={() => handleAction(() => onHideFile(relativePath))}>
            <span className="action-icon"><EyeOff size={14} strokeWidth={2} /></span>
            <span>Ocultar este arquivo</span>
          </button>
          
          {extension && (
            <button onClick={() => handleAction(() => onHideExtension(extension))}>
              <span className="action-icon"><FolderOpen size={14} strokeWidth={2} /></span>
              <span>Ocultar todos *.{extension}</span>
            </button>
          )}

          <button onClick={() => handleAction(() => onCopyPath(relativePath))}>
            <span className="action-icon"><Copy size={14} strokeWidth={2} /></span>
            <span>Copiar caminho relativo</span>
          </button>

          <button onClick={() => handleAction(() => onCopyName(filename))}>
            <span className="action-icon"><FileText size={14} strokeWidth={2} /></span>
            <span>Copiar nome do arquivo</span>
          </button>

          <button onClick={() => handleAction(() => onRevealInExplorer(relativePath))}>
            <span className="action-icon"><Search size={14} strokeWidth={2} /></span>
            <span>Revelar no sistema</span>
          </button>

          {onCopySingleFileDiff && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onCopySingleFileDiff(relativePath, e)
                setIsOpen(false)
              }}
            >
              <span className="action-icon"><FileDiff size={14} strokeWidth={2} /></span>
              <span>{copiedFile === relativePath ? 'Copiado!' : 'Copiar diff deste arquivo'}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
