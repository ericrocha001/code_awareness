/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar modal de criar/editar campanha com campos: nome, descrição e status.
2. Validar nome não vazio antes de confirmar.
3. Gerenciar fechamento via ESC, clique no overlay e botão X.
4. Reinicializar o estado interno a cada abertura.

Mapa de Relacionamentos do Script

1. CampaignFormModal.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos do modal (prefixo cfm-).
   - Criticidade: Alta

2. ../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos Campaign e CampaignStatus.
   - Criticidade: Alta

Invariantes do Script

1. O modal nunca confirma com nome vazio — o botão de confirmar fica desabilitado.
2. O estado interno é reinicializado a cada abertura (isOpen true).
3. Fecha com ESC, clique no overlay, botão X e botão Cancelar.
4. O campo de status usa select com duas opções: "Em andamento" (active) e "Concluída" (completed).
5. Em modo criação, o status default é "Em andamento" e o campo de status fica oculto.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Campaign, CampaignStatus } from '../../../../shared/types'
import './CampaignFormModal.css'

interface CampaignFormModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (data: { name: string; description: string; status: CampaignStatus }) => void
  editingCampaign: Campaign | null
}

export const CampaignFormModal: React.FC<CampaignFormModalProps> = ({ isOpen, onClose, onConfirm, editingCampaign }) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<CampaignStatus>('active')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Reinicializa o estado interno a cada abertura
  useEffect(() => {
    if (isOpen) {
      if (editingCampaign) {
        setName(editingCampaign.name)
        setDescription(editingCampaign.description)
        setStatus(editingCampaign.status)
      } else {
        setName('')
        setDescription('')
        setStatus('active')
      }
      setError(null)
    }
  }, [isOpen, editingCampaign])

  // Fecha com ESC
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  const handleConfirm = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('O nome da campanha não pode estar vazio')
      return
    }
    setIsSubmitting(true)
    try {
      await onConfirm({ name: trimmed, description, status })
    } finally {
      setIsSubmitting(false)
    }
  }

  const isEditing = editingCampaign !== null

  return (
    <div className="cfm-overlay" onClick={handleOverlayClick}>
      <div className="cfm-modal">
        <div className="cfm-header">
          <h3>{isEditing ? 'Editar Campanha' : 'Nova Campanha'}</h3>
          <button className="cfm-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="cfm-body">
          {error && <p className="cfm-error">{error}</p>}

          <div className="cfm-field">
            <label htmlFor="cfm-name">Nome</label>
            <input
              id="cfm-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nome da campanha"
              autoFocus
            />
          </div>

          <div className="cfm-field">
            <label htmlFor="cfm-description">Descrição</label>
            <textarea
              id="cfm-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Descrição opcional da campanha"
            />
          </div>

          {isEditing && (
            <div className="cfm-field">
              <label htmlFor="cfm-status">Status</label>
              <select
                id="cfm-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as CampaignStatus)}
              >
                <option value="active">Em andamento</option>
                <option value="completed">Concluída</option>
              </select>
            </div>
          )}
        </div>

        <div className="cfm-footer">
          <button className="cfm-btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="cfm-btn-primary"
            onClick={handleConfirm}
            disabled={!name.trim() || isSubmitting}
          >
            {isSubmitting ? 'Salvando...' : (isEditing ? 'Salvar' : 'Criar')}
          </button>
        </div>
      </div>
    </div>
  )
}