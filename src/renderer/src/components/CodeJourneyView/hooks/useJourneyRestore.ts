/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerenciar o estado do fluxo de restauração de implementações (preview, modal educativo, modal de restauração parcial e execução).
2. Fornecer os handlers para abrir preview da restauração via timeline, confirmar restauração, fechar modal e tentar restauração parcial.
3. Calcular a lista de nomes de implementações que serão revertidas pela operação de restauração.

Mapa de Relacionamentos do Script

1. CodeJourneyView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome estados, handlers e implementações revertidas para controlar a UI da aba Code Journey.
   - Criticidade: Alta

2. ../../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Consome CheckpointSummary e RestorePreviewResult.
   - Criticidade: Alta

3. window.codeAwareness.*
   - Tipo: Dependência Inversa
   - Relação: Invoca restorePreview e restoreExecute via IPC.
   - Criticidade: Alta

4. reloadCheckpoints.ts
   - Tipo: Dependência Direta
   - Relação: Utilitário compartilhado para recarregar a lista de checkpoints após restauração.
   - Criticidade: Alta

5. ../utils/reverted-checkpoints.ts
   - Tipo: Dependência Direta
   - Relação: Fornece getRevertedCheckpointNames para cálculo das implementações que serão revertidas.
   - Criticidade: Alta

Invariantes do Script

1. A restauração total recarrega a lista de checkpoints e os dados do checkpoint selecionado sem limpar o preview do diff.
2. A restauração parcial bem-sucedida limpa o preview do diff via callback clearPreview.
3. O id do alvo da restauração (restoreTargetId) é mantido exclusivamente interno ao módulo.
4. O alvo de ação (actionTargetId) é atualizado via callback setActionTargetId para sincronia com o orquestrador.
5. handleConfirmPartialRestore é uma função assíncrona comum (não memoizada com useCallback).

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { useState, useCallback, useMemo } from 'react'
import { CheckpointSummary, RestorePreviewResult } from '../../../../../shared/types'
import { reloadCheckpoints } from '../../../../../shared/utils/reloadCheckpoints'
import { getRevertedCheckpointNames } from '../../../utils/reverted-checkpoints'

interface UseJourneyRestoreParams {
  activeProject: { path: string; name: string } | null
  onStatusMessage: (message: string, isError?: boolean) => void
  checkpoints: CheckpointSummary[]
  setCheckpoints: React.Dispatch<React.SetStateAction<CheckpointSummary[]>>
  selectedCheckpointId: string | null
  loadCheckpointData: (repoPath: string, checkpointId: string) => Promise<void>
  setActionTargetId: (id: string | null) => void
  clearPreview: () => void
}

