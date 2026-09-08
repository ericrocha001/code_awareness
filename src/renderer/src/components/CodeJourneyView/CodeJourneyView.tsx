/*
-T ---
*/

import React, { useState, useCallback, useMemo } from 'react'
import { CheckpointSummary } from '../../../../shared/types'
import { PromptEditorModal } from '../PromptEditorModal/PromptEditorModal'
import { RestoreModal } from './RestoreModal'
import { CheckpointTimeline } from './CheckpointTimeline'
import { CheckpointDrawer } from './CheckpointDrawer'
import { deriveCheckpointStatuses, CheckpointStatusInfo } from './restoreUtils'
import { PenLine } from 'lucide-react'
import { ViewToolbar } from '../shared/ViewToolbar/ViewToolbar'
import { ActionBar } from '../shared/ActionBar/ActionBar'
import { FilterPopover } from '../shared/FilterPopover/FilterPopover'
import { useJourneyLoader } from './hooks/useJourneyLoader'
import { useJourneyCreation } from './hooks/useJourneyCreation'
import { useJourneyLifecycle } from './hooks/useJourneyLifecycle'
import { useJourneyPreview } from './hooks/useJourneyPreview'
import { useJourneyAudit } from './hooks/useJourneyAudit'
import { useJourneyRestore } from './hooks/useJourneyRestore'
import { useJourneyEditor } from './hooks/useJourneyEditor'
import './CodeJourneyView.css'

// BUGFIX: Ao filtrar checkpoints, o timeline recebe array vazio mesmo quando há
// checkpoints totais. A prop allCheckpointsCount permite ao timeline distinguir
// entre "sem checkpoints" e "filtros sem resultado".

interface CodeJourneyViewProps {
  activeProject: { path: string; name: string } | null
  onSelectProject: (project: { path: string; name: string } | null) => void
  onStatusMessage: (message: string, isError?: boolean) => void
}

