/*
-T ---
*/

import React, { useEffect, useState, useRef } from 'react'
import { X, RotateCcw } from 'lucide-react'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import './HiddenFilesModal.css'

interface HiddenFilesModalProps {
  isOpen: boolean
  onClose: () => void
  repoPath: string
  onFilesRestored: () => Promise<void>
}

interface HiddenFileItem {
  path: string
  type: 'temporary' | 'persistent'
}

export const HiddenFilesModal: React.FC<HiddenFilesModalProps> = ({
  isOpen,
  onClose,
  repoPath,
  onFilesRestored
}) => {
  const [hiddenFiles, setHiddenFiles] = useState<HiddenFileItem[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [isRestoring, setIsRestoring] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen || !repoPath) return

    const loadHidden = async () => {
      try {
        const settings = await window.codeAwareness.loadSettings()
        const repoIgnores = settings.ignoredDiffFiles[repoPath]
        const items: HiddenFileItem[] = [
          ...(repoIgnores?.temporary || []).map((p: string) => ({ path: p, type: 'temporary' as const })),
          ...(repoIgnores?.persistent || []).map((p: string) => ({ path: p, type: 'persistent' as const }))
        ]
        setHiddenFiles(items)
        setSelectedPaths(new Set())
      } catch (err) {
        console.error('Erro ao carregar arquivos ocultos:', err)
      }
    }
    loadHidden()
  }, [isOpen, repoPath])

  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  const allSelected = hiddenFiles.length > 0 && selectedPaths.size === hiddenFiles.length
  const someSelected = selectedPaths.size > 0 && selectedPaths.size < hiddenFiles.length

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
      setSelectedPaths(new Set(hiddenFiles.map(h => h.path)))
    }
  }

  const handleRestore = async () => {
    if (selectedPaths.size === 0 || !repoPath) return
    setIsRestoring(true)
    try {
      for (const path of selectedPaths) {
        const item = hiddenFiles.find(h => h.path === path)
        if (!item) continue
        await window.codeAwareness.removeIgnoredFile(repoPath, path, item.type)
      }
      await onFilesRestored()
      onClose()
    } catch (err) {
      console.error('Erro ao restaurar arquivos:', err)
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
      className="hidden-files-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="hidden-files-title"
    >
      <div className="hidden-files-modal">
        <div className="hidden-files-header">
          <div className="hidden-files-header-left">
            {hiddenFiles.length > 0 && (
              <ToggleSwitch
                checked={allSelected}
                indeterminate={someSelected}
                onChange={toggleAll}
              />
            )}
            <h3 id="hidden-files-title">Arquivos Ocultos</h3>
          </div>
          <button className="hidden-files-close" onClick={onClose} aria-label="Fechar">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="hidden-files-body">
          {hiddenFiles.length === 0 ? (
            <div className="hidden-files-empty">Nenhum arquivo oculto</div>
          ) : (
            <div className="hidden-files-list">
              <div className="hidden-files-section">
                <div className="hidden-files-section-title">Temporários</div>
                {hiddenFiles.filter(h => h.type === 'temporary').length === 0 && (
                  <div className="hidden-files-empty-section">Nenhum</div>
                )}
                {hiddenFiles.filter(h => h.type === 'temporary').map(item => (
                  <div key={item.path} className="hidden-files-item">
                    <ToggleSwitch
                      checked={selectedPaths.has(item.path)}
                      onChange={() => togglePath(item.path)}
                    />
                    <span className="hidden-files-path">{item.path}</span>
                    <span className="hidden-files-badge temporary">Temporário</span>
                  </div>
                ))}
              </div>
              <div className="hidden-files-section">
                <div className="hidden-files-section-title">Persistentes</div>
                {hiddenFiles.filter(h => h.type === 'persistent').length === 0 && (
                  <div className="hidden-files-empty-section">Nenhum</div>
                )}
                {hiddenFiles.filter(h => h.type === 'persistent').map(item => (
                  <div key={item.path} className="hidden-files-item">
                    <ToggleSwitch
                      checked={selectedPaths.has(item.path)}
                      onChange={() => togglePath(item.path)}
                    />
                    <span className="hidden-files-path">{item.path}</span>
                    <span className="hidden-files-badge persistent">Persistente</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="hidden-files-footer">
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