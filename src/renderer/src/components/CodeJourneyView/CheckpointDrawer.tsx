/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar o painel lateral deslizante como compositor de duas zonas: topo fixo (ImplementationHeader) e miolo rolável (quatro seções de auditoria).
2. Manter o overlay, o botão de fechar, o listener de ESC com cleanup e o retorno de foco ao elemento anterior.
3. Renderizar o modo criação (com a pele das seções existentes) e o preview (CheckpointPreview) como ramificações mutuamente exclusivas ao modo detalhes.

Mapa de Relacionamentos do Script

1. CodeJourneyView.tsx
   - Tipo: Dependência Inversa
   - Relação: É instanciado pelo orquestrador quando selectedCheckpointId não é nulo.
   - Criticidade: Alta

2. ImplementationHeader.tsx
   - Tipo: Dependência Direta
   - Relação: Reusa as classes .ih-* para o topo do modo criação e instancia o cabeçalho no modo detalhes.
   - Criticidade: Alta

3. DocumentationSection.tsx
   - Tipo: Dependência Direta
   - Relação: Reusa as classes .ds-* para os campos do modo criação.
   - Criticidade: Alta

4. ChangesSection.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza as mudanças agrupadas por tipo no miolo rolável.
   - Criticidade: Alta

5. AuditSection.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza o volume de tokens e os dropdowns Copiar/Exportar no miolo rolável.
   - Criticidade: Alta

6. CheckpointPreview.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza a visualização do diff quando previewMarkdown está preenchido.
   - Criticidade: Alta

7. CheckpointDrawer.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos do drawer, overlay, animações e modo criação.
   - Criticidade: Alta

Invariantes do Script

1. O listener de ESC deve ser removido na desmontagem (cleanup no useEffect).
2. O drawer nunca gerencia estado de dados — apenas recebe via props.
3. O overlay escurecido nunca deve bloquear o fechamento por ESC.
4. As props do drawer não mudam — o orquestrador (CodeJourneyView.tsx) nunca é tocado (permanece verdadeira, mas as props agora usam arrays).

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useEffect, useRef } from 'react'
import { GitCommitHorizontal } from 'lucide-react'
import { Campaign, CheckpointSummary } from '../../../../shared/types'
import { CheckpointPreview } from './CheckpointPreview'
import { AuditCopyLevel, CheckpointStatusInfo } from './restoreUtils'
import { ImplementationHeader } from './ImplementationHeader'
import { DocumentationSection } from './DocumentationSection'
import { ChangesSection } from './ChangesSection'
import { AuditSection } from './AuditSection'
import { Button } from '../shared/Button/Button'
import { CampaignPicker } from './CampaignPicker'
import { FileListItem, SaveStatus } from './types'
import './CheckpointDrawer.css'

export type { FileListItem }

interface CheckpointDrawerProps {
  isOpen: boolean
  checkpoint: CheckpointSummary | undefined
  fileList: FileListItem[]
  diffTokenCount: number
  selectedFilePaths: Set<string>
  previewMarkdown: string
  isGeneratingPreview: boolean
  isExporting: boolean
  isCopied: boolean
  previewError: string
  instructions: string
  agentSummary: string
  statusInfo: CheckpointStatusInfo | undefined
  saveStatus: SaveStatus
  onClose: () => void
  onToggleFile: (path: string) => void
  onPreview: () => void
  onRename: () => void
  onBackToDetails: () => void
  onInstructionsChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onAgentSummaryChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onRetrySave: () => void
  onCopyLevel: (level: AuditCopyLevel) => void
  onExportLevel: (level: AuditCopyLevel) => void
  campaigns: Campaign[]
  onCampaignChange: (checkpointId: string, campaignIds: string[]) => void
  // Modo criação
  isCreating: boolean
  createName: string
  createInstructions: string
  createAgentSummary: string
  isCreatingLoading: boolean
  onCreateNameChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onCreateInstructionsChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onCreateAgentSummaryChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onCreateConfirm: () => void
  createCampaignIds: string[]
  onCreateCampaignChange: (ids: string[]) => void
}

/**
 * Drawer lateral compositor do editor de auditoria.
 * Topo fixo (ImplementationHeader) + miolo rolável (Documentação → Mudanças → Auditoria).
 * Fecha com ESC ou clique no overlay. Foco retorna ao elemento anterior ao fechar.
 */
