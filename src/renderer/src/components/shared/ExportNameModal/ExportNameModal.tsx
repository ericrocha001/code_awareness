/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar modal para coleta de nome personalizado e formato de exportação.
2. Validar nome não vazio e sanitizar caracteres inválidos antes de confirmar.
3. Gerenciar fechamento via ESC, clique no overlay, botão Cancelar e botão X.
4. Exportar o tipo FormatOption para reuso pelas abas consumidoras.

Mapa de Relacionamentos do Script

1. ExportNameModal.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos com prefixo enm-.
   - Criticidade: Alta

2. Consumidores futuros (CodeSourceView, CodeCompressionView)
   - Tipo: Dependência Inversa
   - Relação: Fornecem isOpen, onClose, onConfirm, defaultName, formats.
   - Criticidade: Alta

3. X (lucide-react)
   - Tipo: Dependência Direta
   - Relação: Ícone do botão de fechar no cabeçalho.
   - Criticidade: Baixa

Invariantes do Script

1. Nunca confirmar com nome vazio — o botão de confirmar fica desabilitado enquanto o nome sanitizado estiver vazio.
2. O nome é sempre sanitizado (trim + remoção de /\:*?"<>|) antes de onConfirm.
3. O estado interno (nome, formato) é reinicializado a cada abertura (isOpen true).
4. Fecha com ESC, clique no overlay, botão X e botão Cancelar.
5. Se houver apenas um formato, exibe como texto fixo sem escolha.
6. Prefixo CSS enm-.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import './ExportNameModal.css'

export interface FormatOption {
  id: string
  label: string
}

interface ExportNameModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (name: string, formatId: string) => void
  defaultName: string
  formats: FormatOption[]
  defaultFormat?: string
  title?: string
  confirmLabel?: string
}

const INVALID_CHARS = /[\\/:*?"<>|]/g

function sanitizeName(name: string): string {
  return name.trim().replace(INVALID_CHARS, '')
}

export const ExportNameModal: React.FC<ExportNameModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  defaultName,
  formats,
  defaultFormat,
  title = 'Exportar com nome personalizado',
  confirmLabel = 'Exportar'
}) => {
  const [name, setName] = useState(defaultName)
  const [formatId, setFormatId] = useState(defaultFormat ?? formats[0]?.id ?? '')
  const overlayRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reinicializar estado ao abrir
  useEffect(() => {
    if (isOpen) {
      setName(defaultName)
      setFormatId(defaultFormat ?? formats[0]?.id ?? '')
      // Focar o input após a abertura
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [isOpen, defaultName, defaultFormat, formats])

  // Fechar com ESC
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose()
  }, [onClose])

  const handleConfirm = useCallback(() => {
    const cleaned = sanitizeName(name)
    if (!cleaned) return
    onConfirm(cleaned, formatId)
    onClose()
  }, [name, formatId, onConfirm, onClose])

  // canConfirm usa a mesma lógica de sanitizeName para garantir consistência
  const cleanedName = sanitizeName(name)
  const canConfirm = cleanedName.length > 0

  if (!isOpen) return null

  return (
    <div
      className="enm-overlay"
      ref={overlayRef}
      onMouseDown={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="enm-title"
    >
      <div className="enm-modal">
        <div className="enm-header">
          <div id="enm-title" className="enm-title">{title}</div>
          <button
            className="enm-close"
            onClick={onClose}
            aria-label="Fechar modal"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="enm-body">
          <div className="enm-field">
            <label className="enm-label" htmlFor="enm-input">Nome do arquivo</label>
            <input
              id="enm-input"
              ref={inputRef}
              className="enm-input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && canConfirm) handleConfirm() }}
              placeholder="Nome do arquivo"
              autoComplete="off"
            />
          </div>

          <div className="enm-field">
            <span className="enm-label">Formato</span>
            {formats.length > 1 ? (
              <div className="enm-formats" role="radiogroup" aria-label="Formato de exportação">
                {formats.map(f => (
                  <button
                    key={f.id}
                    className={`enm-format-option${formatId === f.id ? ' active' : ''}`}
                    onClick={() => setFormatId(f.id)}
                    role="radio"
                    aria-checked={formatId === f.id}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="enm-format-fixed">{formats[0]?.label}</div>
            )}
          </div>
        </div>

        <div className="enm-footer">
          <button className="app-pill-btn" onClick={onClose}>Cancelar</button>
          <button
            className="app-pill-btn primary"
            onClick={handleConfirm}
            disabled={!canConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}