export const CodeJourneyView: React.FC<CodeJourneyViewProps> = ({
  activeProject,
  onSelectProject,
  onStatusMessage
}) => {
  // ─── Estado principal ──────────────────────────────────────────────────────

  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null)

  // ─── Estado do drawer ──────────────────────────────────────────────────────

  // isDrawerOpen separado de selectedCheckpointId evita "piscar" ao fechar com animação
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)

  // ─── Estado de preview (elevado ao orquestrador para eliminar dependência circular) ──
  // BUGFIX: previewMarkdown e previewError eram ownership do useJourneyPreview,
  // mas useJourneyEditor precisa de previewMarkdown como guarda de autosave.
  // Como useJourneyPreview depende de checkpointData do useJourneyEditor, isso
  // criava uma dependência circular resolvida com placeholder '' (que quebrava a
  // guarda). Elevando o estado ao orquestrador, editor e preview dependem apenas
  // do orquestrador, sem circularidade.
  const [previewMarkdown, setPreviewMarkdown] = useState('')
  const [previewError, setPreviewError] = useState('')

  // ─── Callbacks para o módulo de carregamento ────────────────────────────────
  // Estáveis (deps []): apenas setters, que nunca mudam.
  const handleProjectChange = useCallback(() => {
    setSelectedCheckpointId(null)
    setIsDrawerOpen(false)
  }, [])

  const handleCheckpointsLoaded = useCallback((list: CheckpointSummary[]) => {
    if (list.length > 0) {
      setSelectedCheckpointId(list[0].id)
    }
  }, [])

  // ─── Módulo de carregamento e filtros ───────────────────────────────────────
  const {
    checkpoints,
    campaigns,
    isLoading,
    searchQuery,
    setSearchQuery,
    timeFilter,
    setTimeFilter,
    filteredCheckpoints,
    setCheckpoints,
  } = useJourneyLoader({
    activeProject,
    onProjectChange: handleProjectChange,
    onCheckpointsLoaded: handleCheckpointsLoaded,
  })

  // ─── Callbacks para o módulo de criação ──────────────────────────────────────
  // Estáveis (deps []): apenas setters, que nunca mudam.
  const handleOpenCreate = useCallback(() => {
    setIsDrawerOpen(true)
    setSelectedCheckpointId(null)
  }, [])

  const handleCreated = useCallback((newCheckpointId: string) => {
    setSelectedCheckpointId(newCheckpointId)
    setIsDrawerOpen(true)
  }, [])

  // ─── Módulo de criação ───────────────────────────────────────────────────────
  const {
    isCreatingMode,
    newCheckpointName,
    setNewCheckpointName,
    createInstructions,
    setCreateInstructions,
    createAgentSummary,
    setCreateAgentSummary,
    isCreating,
    createCampaignIds,
    openCreateMode,
    confirmCreate,
    createCampaignChange,
    resetCreateMode,
  } = useJourneyCreation({
    activeProject,
    onStatusMessage,
    setCheckpoints,
    onOpenCreate: handleOpenCreate,
    onCheckpointCreated: handleCreated,
  })

  // ─── Módulo de edição e autosave ──────────────────────────────────────────
  // BUGFIX: previewMarkdown agora é o valor real do orquestrador (não mais
  // placeholder ''). A guarda de autosave em useJourneyEditor funciona
  // corretamente: quando o preview está ativo, o autosave é bloqueado.
  const {
    checkpointData,
    loadCheckpointData,
    resetCheckpointData,
    editingInstructions,
    editingAgentSummary,
    saveStatus,
    handleRetrySave,
    handleInstructionsChange,
    handleAgentSummaryChange,
  } = useJourneyEditor({
    activeProject,
    selectedCheckpointId,
    checkpoints,
    setCheckpoints,
    isDrawerOpen,
    isCreating: isCreatingMode,
    previewMarkdown,
    onStatusMessage,
  })

  // ─── Módulo de preview e arquivos ────────────────────────────────────────
  // BUGFIX: useJourneyPreview agora recebe isCheckpointDataLoaded (boolean)
  // em vez do objeto checkpointData completo, reduzindo acoplamento.
  // Os setters de previewMarkdown e previewError vêm do orquestrador.
  const {
    selectedFilePaths,
    diffTokenCount,
    isGeneratingPreview,
    fileList,
    handlePreview,
    handleBackToDetails,
    handleToggleFile,
    filterMarkdownBySelection,
  } = useJourneyPreview({
    activeProject,
    selectedCheckpointId,
    checkpoints,
    isCheckpointDataLoaded: !!checkpointData,
    setPreviewMarkdown,
    setPreviewError,
    onStatusMessage,
  })

  // ─── Mapa de status derivado ──────────────────────────────────────────────

  const statusMap = useMemo(() => deriveCheckpointStatuses(checkpoints), [checkpoints])

  const selectedStatusInfo: CheckpointStatusInfo | undefined = useMemo(() => {
    if (!selectedCheckpointId) return undefined
    return statusMap[selectedCheckpointId]
  }, [statusMap, selectedCheckpointId])

  // ─── Estado de alvo das ações da timeline ──────────────────────────────────

  const [actionTargetId, setActionTargetId] = useState<string | null>(null)

  // ─── Callback para limpeza do estado selecionado (usado por ciclo de vida e restauração) ──────
  const clearSelectedCheckpointContent = useCallback(() => {
    resetCheckpointData()
    setPreviewMarkdown('')
    setPreviewError('')
  }, [resetCheckpointData, setPreviewMarkdown, setPreviewError])

  const selectFirstRemaining = useCallback((list: CheckpointSummary[]) => {
    setSelectedCheckpointId(list[0]?.id || null)
    setIsDrawerOpen(list.length > 0)
  }, [])

  // ─── Módulo de ciclo de vida ────────────────────────────────────────────────
  const {
    isRenameModalOpen,
    setIsRenameModalOpen,
    renameCheckpointName,
    setRenameCheckpointName,
    isRenaming,
    isDeleteModalOpen,
    setIsDeleteModalOpen,
    isDeleting,
    openRenameModal,
    confirmRename,
    requestDelete,
    confirmDelete,
    markRestored,
    unmarkRestored,
    changeCampaigns,
  } = useJourneyLifecycle({
    activeProject,
    onStatusMessage,
    checkpoints,
    selectedCheckpointId,
    setCheckpoints,
    actionTargetId,
    setActionTargetId,
    clearSelectedCheckpointContent,
    selectFirstRemaining,
  })

  // ─── Módulo de auditoria ─────────────────────────────────────────────────
  const {
    auditPrompt,
    isPromptEditorOpen,
    setIsPromptEditorOpen,
    isCopied,
    isExporting,
    handleSavePrompt,
    handleCopyLevel,
    handleExportLevel,
  } = useJourneyAudit({
    activeProject,
    onStatusMessage,
    checkpoints,
    selectedCheckpointId,
    previewMarkdown,
    selectedFilePaths,
    filterMarkdownBySelection,
    editingInstructions,
    editingAgentSummary,
    selectedStatusInfo,
  })

  // ─── Callback para limpeza do preview (usado pelo useJourneyRestore) ──────
  const clearPreview = useCallback(() => {
    setPreviewMarkdown('')
    setPreviewError('')
  }, [setPreviewMarkdown, setPreviewError])

  // ─── Módulo de restauração ────────────────────────────────────────────────
  const {
    restorePreview,
    isRestoreModalOpen,
    isExecutingRestore,
    restoreTargetName,
    partialRestoreModal,
    setPartialRestoreModal,
    revertedCheckpointNames,
    handleRestoreById,
    handleConfirmRestore,
    handleCloseRestoreModal,
    handleConfirmPartialRestore,
  } = useJourneyRestore({
    activeProject,
    onStatusMessage,
    checkpoints,
    setCheckpoints,
    selectedCheckpointId,
    loadCheckpointData,
    setActionTargetId,
    clearPreview,
  })

  // ─── Handlers de seleção ──────────────────────────────────────────────────

  const handleSelectCheckpoint = useCallback((id: string) => {
    resetCreateMode()
    setSelectedCheckpointId(id)
    setIsDrawerOpen(true)
  }, [resetCreateMode])

  const handleCloseDrawer = useCallback(() => {
    resetCreateMode()
    setIsDrawerOpen(false)
  }, [resetCreateMode])

  // ─── Contagem para a ViewToolbar ───────────────────────────────────────
  // BUGFIX: useMemo movido para antes do early return para respeitar as
  // Rules of Hooks — hooks devem ser chamados na mesma ordem em todo render.
  const summaryText = useMemo(() => {
    if (timeFilter === 'all' && !searchQuery.trim()) {
      return `${checkpoints.length} implementação${checkpoints.length !== 1 ? 'ões' : ''}`
    }
    return `${filteredCheckpoints.length} de ${checkpoints.length} implementação${checkpoints.length !== 1 ? 'ões' : ''}`
  }, [checkpoints, filteredCheckpoints, timeFilter, searchQuery])

  // ─── Render: sem projeto ──────────────────────────────────────────────────

  if (!activeProject) {
    return (
      <div className="cc-dropzone-wrapper">
        <div className="empty-selection-banner" style={{ border: 'none', background: 'transparent' }}>
          <h3>Nenhum projeto selecionado</h3>
          <p>Volte para a aba <strong>Projetos</strong> e ative um repositório para gerenciar implementações.</p>
        </div>
      </div>
    )
  }

  // ─── Render principal ─────────────────────────────────────────────────────

  return (
    <div className="ccp-container">
      {/* Camada 1: ViewToolbar com busca + contagem + funil de período + contexto */}
      <ViewToolbar
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="Buscar implementação..."
        summary={<span>{summaryText}</span>}
        filterSlot={
          <FilterPopover activeCount={timeFilter !== 'all' ? 1 : 0} closeOnSelect>
            <button
              className={`am-item fp-item${timeFilter === 'all' ? ' active' : ''}`}
              onClick={() => setTimeFilter('all')}
              role="menuitemradio"
              aria-checked={timeFilter === 'all'}
            >
              Todos
            </button>
            <button
              className={`am-item fp-item${timeFilter === '7days' ? ' active' : ''}`}
              onClick={() => setTimeFilter('7days')}
              role="menuitemradio"
              aria-checked={timeFilter === '7days'}
            >
              7 dias
            </button>
            <button
              className={`am-item fp-item${timeFilter === '30days' ? ' active' : ''}`}
              onClick={() => setTimeFilter('30days')}
              role="menuitemradio"
              aria-checked={timeFilter === '30days'}
            >
              30 dias
            </button>
            <button
              className={`am-item fp-item${timeFilter === 'year' ? ' active' : ''}`}
              onClick={() => setTimeFilter('year')}
              role="menuitemradio"
              aria-checked={timeFilter === 'year'}
            >
              Este Ano
            </button>
          </FilterPopover>
        }
      />

      {/* Camada 2: ActionBar com apenas o Prompt de Auditoria à direita (o Contexto migrou para o Code Campaign) */}
      <ActionBar
        right={
          <div className="ccp-bar-right">
            <button
              className="app-pill-btn"
              onClick={() => setIsPromptEditorOpen(true)}
              aria-label="Editar prompt de auditoria"
            >
              <PenLine size={14} />
              Prompt de Auditoria
            </button>
          </div>
        }
      />

      {/* Timeline full-width com loading interno, card "+" e menu de ciclo de vida */}
      <CheckpointTimeline
        checkpoints={filteredCheckpoints}
        campaigns={campaigns}
        allCheckpointsCount={checkpoints.length}
        selectedId={selectedCheckpointId}
        onSelect={handleSelectCheckpoint}
        onCreate={openCreateMode}
        onClearFilters={() => { setSearchQuery(''); setTimeFilter('all') }}
        isLoading={isLoading}
        onRestore={handleRestoreById}
        onDelete={requestDelete}
        onMarkRestored={markRestored}
        onUnmarkRestored={unmarkRestored}
        onCampaignChange={changeCampaigns}
      />

      {/* Drawer lateral deslizante — sem ações administrativas nem prompt */}
      <CheckpointDrawer
        isOpen={isDrawerOpen}
        checkpoint={checkpoints.find(c => c.id === selectedCheckpointId)}
        fileList={fileList}
        diffTokenCount={diffTokenCount}
        selectedFilePaths={selectedFilePaths}
        previewMarkdown={previewMarkdown}
        isGeneratingPreview={isGeneratingPreview}
        isExporting={isExporting}
        isCopied={isCopied}
        previewError={previewError}
        instructions={editingInstructions}
        agentSummary={editingAgentSummary}
        statusInfo={selectedStatusInfo}
        saveStatus={saveStatus}
        onClose={handleCloseDrawer}
        onToggleFile={handleToggleFile}
        onPreview={handlePreview}
        onRename={openRenameModal}
        onCopyLevel={handleCopyLevel}
        onExportLevel={handleExportLevel}
        onBackToDetails={handleBackToDetails}
        campaigns={campaigns}
        onCampaignChange={changeCampaigns}
        onInstructionsChange={handleInstructionsChange}
        onAgentSummaryChange={handleAgentSummaryChange}
        onRetrySave={handleRetrySave}
        // Modo criação
        isCreating={isCreatingMode}
        createName={newCheckpointName}
        createInstructions={createInstructions}
        createAgentSummary={createAgentSummary}
        isCreatingLoading={isCreating}
        createCampaignIds={createCampaignIds}
        onCreateCampaignChange={createCampaignChange}
        onCreateNameChange={(e) => setNewCheckpointName(e.target.value)}
        onCreateInstructionsChange={(e) => setCreateInstructions(e.target.value)}
        onCreateAgentSummaryChange={(e) => setCreateAgentSummary(e.target.value)}
        onCreateConfirm={confirmCreate}
      />

      {/* ── PromptEditorModal ──────────────────────────────────────────────── */}
      <PromptEditorModal
        isOpen={isPromptEditorOpen}
        onClose={() => setIsPromptEditorOpen(false)}
        initialPrompt={auditPrompt}
        onSave={handleSavePrompt}
      />

      {/* ── Modal de Renomear ──────────────────────────────────────────────── */}
      {isRenameModalOpen && (
        <div className="cc-modal-overlay" onClick={() => !isRenaming && setIsRenameModalOpen(false)}>
          <div className="cc-modal-content" onClick={e => e.stopPropagation()}>
            <h3>✏️ Renomear Implementação</h3>
            <div className="cc-modal-field">
              <label>Nome da Implementação</label>
              <input
                type="text"
                value={renameCheckpointName}
                onChange={e => setRenameCheckpointName(e.target.value)}
                placeholder="Digite o novo nome..."
                disabled={isRenaming}
                autoFocus
              />
            </div>
            <div className="cc-modal-actions">
              <button className="cc-modal-cancel" onClick={() => setIsRenameModalOpen(false)} disabled={isRenaming}>Cancelar</button>
              <button className="cc-modal-confirm" onClick={confirmRename} disabled={isRenaming || !renameCheckpointName.trim()}>
                {isRenaming ? 'Renomeando...' : 'Renomear'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal de Exclusão ─────────────────────────────────────────────── */}
      {isDeleteModalOpen && (
        <div className="cc-modal-overlay" onClick={() => !isDeleting && setIsDeleteModalOpen(false)}>
          <div className="cc-modal-content cc-confirm-modal" onClick={e => e.stopPropagation()}>
            <h3>🗑️ Excluir Implementação</h3>
            <p>Tem certeza que deseja excluir permanentemente a implementação <strong>"{checkpoints.find(c => c.id === (actionTargetId || selectedCheckpointId))?.name}"</strong>?</p>
            <p className="cc-modal-warning">⚠️ Esta ação não pode ser desfeita.</p>
            <div className="cc-modal-actions">
              <button className="cc-modal-cancel" onClick={() => setIsDeleteModalOpen(false)} disabled={isDeleting}>Cancelar</button>
              <button className="cc-modal-confirm--danger" onClick={confirmDelete} disabled={isDeleting}>
                {isDeleting ? 'Excluindo...' : 'Confirmar Exclusão'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── RestoreModal (novo fluxo educativo) ───────────────────────────── */}
      <RestoreModal
        isOpen={isRestoreModalOpen}
        onClose={handleCloseRestoreModal}
        onConfirm={handleConfirmRestore}
        preview={restorePreview}
        checkpointName={restoreTargetName}
        revertedCheckpointNames={revertedCheckpointNames}
        isExecuting={isExecutingRestore}
      />

      {/* ── Modal de Restauração Parcial ──────────────────────────────────── */}
      {partialRestoreModal?.open && (
        <div className="cc-modal-overlay">
          <div className="cc-modal-content cc-confirm-modal">
            <h3>⚠️ Restauração Incompleta Detectada</h3>
            <p>Alguns arquivos não podem ser restaurados. Deseja prosseguir mesmo assim?</p>
            <div className="cc-partial-restore-details">
              <div className="cc-partial-stat success">
                <span className="cc-partial-icon">✅</span>
                <span className="cc-partial-label">{partialRestoreModal.canRestore.length} arquivo(s) podem ser restaurados</span>
              </div>
              <div className="cc-partial-stat error">
                <span className="cc-partial-icon">❌</span>
                <span className="cc-partial-label">{partialRestoreModal.cannotRestore.length} arquivo(s) não podem ser restaurados</span>
              </div>
              {partialRestoreModal.cannotRestore.length > 0 && (
                <div className="cc-partial-errors">
                  <strong>Arquivos que vão falhar:</strong>
                  <ul>
                    {partialRestoreModal.cannotRestore.slice(0, 5).map((err, i) => (
                      <li key={i}>{err.path} ({err.reason})</li>
                    ))}
                    {partialRestoreModal.cannotRestore.length > 5 && (
                      <li>... e mais {partialRestoreModal.cannotRestore.length - 5} arquivo(s)</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
            <p className="cc-modal-warning">⚠️ O disco ainda não foi modificado.</p>
            <div className="cc-modal-actions">
              <button className="cc-modal-cancel" onClick={() => { onStatusMessage('❌ Restauração cancelada.'); setPartialRestoreModal(null) }} disabled={isExecutingRestore}>Cancelar</button>
              <button className="cc-modal-confirm cc-modal-confirm-warning" onClick={handleConfirmPartialRestore} disabled={isExecutingRestore}>
                {isExecutingRestore ? 'Restaurando...' : 'Restaurar Mesmo Assim'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}