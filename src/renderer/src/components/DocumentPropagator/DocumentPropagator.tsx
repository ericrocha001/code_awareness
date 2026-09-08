/*
-T ---
*/

import React, { useState, useCallback, DragEvent } from 'react'
import { ProjectInfo } from '../../../../shared/types'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import './DocumentPropagator.css'

interface DocumentPropagatorProps {
  projects: ProjectInfo[]
  onClose: () => void
  onStatusMessage: (message: string, isError?: boolean) => void
}

export const DocumentPropagator: React.FC<DocumentPropagatorProps> = ({
  projects,
  onClose,
  onStatusMessage
}) => {
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string } | null>(null)
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(
    () => new Set(projects.map(p => p.path))
  )
  const [isPropagating, setIsPropagating] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)

  // Master toggle: todos ligados ou todos desligados
  const allSelected = selectedRepos.size === projects.length

  const handleMasterToggle = useCallback((checked: boolean) => {
    if (checked) {
      setSelectedRepos(new Set(projects.map(p => p.path)))
    } else {
      setSelectedRepos(new Set())
    }
  }, [projects])

  const handleRepoToggle = useCallback((repoPath: string, checked: boolean) => {
    setSelectedRepos(prev => {
      const next = new Set(prev)
      if (checked) {
        next.add(repoPath)
      } else {
        next.delete(repoPath)
      }
      return next
    })
  }, [])

  // Selecionar arquivo via diálogo nativo
  const handleSelectFile = useCallback(async () => {
    try {
      const result = await window.codeAwareness.selectDocumentForPropagation()
      if (result) {
        setSelectedFile(result)
      }
    } catch (err) {
      console.error('Falha ao selecionar arquivo:', err)
      onStatusMessage('Erro ao selecionar arquivo', true)
    }
  }, [onStatusMessage])

  // Drag and drop handlers
  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)

    const files = e.dataTransfer.files
    if (!files || files.length === 0) return

    const file = files[0]
    const filePath = window.codeAwareness.getPathForFile(file)
    if (filePath) {
      setSelectedFile({ path: filePath, name: file.name })
    }
  }, [])

  // Propagar documento para os repositórios selecionados
  const handlePropagate = useCallback(async () => {
    if (!selectedFile || selectedRepos.size === 0) return

    setIsPropagating(true)
    try {
      const destinationPaths = Array.from(selectedRepos)
      const result = await window.codeAwareness.propagateDocument(
        selectedFile.path,
        destinationPaths
      )

      if (result.success > 0) {
        onStatusMessage(`Documento propagado para ${result.success} repositório(s)!`)
      }
      if (result.failed > 0) {
        onStatusMessage(`${result.failed} repositório(s) falharam na propagação`, true)
      }

      // Fecha o modal após propagação
      onClose()
    } catch (err) {
      console.error('Falha ao propagar documento:', err)
      onStatusMessage('Erro ao propagar documento', true)
    } finally {
      setIsPropagating(false)
    }
  }, [selectedFile, selectedRepos, onClose, onStatusMessage])

  // Fecha modal ao clicar no overlay
  const handleOverlayClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }, [onClose])

  const canPropagate = selectedFile !== null && selectedRepos.size > 0 && !isPropagating

  return (
    <div className="dp-overlay" onClick={handleOverlayClick}>
      <div className="dp-modal">
        <h3 className="dp-modal-title">📤 Propagar Documento</h3>

        {/* Zona de seleção de arquivo */}
        <div
          className={`dp-dropzone ${selectedFile ? 'has-file' : ''} ${isDragOver ? 'hover' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={!selectedFile ? handleSelectFile : undefined}
        >
          {selectedFile ? (
            <>
              <span className="dp-dropzone-icon">✅</span>
              <p className="dp-file-name">{selectedFile.name}</p>
              <button
                className="dp-select-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  handleSelectFile()
                }}
              >
                Trocar arquivo
              </button>
            </>
          ) : (
            <>
              <span className="dp-dropzone-icon">📄</span>
              <p className="dp-dropzone-text">
                Arraste o arquivo aqui ou <strong>clique para selecionar</strong>
              </p>
            </>
          )}
        </div>

        {/* Seção de seleção de repositórios */}
        <div className="dp-repos-section">
          <div className="dp-repos-header">
            <span className="dp-repos-label">
              Repositórios de destino ({selectedRepos.size}/{projects.length})
            </span>
            <div className="dp-master-toggle">
              <span className="dp-master-toggle-label">
                {allSelected ? 'Desmarcar todos' : 'Selecionar todos'}
              </span>
              <ToggleSwitch
                checked={allSelected}
                onChange={handleMasterToggle}
                disabled={projects.length === 0}
              />
            </div>
          </div>

          <div className="dp-repo-list">
            {projects.map(project => (
              <div key={project.path} className="dp-repo-item">
                <div className="dp-repo-info">
                  <span className="dp-repo-name">{project.name}</span>
                  <span className="dp-repo-path" title={project.path}>{project.path}</span>
                </div>
                <ToggleSwitch
                  checked={selectedRepos.has(project.path)}
                  onChange={(checked) => handleRepoToggle(project.path, checked)}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Botões de ação */}
        <div className="dp-actions">
          <button className="dp-cancel-btn" onClick={onClose} disabled={isPropagating}>
            Cancelar
          </button>
          <button
            className="dp-propagate-btn"
            onClick={handlePropagate}
            disabled={!canPropagate}
          >
            {isPropagating
              ? 'Propagando...'
              : `Propagar para ${selectedRepos.size} repositório(s)`
            }
          </button>
        </div>
      </div>
    </div>
  )
}