export function useJourneyRestore({
  activeProject,
  onStatusMessage,
  checkpoints,
  setCheckpoints,
  selectedCheckpointId,
  loadCheckpointData,
  setActionTargetId,
  clearPreview,
}: UseJourneyRestoreParams) {
  const [restorePreview, setRestorePreview] = useState<RestorePreviewResult | null>(null)
  const [isRestoreModalOpen, setIsRestoreModalOpen] = useState(false)
  const [isExecutingRestore, setIsExecutingRestore] = useState(false)
  const [restoreTargetId, setRestoreTargetId] = useState<string | null>(null)
  const [restoreTargetName, setRestoreTargetName] = useState('')

  const [partialRestoreModal, setPartialRestoreModal] = useState<{
    open: boolean
    canRestore: string[]
    cannotRestore: Array<{ path: string; reason: string }>
    checkpointId: string
  } | null>(null)

  // ─── Checkpoints revertidos (cálculo) ────────────────────────────────────

  const revertedCheckpointNames = useMemo(
    () => getRevertedCheckpointNames(checkpoints, restoreTargetId),
    [checkpoints, restoreTargetId]
  )

  // ─── Handlers de restauração (acionados pela timeline / modal) ────────────

  /** Abre o RestoreModal a partir de um checkpoint específico (via timeline). */
  const handleRestoreById = useCallback(async (checkpointId: string) => {
    if (!activeProject) return

    const targetCp = checkpoints.find(c => c.id === checkpointId)
    if (!targetCp) return

    setActionTargetId(checkpointId)
    setRestoreTargetId(checkpointId)
    setRestoreTargetName(targetCp.name)

    try {
      const result = await window.codeAwareness.restorePreview(activeProject.path, checkpointId)
      if (result.success && result.data) {
        setRestorePreview(result.data)
        setIsRestoreModalOpen(true)
      } else {
        onStatusMessage(result.error || 'Erro ao carregar preview da restauração', true)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao carregar preview da restauração', true)
    }
  }, [activeProject, checkpoints, onStatusMessage, setActionTargetId])

  /**
   * Handler chamado pelo RestoreModal ao confirmar a restauração.
   * Executa restore:execute e trata sucesso, parcial e erro.
   * Usa restoreTargetId (que pode vir da timeline via actionTargetId ou do drawer).
   */
  const handleConfirmRestore = useCallback(async (options: { createSafety: boolean; cleanupFiles: string[] }) => {
    if (!activeProject || !restoreTargetId) return

    setIsExecutingRestore(true)
    try {
      const result = await window.codeAwareness.restoreExecute(activeProject.path, restoreTargetId, options)

      if (result.success && result.data) {
        if (!result.data.partial) {
          // Sucesso total
          let msg = `✓ ${result.data.restored} arquivo(s) restaurado(s) com sucesso!`
          if (result.data.safetyBackupId) {
            msg += ` Backup criado (${result.data.safetyBackupId}).`
          }
          if (result.data.cleanup && result.data.cleanup.removed > 0) {
            msg += ` ${result.data.cleanup.removed} arquivo(s) remanescente(s) removido(s).`
          }
          onStatusMessage(msg)

          // Fecha o RestoreModal
          setIsRestoreModalOpen(false)
          setRestorePreview(null)
          setRestoreTargetId(null)
          setActionTargetId(null)
          setRestoreTargetName('')

          // Recarrega a lista de checkpoints para atualizar a timeline
          await reloadCheckpoints(activeProject.path, setCheckpoints)

          // Recarrega os dados do checkpoint selecionado para atualizar o drawer
          if (selectedCheckpointId) {
            await loadCheckpointData(activeProject.path, selectedCheckpointId)
          }
        } else {
          // Resultado parcial — fecha RestoreModal e abre o modal de parcial existente
          setIsRestoreModalOpen(false)
          setRestorePreview(null)
          setRestoreTargetId(null)
          setActionTargetId(null)
          setRestoreTargetName('')

          // Extrai canRestore/cannotRestore do resultado para o modal parcial
          const canRestore = result.data.restored > 0
            ? [`${result.data.restored} arquivo(s) restaurado(s)`]
            : []
          setPartialRestoreModal({
            open: true,
            canRestore,
            cannotRestore: result.data.errors.map(e => ({ path: e, reason: 'Erro na restauração' })),
            checkpointId: restoreTargetId!
          })
        }
      } else {
        // Erro
        onStatusMessage(result.error || 'Erro ao restaurar implementação', true)
        setIsRestoreModalOpen(false)
        setRestorePreview(null)
        setRestoreTargetId(null)
        setActionTargetId(null)
        setRestoreTargetName('')
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao restaurar implementação', true)
      setIsRestoreModalOpen(false)
      setRestorePreview(null)
      setRestoreTargetId(null)
      setActionTargetId(null)
      setRestoreTargetName('')
    } finally {
      setIsExecutingRestore(false)
    }
  }, [activeProject, restoreTargetId, selectedCheckpointId, onStatusMessage, setCheckpoints, loadCheckpointData, setActionTargetId])

  const handleCloseRestoreModal = useCallback(() => {
    setIsRestoreModalOpen(false)
    setRestorePreview(null)
    setRestoreTargetId(null)
    setActionTargetId(null)
    setRestoreTargetName('')
  }, [setActionTargetId])

  // ─── Modal de restauração parcial (legado) ───────────────────────────────

  /**
   * BUGFIX (Sprint 8): O retry de restauração parcial agora usa restoreExecute em vez de
   * restoreCheckpoint. O restoreExecute já marca o checkpoint internamente quando o
   * resultado é sucesso total, eliminando a necessidade de restoreMarkManual separada.
   *
   * BUGFIX (Sprint 8.1): A condição de sucesso agora verifica result.data em vez de
   * result.success, pois o handler IPC restore:execute retorna { success: false, data, partial: true }
   * para resultados parciais. Se o retry retornar parcial novamente, reabre o modal parcial
   * com os novos dados.
   */
  const handleConfirmPartialRestore = async () => {
    if (!partialRestoreModal) return
    setIsExecutingRestore(true)
    try {
      const result = await window.codeAwareness.restoreExecute(
        activeProject!.path,
        partialRestoreModal.checkpointId,
        { createSafety: false, cleanupFiles: [] }
      )

      if (result.data && !result.data.partial) {
        // Sucesso total
        onStatusMessage(`✓ ${result.data.restored} arquivo(s) restaurado(s) com sucesso!`)
        clearPreview()

        // Recarrega lista de checkpoints para atualizar as cores da timeline
        await reloadCheckpoints(activeProject!.path, setCheckpoints)
        if (selectedCheckpointId) {
          await loadCheckpointData(activeProject!.path, selectedCheckpointId)
        }

        setPartialRestoreModal(null)
      } else if (result.data && result.data.partial) {
        // Retry retornou parcial novamente — reabre o modal parcial com os novos dados
        const canRestore = result.data.restored > 0
          ? [`${result.data.restored} arquivo(s) restaurado(s)`]
          : []
        setPartialRestoreModal({
          open: true,
          canRestore,
          cannotRestore: result.data.errors.map(e => ({ path: e, reason: 'Erro na restauração' })),
          checkpointId: partialRestoreModal.checkpointId
        })
      } else if (result.partial && result.data) {
        // Caso alternativa: result.partial como flag do resultado de nível superior
        const canRestore = result.data.restored > 0
          ? [`${result.data.restored} arquivo(s) restaurado(s)`]
          : []
        setPartialRestoreModal({
          open: true,
          canRestore,
          cannotRestore: result.data.errors.map(e => ({ path: e, reason: 'Erro na restauração' })),
          checkpointId: partialRestoreModal.checkpointId
        })
      } else {
        // Erro de pré-condição (sem data)
        onStatusMessage(result.error || 'Erro ao restaurar implementação', true)
        setPartialRestoreModal(null)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao restaurar implementação', true)
      setPartialRestoreModal(null)
    } finally {
      setIsExecutingRestore(false)
    }
  }

  return {
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
  }
}