export const CheckpointDrawer: React.FC<CheckpointDrawerProps> = ({
  isOpen,
  checkpoint,
  fileList,
  diffTokenCount,
  selectedFilePaths,
  previewMarkdown,
  isGeneratingPreview,
  isExporting,
  isCopied,
  previewError,
  instructions,
  agentSummary,
  statusInfo,
  saveStatus,
  onClose,
  onToggleFile,
  onPreview,
  onRename,
  onBackToDetails,
  onInstructionsChange,
  onAgentSummaryChange,
  onRetrySave,
  onCopyLevel,
  onExportLevel,
  campaigns,
  onCampaignChange,
  isCreating,
  createName,
  createInstructions: createInstructionsProp,
  createAgentSummary,
  isCreatingLoading,
  onCreateNameChange,
  onCreateInstructionsChange,
  onCreateAgentSummaryChange,
  onCreateConfirm,
  createCampaignIds,
  onCreateCampaignChange
}) => {
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement
    } else if (previousFocusRef.current) {
      if (typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus()
      }
      previousFocusRef.current = null
    }
  }, [isOpen])

  // INVARIANT: listener de ESC deve sempre ser removido na desmontagem
  useEffect(() => {
    if (!isOpen) return

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [isOpen, onClose])

  return (
    <>
      {/* Overlay escurecido com blur — cobre a timeline ao fundo */}
      <div
        className={`cd-overlay${isOpen ? ' visible' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Painel deslizante */}
      <div
        className={`cd-panel${isOpen ? ' open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Detalhes da Implementação"
      >
        {/* Botão de fechar */}
        <button className="cd-close-btn" onClick={onClose} title="Fechar (ESC)">
          ✕
        </button>

        {isCreating ? (
          /* ─── Modo criação: pele das seções existentes ──────────────────── */
          <>
            <div className="ih-header">
              <div className="ih-identity">
                <div className="ih-avatar">
                  <GitCommitHorizontal size={18} />
                </div>
                <div className="ih-identity-text">
                  <div className="ih-name-row">
                    <h2 className="ih-name">Nova Implementação</h2>
                  </div>
                </div>
              </div>
            </div>

            <div className="cd-body">
              <div className="ds-field">
                <label className="ds-label">Nome</label>
                <input
                  className="cd-create-input"
                  type="text"
                  value={createName}
                  onChange={onCreateNameChange}
                  placeholder="Ex: Sprint 1, Antes do refactor..."
                  disabled={isCreatingLoading}
                  autoFocus
                />
              </div>

              <div className="ds-field">
                <label className="ds-label">Instrução</label>
                <textarea
                  className="ds-textarea"
                  value={createInstructionsProp}
                  onChange={onCreateInstructionsChange}
                  placeholder="Descreva as instruções desta implementação..."
                  disabled={isCreatingLoading}
                  rows={5}
                />
              </div>

              <div className="ds-field">
                <label className="ds-label">Resultado</label>
                <textarea
                  className="ds-textarea"
                  value={createAgentSummary}
                  onChange={onCreateAgentSummaryChange}
                  placeholder="Cole o resultado gerado pelo agente..."
                  disabled={isCreatingLoading}
                  rows={5}
                />
              </div>

              <div className="ds-field">
                <label className="ds-label">Campanha</label>
                <div style={{ alignSelf: 'flex-start' }}>
                  <CampaignPicker 
                    campaigns={campaigns} 
                    selectedCampaignIds={createCampaignIds} 
                    onChange={onCreateCampaignChange} 
                    variant="field" 
                  />
                </div>
              </div>

              <div className="cd-create-actions">
                <Button variant="ghost" onClick={onClose} disabled={isCreatingLoading}>
                  Cancelar
                </Button>
                <Button variant="pill" onClick={onCreateConfirm} disabled={isCreatingLoading || !createName.trim()}>
                  {isCreatingLoading ? 'Criando...' : 'Criar'}
                </Button>
              </div>
            </div>
          </>
        ) : !checkpoint ? (
          <div className="cd-empty">Implementação não encontrada.</div>
        ) : previewMarkdown ? (
          <CheckpointPreview
            previewMarkdown={previewMarkdown}
            diffTokenCount={diffTokenCount}
            isCopied={isCopied}
            isExporting={isExporting}
            onCopyLevel={onCopyLevel}
            onExportLevel={onExportLevel}
            onBack={onBackToDetails}
          />
        ) : (
          /* ─── Modo detalhes: topo fixo + miolo rolável ─────────────────── */
          <>
            <ImplementationHeader
              name={checkpoint.name}
              createdAt={checkpoint.createdAt}
              statusInfo={statusInfo}
              selectedCampaignIds={checkpoint?.campaignIds ?? []}
              campaigns={campaigns}
              onCampaignChange={(campaignId) => onCampaignChange(checkpoint.id, campaignId)}
              onRename={onRename}
            />

            <div className="cd-body">
              {/* Aviso de arquivamento */}
              {checkpoint.hasContent === false && (
                <div className="cd-archived-notice">
                  📦 Conteúdo arquivado — esta implementação excedeu o limite de armazenamento.
                  Ações de conteúdo (preview, cópia) não estão disponíveis.
                </div>
              )}

              <DocumentationSection
                instructions={instructions}
                agentSummary={agentSummary}
                onInstructionsChange={onInstructionsChange}
                onAgentSummaryChange={onAgentSummaryChange}
                saveStatus={saveStatus}
                onRetrySave={onRetrySave}
              />

              <div className="cd-section-divider" />

              <ChangesSection
                fileList={fileList}
                selectedFilePaths={selectedFilePaths}
                onToggleFile={onToggleFile}
                onPreview={onPreview}
                isGeneratingPreview={isGeneratingPreview}
                previewError={previewError}
                fileCount={checkpoint.fileCount}
              />

              <div className="cd-section-divider" />

              <AuditSection
                diffTokenCount={diffTokenCount}
                isExporting={isExporting}
                isCopied={isCopied}
                onCopyLevel={onCopyLevel}
                onExportLevel={onExportLevel}
                hasContent={checkpoint.hasContent !== false}
              />
            </div>
          </>
        )}
      </div>
    </>
  )
}