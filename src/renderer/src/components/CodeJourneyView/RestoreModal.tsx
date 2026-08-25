/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Exibir modal de confirmação de restauração com resumo de mudanças por arquivo (fileChanges).
2. Renderizar apenas arquivos a serem criados ou modificados (com contagens de diff), além de bloqueados e remanescentes.
3. Exibir lista de implementações revertidas, opção de backup de segurança e limpeza de remanescentes.
4. Renderizar a pele do design system (cabeçalho com X, rodapé com Button pill/ghost, ícones lucide no lugar de emojis).
5. Proteger contra fechamento acidental durante execução (ESC/overlay bloqueados).
6. Delegar confirmação ao orquestrador repassando o RestorePlan congelado do preview.

Mapa de Relacionamentos do Script

1. RestoreModal.css
   - Tipo: Relação de UI
   - Relação: Consome estilos específicos do modal (prefixo rm-).
   - Criticidade: Alta

2. CodeJourneyView.tsx
   - Tipo: Dependência Inversa
   - Relação: Orquestrador invoca este modal com dados do preview e recebe confirmação.
   - Criticidade: Alta

3. ../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Consome RestorePreviewResult, RestorePlan, RestoreFileChange, OrphanFile.
   - Criticidade: Alta

Invariantes do Script

1. Lê dados exclusivamente de preview.plan.*, nunca campos top-level de preview.
2. O modal nunca deve fechar com ESC ou clique no overlay durante a execução (isExecuting).
3. O checkbox de backup deve iniciar marcado (true) sempre que o modal abrir.
4. O checkbox de limpeza deve iniciar desmarcado (false) sempre que o modal abrir.
5. Os botões "Restaurar" e "Cancelar" devem ficar desabilitados durante a execução.
6. Permanece estritamente apresentacional: sem chamadas diretas de IPC ou lógica de escrita.
7. A lista principal renderiza apenas status modified e created — unchanged nunca é exibido.
8. Chaves de renderização usam relativePath, nunca índice.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useEffect, useState } from 'react'
import { RotateCcw, FileText, AlertTriangle, X } from 'lucide-react'
import { Button } from '../shared/Button/Button'
import { RestorePreviewResult, RestorePlan, RestoreFileChange } from '../../../../shared/types'
import './RestoreModal.css'

interface RestoreModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (options: { createSafety: boolean; cleanupFiles: string[]; plan?: RestorePlan }) => void
  preview: RestorePreviewResult | null
  checkpointName: string
  revertedCheckpointNames: string[]
  isExecuting: boolean
}

