/*
-T ---
*/

import { useCallback, useState } from 'react'
import { CheckpointSummary } from '../../../../../shared/types'
import { getLastCampaigns, setLastCampaigns } from '../../../../../shared/utils/lastCampaignStorage'

interface UseJourneyCreationParams {
  activeProject: { path: string; name: string } | null
  onStatusMessage: (message: string, isError?: boolean) => void
  setCheckpoints: React.Dispatch<React.SetStateAction<CheckpointSummary[]>>
  onOpenCreate: () => void
  onCheckpointCreated: (newCheckpointId: string) => void
}

export function useJourneyCreation({ activeProject, onStatusMessage, setCheckpoints, onOpenCreate, onCheckpointCreated }: UseJourneyCreationParams) {
  const [isCreatingMode, setIsCreatingMode] = useState(false)
  const [newCheckpointName, setNewCheckpointName] = useState('')
  const [createInstructions, setCreateInstructions] = useState('')
  const [createAgentSummary, setCreateAgentSummary] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createCampaignIds, setCreateCampaignIds] = useState<string[]>([])

  // ─── Reset do modo criação ────────────────────────────────────────────────
  // Chamado pelo orquestrador ao fechar o drawer e ao selecionar uma implementação.
  const resetCreateMode = useCallback(() => {
    setIsCreatingMode(false)
    setNewCheckpointName('')
    setCreateInstructions('')
    setCreateAgentSummary('')
    setCreateCampaignIds([])
  }, [])

  // ─── Abrir o modo criação ──────────────────────────────────────────────────
  const openCreateMode = useCallback(() => {
    setIsCreatingMode(true)
    setNewCheckpointName('')
    setCreateInstructions('')
    setCreateAgentSummary('')
    // O orquestrador abre o drawer e limpa a seleção
    onOpenCreate()
    // Carrega do armazenamento local a última campanha usada (leitura tolerante a erros)
    setCreateCampaignIds(getLastCampaigns(activeProject?.path ?? null))
  }, [activeProject, onOpenCreate])

  // ─── Troca de campanhas da criação ─────────────────────────────────────────
  // Persiste a última campanha no armazenamento local — mesma chave de hoje.
  const createCampaignChange = useCallback((ids: string[]) => {
    setCreateCampaignIds(ids)
    setLastCampaigns(activeProject?.path ?? null, ids)
  }, [activeProject])

  // ─── Confirmar a criação ───────────────────────────────────────────────────
  // Fluxo: criar → vincular campanhas → recarregar lista → selecionar a nova → mensagem → reset.
  // A seleção da nova implementação só ocorre se o recarregamento da lista tiver sucesso.
  const confirmCreate = useCallback(async () => {
    if (!activeProject || !newCheckpointName.trim()) return
    setIsCreating(true)
    try {
      const details: { instructions?: string; agentSummary?: string } = {}
      if (createInstructions.trim()) details.instructions = createInstructions.trim()
      if (createAgentSummary.trim()) details.agentSummary = createAgentSummary.trim()

      const result = await window.codeAwareness.createCheckpoint(activeProject.path, newCheckpointName.trim(), Object.keys(details).length > 0 ? details : undefined)
      if (result.success && result.data) {
        if (createCampaignIds.length > 0) {
          try {
            await window.codeAwareness.setCheckpointCampaigns(activeProject.path, result.data.id, createCampaignIds)
          } catch (e) {
            console.warn('[useJourneyCreation] Erro ao vincular campanhas na criação', e)
          }
        }
        const reload = await window.codeAwareness.listCheckpoints(activeProject.path)
        if (reload.success && reload.data) {
          setCheckpoints(reload.data)
          // O orquestrador seleciona a nova implementação e abre o drawer
          onCheckpointCreated(result.data.id)
        }
        onStatusMessage(`Implementação "${newCheckpointName}" criada com sucesso!`)
        setIsCreatingMode(false)
        setNewCheckpointName('')
        setCreateInstructions('')
        setCreateAgentSummary('')
      } else {
        onStatusMessage(result.error || 'Erro ao criar implementação', true)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao criar implementação', true)
    } finally {
      setIsCreating(false)
    }
  }, [activeProject, newCheckpointName, createInstructions, createAgentSummary, createCampaignIds, onStatusMessage, setCheckpoints, onCheckpointCreated])

  return {
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
  }
}