/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Apresentar um modal para edição do prompt de auditoria de compressão.
2. Fornecer textarea amplo e botões de ação (Salvar/Cancelar).
3. Notificar o componente pai sobre mudanças via callback onSave.

Mapa de Relacionamentos do Script

1. CodeCompressionView.tsx
   - Tipo: Dependência Inversa
   - Relação: Chama o modal para edição do prompt de auditoria.
   - Criticidade: Alta

2. PromptEditorModal.css
   - Tipo: Relação de UI
   - Relação: Consome estilos CSS do componente.
   - Criticidade: Alta

Invariantes do Script

1. O modal deve fechar ao pressionar Escape ou clicar no overlay.
2. O callback onSave deve ser chamado apenas com valor não vazio após validação.
3. O overlay deve bloquear interação com o conteúdo de trás.

--- FIM ARQUITETURA DO SCRIPT ---
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