/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerenciar as ações administrativas de uma implementação (renomear, excluir, marcar/desmarcar restauração, vincular campanha).
2. Manter o estado dos modais de renomear e excluir.
3. Notificar o orquestrador sobre limpeza de conteúdo e seleção da primeira implementação restante via callbacks.

Mapa de Relacionamentos do Script

1. CodeJourneyView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome os estados e funções de ciclo de vida fornecidos por este hook.
   - Criticidade: Alta

2. ../../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Consome CheckpointSummary.
   - Criticidade: Alta

3. window.codeAwareness.*
   - Tipo: Dependência Inversa
   - Relação: Invoca renameCheckpoint, deleteCheckpoint, restoreMarkManual, restoreUnmark e setCheckpointCampaigns.
   - Criticidade: Alta

4. reloadCheckpoints.ts
   - Tipo: Dependência Direta
   - Relação: Utilitário compartilhado para recarregar a lista de checkpoints via IPC.
   - Criticidade: Alta

Invariantes do Script

1. A exclusão deve limpar o conteúdo exibido antes de recarregar a lista.
2. O modal de exclusão e o alvo da ação devem ser limpos mesmo se o recarregamento falhar.
3. A seleção da primeira implementação restante só ocorre se o recarregamento tiver sucesso.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { useCallback, useState } from 'react'
import { CheckpointSummary } from '../../../../../shared/types'
import { reloadCheckpoints } from '../../../../../shared/utils/reloadCheckpoints'

interface UseJourneyLifecycleParams {
  activeProject: { path: string; name: string } | null
  onStatusMessage: (message: string, isError?: boolean) => void
  checkpoints: CheckpointSummary[]
  selectedCheckpointId: string | null
  setCheckpoints: React.Dispatch<React.SetStateAction<CheckpointSummary[]>>
  actionTargetId: string | null
  setActionTargetId: (id: string | null) => void
  clearSelectedCheckpointContent: () => void
  selectFirstRemaining: (list: CheckpointSummary[]) => void
}

export function useJourneyLifecycle({
  activeProject,
  onStatusMessage,
  checkpoints,
  selectedCheckpointId,
  setCheckpoints,
  actionTargetId,
  setActionTargetId,
  clearSelectedCheckpointContent,
  selectFirstRemaining,
}: UseJourneyLifecycleParams) {
  const [isRenameModalOpen, setIsRenameModalOpen] = useState(false)
  const [renameCheckpointName, setRenameCheckpointName] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const openRenameModal = useCallback(() => {
    if (!selectedCheckpointId) return
    const cp = checkpoints.find(c => c.id === selectedCheckpointId)
    if (cp) { setRenameCheckpointName(cp.name); setIsRenameModalOpen(true) }
  }, [selectedCheckpointId, checkpoints])

  const confirmRename = useCallback(async () => {
    if (!activeProject || !selectedCheckpointId || !renameCheckpointName.trim()) return
    setIsRenaming(true)
    try {
      const result = await window.codeAwareness.renameCheckpoint(activeProject.path, selectedCheckpointId, renameCheckpointName.trim())
      if (result.success) {
        onStatusMessage('Implementação renomeada com sucesso!')
        await reloadCheckpoints(activeProject.path, setCheckpoints)
        setIsRenameModalOpen(false)
        setRenameCheckpointName('')
      } else {
        onStatusMessage(result.error || 'Erro ao renomear implementação', true)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao renomear implementação', true)
    } finally {
      setIsRenaming(false)
    }
  }, [activeProject, selectedCheckpointId, renameCheckpointName, onStatusMessage, setCheckpoints])

  const requestDelete = useCallback((checkpointId: string) => {
    setActionTargetId(checkpointId)
    setIsDeleteModalOpen(true)
  }, [setActionTargetId])

  const confirmDelete = useCallback(async () => {
    const targetId = actionTargetId || selectedCheckpointId
    if (!activeProject || !targetId) return
    setIsDeleting(true)
    try {
      const result = await window.codeAwareness.deleteCheckpoint(activeProject.path, targetId)
      if (result.success) {
        onStatusMessage('✓ Implementação excluída com sucesso!')
        clearSelectedCheckpointContent()
        const reloaded = await reloadCheckpoints(activeProject.path, setCheckpoints)
        if (reloaded) {
          selectFirstRemaining(reloaded)
        }
        setIsDeleteModalOpen(false)
        setActionTargetId(null)
      } else {
        onStatusMessage(result.error || 'Erro ao excluir implementação', true)
        setActionTargetId(null)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao excluir implementação', true)
      setActionTargetId(null)
    } finally {
      setIsDeleting(false)
    }
  }, [activeProject, selectedCheckpointId, actionTargetId, onStatusMessage, clearSelectedCheckpointContent, selectFirstRemaining, setCheckpoints, setActionTargetId])

  const markRestored = useCallback(async (checkpointId: string) => {
    if (!activeProject) return
    try {
      const result = await window.codeAwareness.restoreMarkManual(activeProject.path, checkpointId)
      if (result.success) {
        onStatusMessage('Implementação marcada como restaurada!')
        await reloadCheckpoints(activeProject.path, setCheckpoints)
      } else {
        onStatusMessage(result.error || 'Erro ao marcar implementação', true)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao marcar implementação', true)
    }
  }, [activeProject, onStatusMessage, setCheckpoints])

  const unmarkRestored = useCallback(async (checkpointId: string) => {
    if (!activeProject) return
    try {
      const result = await window.codeAwareness.restoreUnmark(activeProject.path, checkpointId)
      if (result.success) {
        onStatusMessage('Marcação de restauração removida!')
        await reloadCheckpoints(activeProject.path, setCheckpoints)
      } else {
        onStatusMessage(result.error || 'Erro ao desmarcar implementação', true)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao desmarcar implementação', true)
    }
  }, [activeProject, onStatusMessage, setCheckpoints])

  const changeCampaigns = useCallback(async (checkpointId: string, campaignIds: string[]) => {
    if (!activeProject) return
    try {
      const result = await window.codeAwareness.setCheckpointCampaigns(activeProject.path, checkpointId, campaignIds)
      if (result.success) {
        onStatusMessage(campaignIds.length > 0 ? 'Campanhas vinculadas!' : 'Vínculos removidos!')
        await reloadCheckpoints(activeProject.path, setCheckpoints)
      } else {
        onStatusMessage(result.error || 'Erro ao definir vínculos de campanha', true)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao definir vínculos de campanha', true)
    }
  }, [activeProject, onStatusMessage, setCheckpoints])

  return {
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
  }
}