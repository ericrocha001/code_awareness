/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Exibir modal educativo de restauração com dry-run, lista de revertidos, backup e limpeza.
2. Gerenciar estado interno dos checkboxes (backup ativado por padrão, limpeza desativada).
3. Proteger contra fechamento acidental durante execução (ESC/overlay bloqueados).
4. Delegar confirmação ao orquestrador com as opções escolhidas pelo usuário.

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
   - Relação: Consome RestorePreviewResult, OrphanFile.
   - Criticidade: Alta

Invariantes do Script

1. O modal nunca deve fechar com ESC ou clique no overlay durante a execução (isExecuting).
2. O checkbox de backup deve iniciar marcado (true) sempre que o modal abrir.
3. O checkbox de limpeza deve iniciar desmarcado (false) sempre que o modal abrir.
4. O botão "Restaurar" deve ficar desabilitado durante a execução, exibindo "Restaurando...".
5. O botão "Cancelar" deve ficar desabilitado durante a execução.
6. A seção de remanescentes só deve ser renderizada se houver orphanFiles.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useEffect, useState } from 'react'
import { RestorePreviewResult } from '../../../../shared/types'
import './RestoreModal.css'

interface RestoreModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (options: { createSafety: boolean; cleanupFiles: string[] }) => void
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

  if (!isOpen || !preview) return null

  const orphanFiles = preview.orphanFiles ?? []
  const cannotRestore = preview.cannotRestore ?? []

  const handleOverlayClick = () => {
    if (!isExecuting) onClose()
  }

  const handleConfirm = () => {
    onConfirm({
      createSafety,
      cleanupFiles: cleanupSelected ? orphanFiles.map(f => f.relativePath) : []
    })
  }

  return (
    <div className="cc-modal-overlay" onClick={handleOverlayClick}>
      <div className="cc-modal-content rm-modal" onClick={e => e.stopPropagation()}>
        <h3>🔄 Restaurar Implementação</h3>
        <p className="rm-target-name">Restaurar para o estado da implementação <strong>"{checkpointName}"</strong>.</p>

        <div className="rm-body">
          {/* 1. Explicação educativa */}
          <div className="rm-explanation">
            <div className="rm-explanation-icon">ℹ️</div>
            <div className="rm-explanation-text">
              <p>Arquivos que existiam neste ponto retornarão ao estado exato daquela data.</p>
              <p>Arquivos criados depois deste ponto <strong>não</strong> serão apagados — eles permanecem no disco.</p>
              <p>Implementações posteriores a este ponto serão marcadas como revertidas.</p>
            </div>
          </div>

          {/* 2. Resultado do dry-run */}
          <div className="rm-dry-run">
            <div className="rm-dry-run-stat success">
              <span className="rm-dry-run-icon">✅</span>
              <span>{preview.canRestore.length} arquivo(s) serão restaurados.</span>
            </div>

            {cannotRestore.length > 0 && (
              <div className="rm-cannot-restore">
                <div className="rm-dry-run-stat error">
                  <span className="rm-dry-run-icon">❌</span>
                  <span>{cannotRestore.length} arquivo(s) não podem ser restaurados:</span>
                </div>
                <ul className="rm-cannot-restore-list">
                  {cannotRestore.map((item, i) => (
                    <li key={i}>
                      <code>{item.path}</code> — {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* 3. Checkpoints revertidos */}
          <div className="rm-reverted-section">
            <strong>Implementações afetadas:</strong>
            {revertedCheckpointNames.length > 0 ? (
              <>
                <p className="rm-reverted-desc">As seguintes implementações serão marcadas como revertidas:</p>
                <ul className="rm-reverted-list">
                  {revertedCheckpointNames.map((name, i) => (
                    <li key={i}>{name}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="rm-reverted-desc">Nenhuma implementação posterior será afetada.</p>
            )}
          </div>

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
                {orphanFiles.map((file, i) => (
                  <div key={i} className="rm-orphan-item">
                    <code>{file.relativePath}</code>
                    <span className="rm-orphan-origin">({file.originCheckpointName})</span>
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
          <button
            className="cc-modal-cancel"
            onClick={onClose}
            disabled={isExecuting}
          >
            Cancelar
          </button>
          <button
            className="cc-modal-confirm--danger"
            onClick={handleConfirm}
            disabled={isExecuting}
          >
            {isExecuting ? 'Restaurando...' : 'Restaurar'}
          </button>
        </div>
      </div>
    </div>
  )
}