export const RestoreModal: React.FC<RestoreModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  preview,
  checkpointName,
  revertedCheckpointNames,
  isExecuting
}) => {
  const [createSafety, setCreateSafety] = useState(true)
  const [cleanupSelected, setCleanupSelected] = useState(false)

  // Resetar checkboxes sempre que o modal abrir
  useEffect(() => {
    if (isOpen) {
      setCreateSafety(true)
      setCleanupSelected(false)
    }
  }, [isOpen])

  // ESC handler com proteção durante execução
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExecuting) {
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, isExecuting, onClose])

  if (!isOpen || !preview || !preview.plan) return null

  const { plan } = preview
  const fileChanges: RestoreFileChange[] = plan.fileChanges ?? []
  const orphanFiles = plan.orphanFiles ?? []

  // Lista principal: apenas arquivos que mudam (criados/modificados).
  // unchanged não é renderizado em lugar algum — o backend segue retornando-o.
  const regularChanges = fileChanges.filter(c => c.status === 'modified' || c.status === 'created')
  const blockedChanges = fileChanges.filter(c => c.status === 'blocked')

  const handleOverlayClick = () => {
    if (!isExecuting) onClose()
  }

  const handleConfirm = () => {
    onConfirm({
      createSafety,
      cleanupFiles: cleanupSelected ? orphanFiles.map(f => f.relativePath) : [],
      plan: preview.plan
    })
  }

  return (
    <div className="cc-modal-overlay" onClick={handleOverlayClick}>
      <div className="cc-modal-content rm-modal" onClick={e => e.stopPropagation()}>
        <div className="rm-header">
          <div className="rm-header-title">
            <RotateCcw size={18} className="rm-header-icon" aria-hidden="true" />
            <h3 id="rm-title">Confirmar Restauração</h3>
          </div>
          <button
            className="rm-close"
            onClick={onClose}
            disabled={isExecuting}
            aria-label="Fechar"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <p className="rm-target-name">
          Restaurar para o estado da implementação <strong>"{checkpointName}"</strong>.
        </p>

        <div className="rm-body">
          {/* Frase-guia */}
          <p className="rm-guide-text">A restauração fará as seguintes alterações:</p>

          {/* 1. Lista de mudanças — apenas arquivos a criar/modificar */}
          {regularChanges.length > 0 ? (
            <div className="rm-changes-section">
              <div className="rm-changes-list">
                {regularChanges.map(file => (
                  <div key={file.relativePath} className="rm-change-row">
                    <div className="rm-change-file-info">
                      <FileText size={13} className="rm-file-icon" aria-hidden="true" />
                      <span className="rm-file-path" title={file.relativePath}>
                        {file.relativePath}
                      </span>
                    </div>

                    <div className="rm-change-diff-stat">
                      {file.status === 'created' && (
                        <span className="rm-badge-created">Criar</span>
                      )}

                      {file.status === 'modified' && (
                        file.addedLines !== null && file.removedLines !== null ? (
                          <div className="rm-diff-counts">
                            {file.addedLines > 0 && (
                              <span className="rm-diff-add">+{file.addedLines}</span>
                            )}
                            {file.removedLines > 0 && (
                              <span className="rm-diff-remove">−{file.removedLines}</span>
                            )}
                            {file.addedLines === 0 && file.removedLines === 0 && (
                              <span className="rm-label-modified">alterado</span>
                            )}
                          </div>
                        ) : (
                          <span className="rm-label-modified">alterado</span>
                        )
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            blockedChanges.length === 0 && (
              <p className="rm-empty-state">Nenhuma alteração de arquivos.</p>
            )
          )}

          {/* 2. Arquivos bloqueados */}
          {blockedChanges.length > 0 && (
            <div className="rm-blocked-section">
              <div className="rm-blocked-header">
                <AlertTriangle size={14} className="rm-blocked-icon" aria-hidden="true" />
                <strong>Arquivos bloqueados ({blockedChanges.length}):</strong>
              </div>
              <ul className="rm-blocked-list">
                {blockedChanges.map(item => (
                  <li key={item.relativePath} className="rm-blocked-item">
                    <code>{item.relativePath}</code>
                    {item.reason && <span className="rm-blocked-reason"> — {item.reason}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 3. Checkpoints revertidos */}
          {revertedCheckpointNames.length > 0 && (
            <div className="rm-reverted-section">
              <strong>Implementações afetadas:</strong>
              <p className="rm-reverted-desc">As seguintes implementações serão marcadas como revertidas:</p>
              <ul className="rm-reverted-list">
                {revertedCheckpointNames.map((name, i) => (
                  <li key={i}>{name}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 4. Backup de segurança */}
          <div className="rm-checkbox-row">
            <label className="rm-checkbox-label">
              <input
                type="checkbox"
                checked={createSafety}
                onChange={e => setCreateSafety(e.target.checked)}
                disabled={isExecuting}
              />
              <div className="rm-checkbox-content">
                <span className="rm-checkbox-title">Criar backup de segurança antes de restaurar (recomendado)</span>
                <span className="rm-checkbox-hint">Um snapshot do estado atual será criado para permitir desfazer.</span>
              </div>
            </label>
          </div>

          {/* 5. Arquivos remanescentes (condicional) */}
          {orphanFiles.length > 0 && (
            <div className="rm-orphan-section">
              <strong>Arquivos criados após este ponto que permanecem no disco:</strong>
              <div className="rm-orphan-list">
                {orphanFiles.map(file => (
                  <div
                    key={file.relativePath}
                    className={`rm-orphan-item ${cleanupSelected ? 'rm-orphan-item--deleting' : ''}`}
                  >
                    <div className="rm-orphan-info">
                      <code>{file.relativePath}</code>
                      <span className="rm-orphan-origin">({file.originCheckpointName})</span>
                    </div>
                    {cleanupSelected && (
                      <span className="rm-badge-deleting">será excluído</span>
                    )}
                  </div>
                ))}
              </div>
              <div className="rm-checkbox-row">
                <label className="rm-checkbox-label">
                  <input
                    type="checkbox"
                    checked={cleanupSelected}
                    onChange={e => setCleanupSelected(e.target.checked)}
                    disabled={isExecuting}
                  />
                  <div className="rm-checkbox-content">
                    <span className="rm-checkbox-title">Apagar estes {orphanFiles.length} arquivo(s) remanescentes</span>
                  </div>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Rodapé */}
        <div className="cc-modal-footer rm-footer">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={isExecuting}
          >
            Cancelar
          </Button>
          <Button
            variant="pill"
            className="danger-outline"
            icon={<RotateCcw size={14} />}
            onClick={handleConfirm}
            disabled={isExecuting}
          >
            {isExecuting ? 'Restaurando...' : 'Restaurar'}
          </Button>
        </div>
      </div>
    </div>
  )
}