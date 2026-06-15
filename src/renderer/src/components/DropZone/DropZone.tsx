// Responsabilidades do Script
//
// 1. Detectar e gerenciar eventos de drag-and-drop nativos na interface.
// 2. Prover botão "Select Folder" que abre diálogo nativo do Electron para escolha de pasta.
// 3. Validar se o item arrastado ou selecionado é um diretório (pasta).
// 4. Invocar o callback onFolderDrop com o caminho absoluto da pasta.

import React, { useState, DragEvent } from 'react'
import './DropZone.css'

interface DropZoneProps {
  onFolderDrop: (folderPath: string, folderName: string) => void
  isProcessing: boolean
  disabled: boolean
}

export const DropZone: React.FC<DropZoneProps> = ({ onFolderDrop, isProcessing, disabled }) => {
  const [isHover, setIsHover] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (disabled || isProcessing) return
    setIsHover(true)
  }

  const handleDragLeave = () => {
    setIsHover(false)
  }

  const processRepository = (absolutePath: string, folderName: string) => {
    if (!absolutePath) {
      setErrorMsg('Não foi possível obter o caminho absoluto da pasta.')
      return
    }
    onFolderDrop(absolutePath, folderName)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsHover(false)
    setErrorMsg(null)

    if (disabled || isProcessing) return

    const files = e.dataTransfer.files
    const items = e.dataTransfer.items

    if (!items || items.length === 0) {
      setErrorMsg('Nenhum item detectado.')
      return
    }

    const item = items[0]
    const entry = item.webkitGetAsEntry()

    if (!entry) {
      setErrorMsg('Falha ao processar o item arrastado.')
      return
    }

    if (!entry.isDirectory) {
      setErrorMsg('Por favor, arraste uma pasta (repositório), não arquivos individuais.')
      return
    }

    const file = files[0]
    const absolutePath = window.codeAwareness.getPathForFile(file)
    const folderName = file.name

    processRepository(absolutePath, folderName)
  }

  const handleSelectFolderClick = async (e: React.MouseEvent) => {
    e.stopPropagation() // Evita triggers acidentais
    if (disabled || isProcessing) return
    setErrorMsg(null)

    try {
      const res = await window.codeAwareness.selectFolder()
      if (res) {
        processRepository(res.path, res.name)
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro ao selecionar a pasta.')
    }
  }

  const getStatusText = () => {
    if (isProcessing) return 'Analisando repositório com Codefetch...'
    if (isHover) return 'Solte para analisar o repositório'
    return 'Drag & Drop Repository'
  }

  return (
    <div
      className={`dropzone ${isHover ? 'hover' : ''} ${isProcessing ? 'processing' : ''} ${errorMsg ? 'error' : ''} ${disabled ? 'disabled' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="dropzone-content">
        <div className="dropzone-icon">
          {isProcessing ? (
            <span className="spinner"></span>
          ) : errorMsg ? (
            '⚠️'
          ) : (
            <svg
              width="40"
              height="40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          )}
        </div>
        <p className="dropzone-text">{getStatusText()}</p>
        {!isProcessing && !errorMsg && (
          <p className="dropzone-subtitle">or choose a folder manually</p>
        )}
        {errorMsg && <p className="dropzone-error-text">{errorMsg}</p>}
        {!isProcessing && (
          <button
            type="button"
            className="select-folder-btn"
            onClick={handleSelectFolderClick}
            disabled={disabled}
          >
            Select Folder
          </button>
        )}
      </div>
    </div>
  )
}
