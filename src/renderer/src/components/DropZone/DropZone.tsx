// Responsabilidades do Script
//
// 1. Detectar e gerenciar eventos de drag-and-drop nativos na interface.
// 2. Validar que o item arrastado é um diretório (pasta) e não um arquivo individual.
// 3. Exibir estados visuais correspondentes (idle, hover, processing, erro).
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

    if (!absolutePath) {
      setErrorMsg('Não foi possível obter o caminho absoluto da pasta.')
      return
    }

    onFolderDrop(absolutePath, folderName)
  }

  const getStatusText = () => {
    if (isProcessing) return 'Analisando repositório com Codefetch...'
    if (isHover) return 'Solte para analisar'
    return 'Arraste a pasta do seu repositório aqui'
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
            '❌'
          ) : isHover ? (
            '📂'
          ) : (
            '📥'
          )}
        </div>
        <p className="dropzone-text">{getStatusText()}</p>
        {errorMsg && <p className="dropzone-error-text">{errorMsg}</p>}
      </div>
    </div>
  )
}
