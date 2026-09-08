/*
-T ---
*/

import React, { useEffect, useRef, useState } from 'react'
import { Copy, Download, X } from 'lucide-react'
import Markdown from 'markdown-to-jsx'
import './PreviewModal.css'

interface PreviewModalProps {
  isOpen: boolean
  onClose: () => void
  markdown: string
  title?: string
  onExportDownloads?: () => void
  onStatusMessage?: (message: string, isError?: boolean) => void
}

export const PreviewModal: React.FC<PreviewModalProps> = ({
  isOpen,
  onClose,
  markdown,
  title = 'Preview',
  onExportDownloads,
  onStatusMessage
}) => {
  const overlayRef = useRef<HTMLDivElement>(null)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [exportStatus, setExportStatus] = useState<'idle' | 'success' | 'error'>('idle')

  useEffect(() => {
    if (!isOpen) return

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopyStatus('success')
      onStatusMessage?.('Markdown copiado!')
      setTimeout(() => setCopyStatus('idle'), 2000)
    } catch {
      setCopyStatus('error')
      onStatusMessage?.('Erro ao copiar', true)
      setTimeout(() => setCopyStatus('idle'), 2000)
    }
  }

  const handleExport = async () => {
    if (!onExportDownloads) return
    try {
      await onExportDownloads()
      setExportStatus('success')
      onStatusMessage?.('Exportado para Downloads!')
      setTimeout(() => setExportStatus('idle'), 2000)
    } catch {
      setExportStatus('error')
      onStatusMessage?.('Erro ao exportar', true)
      setTimeout(() => setExportStatus('idle'), 2000)
    }
  }

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose()
  }

  if (!isOpen) return null
  if (!markdown) return null

  return (
    <div
      className="preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-title"
      ref={overlayRef}
      onMouseDown={handleOverlayClick}
    >
      <div className="preview-modal">
        <div className="preview-modal-header">
          <div id="preview-title" className="preview-modal-title">{title}</div>
          <div className="preview-modal-actions">
            <button className="preview-modal-btn" onClick={handleCopy} title="Copiar Markdown">
              <Copy size={14} strokeWidth={2} />
              {copyStatus === 'success' ? 'Copiado!' : copyStatus === 'error' ? 'Erro' : 'Copiar'}
            </button>
            {onExportDownloads && (
              <button className="preview-modal-btn" onClick={handleExport} title="Exportar">
                <Download size={14} strokeWidth={2} />
                {exportStatus === 'success' ? 'Exportado!' : exportStatus === 'error' ? 'Erro' : 'Exportar'}
              </button>
            )}
            <button className="preview-modal-btn close" onClick={onClose} title="Fechar" aria-label="Fechar modal">
              <X size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
        <div className="preview-modal-body">
          <div className="preview-markdown">
            <Markdown>{markdown}</Markdown>
          </div>
        </div>
      </div>
    </div>
  )
}