/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar modal com lista de arquivos ignorados pelo usuário.
2. Permitir seleção múltipla e restauração de itens via IPC.
3. Exibir arquivos ignorados como itens individuais (caminhos exatos).

Mapa de Relacionamentos do Script

1. App.tsx
   - Tipo: Dependência Direta
   - Relação: Gerencia estado de abertura e callback de restauração.
   - Criticidade: Alta

2. ToggleSwitch.tsx
   - Tipo: Dependência Direta
   - Criticidade: Média

3. window.codeAwareness.removeIgnoredFile
   - Tipo: Dependência Inversa
   - Relação: API IPC para remover ignorações.
   - Criticidade: Alta

4. window.codeAwareness.loadSettings
   - Tipo: Dependência Inversa
   - Relação: API IPC para carregar configurações e lista de ignorados.
   - Criticidade: Alta

Invariantes do Script

1. O modal deve fechar ao clicar no overlay ou pressionar ESC.
2. A restauração deve remover apenas os itens selecionados da lista de ignorados.
3. Cada item listado corresponde a um caminho de arquivo real que foi ignorado.
4. Ítens já restaurados não podem permanecer selecionados após recarregamento.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useEffect, useState, useRef } from 'react'
import { X, RotateCcw } from 'lucide-react'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import './CodeAwarenessIgnoreModal.css'

interface CodeAwarenessIgnoreModalProps {
  isOpen: boolean
  onClose: () => void
  repoPath: string
  onFilesRestored: () => Promise<void>
}

interface IgnoredItem {
  path: string
}

export const CodeAwarenessIgnoreModal: React.FC<CodeAwarenessIgnoreModalProps> = ({
  isOpen,
  onClose,
  repoPath,
  onFilesRestored
}) => {
  const [ignoredItems, setIgnoredItems] = useState<IgnoredItem[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [isRestoring, setIsRestoring] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen || !repoPath) return

    const loadIgnored = async () => {
      try {
        const settings = await window.codeAwareness.loadSettings()
        const rawList = settings.ignoredDiffFiles[repoPath] || []
        // Mapeia a lista bruta diretamente — todos são caminhos exatos de arquivos
        const items: IgnoredItem[] = rawList.map(entry => ({ path: entry }))
        setIgnoredItems(items)
        setSelectedPaths(new Set())
      } catch (err) {
        console.error('Erro ao carregar itens ignorados:', err)
      }
    }

    loadIgnored()
  }, [isOpen, repoPath])

  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  const allSelected = ignoredItems.length > 0 && selectedPaths.size === ignoredItems.length
  const someSelected = selectedPaths.size > 0 && selectedPaths.size < ignoredItems.length

  const togglePath = (path: string) => {
    setSelectedPaths(prev => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  const toggleAll = () => {
    if (allSelected) {
      setSelectedPaths(new Set())
    } else {
      setSelectedPaths(new Set(ignoredItems.map(item => item.path)))
    }
  }

  const handleRestore = async () => {
    if (selectedPaths.size === 0 || !repoPath) return
    setIsRestoring(true)
    try {
      // Remove apenas os caminhos selecionados (todos são caminhos exatos)
      for (const path of selectedPaths) {
        await window.codeAwareness.removeIgnoredFile(repoPath, path)
      }

      window.dispatchEvent(new CustomEvent('ignored-files-updated'))
      await onFilesRestored()
      onClose()
    } catch (err) {
      console.error('Erro ao restaurar itens:', err)
    } finally {
      setIsRestoring(false)
    }
  }

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose()
  }

  if (!isOpen) return null

  return (
    <div
      className="code-awareness-ignore-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="code-awareness-ignore-title"
    >
      <div className="code-awareness-ignore-modal">
        <div className="code-awareness-ignore-header">
          <div className="code-awareness-ignore-header-left">
            {ignoredItems.length > 0 && (
              <ToggleSwitch
                checked={allSelected}
                indeterminate={someSelected}
                onChange={toggleAll}
              />
            )}
            <h3 id="code-awareness-ignore-title">Code Awareness Ignore</h3>
          </div>
          <button className="code-awareness-ignore-close" onClick={onClose} aria-label="Fechar">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="code-awareness-ignore-body">
          {ignoredItems.length === 0 ? (
            <div className="code-awareness-ignore-empty">Nenhum arquivo oculto</div>
          ) : (
            <div className="code-awareness-ignore-list">
              {ignoredItems.map(item => (
                <div key={item.path} className="code-awareness-ignore-item">
                  <ToggleSwitch
                    checked={selectedPaths.has(item.path)}
                    onChange={() => togglePath(item.path)}
                  />
                  <span className="code-awareness-ignore-path">{item.path}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="code-awareness-ignore-footer">
          <button
            className="app-pill-btn"
            onClick={handleRestore}
            disabled={selectedPaths.size === 0 || isRestoring}
          >
            <RotateCcw size={14} strokeWidth={2} />
            {isRestoring ? 'Restaurando...' : `Restaurar Selecionados (${selectedPaths.size})`}
          </button>
        </div>
      </div>
    </div>
  )
}