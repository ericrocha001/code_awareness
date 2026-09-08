/*
-T ---
*/

import React, { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import './PromptEditorModal.css'

interface PromptEditorModalProps {
  isOpen: boolean
  onClose: () => void
  initialPrompt: string
  onSave: (prompt: string) => void
}

export const PromptEditorModal: React.FC<PromptEditorModalProps> = ({
  isOpen,
  onClose,
  initialPrompt,
  onSave
}) => {
  const [prompt, setPrompt] = useState(initialPrompt)

  // Sincroniza o prompt interno quando initialPrompt mudar (ex: ao abrir modal)
  useEffect(() => {
    if (isOpen) setPrompt(initialPrompt)
  }, [isOpen, initialPrompt])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const handleSave = () => {
    const trimmed = prompt.trim()
    if (trimmed) {
      onSave(trimmed)
      onClose()
    }
  }

  const handleCancel = () => {
    setPrompt(initialPrompt)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="prompt-editor-overlay" onClick={onClose}>
      <div className="prompt-editor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="prompt-editor-header">
          <h3>Editar Prompt de Auditoria</h3>
          <button className="prompt-editor-close" onClick={onClose} aria-label="Fechar">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="prompt-editor-body">
          <textarea
            className="prompt-editor-textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={12}
          />
        </div>

        <div className="prompt-editor-footer">
          <button className="secondary" onClick={handleCancel}>
            Cancelar
          </button>
          <button onClick={handleSave} disabled={!prompt.trim()}>
            Salvar
          </button>
        </div>
      </div>
    </div>
  )
}