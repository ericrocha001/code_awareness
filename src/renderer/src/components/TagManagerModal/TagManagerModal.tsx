/*
-T ---
*/

import React, { useEffect, useState, type CSSProperties } from 'react'
import { X, Plus, Pencil, Trash2, Tag as TagIcon } from 'lucide-react'
import { Tag } from '../../../../shared/types'
import './TagManagerModal.css'

interface TagManagerModalProps {
  repoPath: string
  onClose: () => void
  onTagsChanged?: () => void
}

export const TagManagerModal: React.FC<TagManagerModalProps> = ({ repoPath, onClose, onTagsChanged }) => {
  const [tags, setTags] = useState<Tag[]>([])
  const [name, setName] = useState('')
  const [color, setColor] = useState('#7852ee')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const response = await window.codeAwareness.getTags(repoPath)
        if (!active) return
        if (response.success && response.data) setTags(response.data)
      } catch {
        if (active) setError('Erro ao carregar tags')
      } finally {
        if (active) setIsLoading(false)
      }
    }
    load()
    return () => {
      active = false
    }
  }, [repoPath])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const resetForm = () => {
    setName('')
    setColor('#7852ee')
    setEditingId(null)
  }

  const handleUpsert = async () => {
    setError(null)
    const trimmed = name.trim()
    if (!trimmed) return
    const payload: Tag = {
      id: editingId ?? '',
      name: trimmed,
      color
    }
    try {
      const response = await window.codeAwareness.upsertTag(repoPath, payload)
      if (!response.success || !response.data) {
        setError(response.error || 'Erro ao salvar tag')
        return
      }
   setTags((prev) => {
         const exists = prev.find((item) => item.id === response.data!.id)
         if (exists) return prev.map((item) => (item.id === response.data!.id ? response.data! : item))
         return [...prev, response.data!]
       })
       resetForm()
       // INVARIANT: Dispara evento global para notificar todos os componentes sobre mudança de tags
       window.dispatchEvent(new CustomEvent('tags-changed'))
     } catch {
       setError('Erro ao salvar tag')
     }
   }

  const handleEdit = (tag: Tag) => {
    setEditingId(tag.id)
    setName(tag.name)
    setColor(tag.color)
  }

  const handleDelete = async (tagId: string) => {
    setError(null)
    try {
      const response = await window.codeAwareness.deleteTag(repoPath, tagId)
      if (!response.success) {
        setError(response.error || 'Erro ao excluir tag')
        return
      }
      setTags((prev) => prev.filter((item) => item.id !== tagId))
      if (editingId === tagId) resetForm()
      // INVARIANT: Dispara evento global para notificar todos os componentes sobre mudança de tags
      window.dispatchEvent(new CustomEvent('tags-changed'))
    } catch {
      setError('Erro ao excluir tag')
    }
  }

  return (
    <div className="tag-manager-overlay" onClick={onClose}>
      <div className="tag-manager-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tag-manager-header">
          <h3><TagIcon size={18} strokeWidth={2} className="tag-manager-header-icon" /> Gerenciar Tags</h3>
          <button className="tag-manager-close" onClick={onClose} aria-label="Fechar">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="tag-manager-body">
          <form
            className="tag-manager-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleUpsert();
            }}
          >
            <div className="tag-manager-form-input-wrapper">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nome da tag"
                maxLength={40}
              />
            </div>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="Cor da tag"
            />
            <button type="submit" disabled={!name.trim()}>
              <Plus size={14} strokeWidth={2} /> {editingId ? 'Salvar' : 'Adicionar'}
            </button>
            {editingId && (
              <button type="button" className="secondary" onClick={resetForm}>
                Cancelar
              </button>
            )}
          </form>

          {error && <div className="tag-manager-error">{error}</div>}

          <ul className="tag-manager-list">
            {tags.map((tag) => (
              <li key={tag.id} className="tag-manager-item">
                <span className="tag-dot" style={{ backgroundColor: tag.color as CSSProperties['color'] }} aria-hidden="true" />
                <span className="tag-name">{tag.name}</span>
                <div className="tag-actions">
                  <button onClick={() => handleEdit(tag)} aria-label={`Editar ${tag.name}`}>
                    <Pencil size={14} strokeWidth={2} />
                  </button>
                  <button onClick={() => handleDelete(tag.id)} aria-label={`Excluir ${tag.name}`}>
                    <Trash2 size={14} strokeWidth={2} />
                  </button>
                </div>
              </li>
            ))}
            {tags.length === 0 && !error && (
              <li className="tag-manager-empty">Nenhuma tag cadastrada</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  )
}