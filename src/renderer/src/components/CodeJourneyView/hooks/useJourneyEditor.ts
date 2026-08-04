/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerenciar o estado dos dados do detalhe da implementação selecionada (checkpointData).
2. Gerenciar os campos de edição (instruções e resultado do agente) e seu preenchimento/reset.
3. Controlar o selo de status do salvamento (idle, saving, saved, error).
4. Executar o mecanismo completo de salvamento automático (autosave): debounce, flush no fechamento/troca, snapshot de sujeira e retry.
5. Fornecer os handlers encapsulados de mudança dos campos para o drawer.

Mapa de Relacionamentos do Script

1. CodeJourneyView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome dados do detalhe, campos de edição, selo de status e handlers de autosave.
   - Criticidade: Alta

2. ../types.ts
   - Tipo: Contrato / Interface
   - Relação: Importa SaveStatus.
   - Criticidade: Alta

3. ../../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Consome CheckpointData e CheckpointSummary.
   - Criticidade: Alta

4. window.codeAwareness.*
   - Tipo: Dependência Inversa
   - Relação: Invoca loadCheckpoint e updateCheckpointDetails via IPC.
   - Criticidade: Alta

5. ../../../constants/editor-constants.ts
   - Tipo: Dependência Direta
   - Relação: Fornece AUTOSAVE_DEBOUNCE_MS e SAVED_STATUS_DISPLAY_MS para o mecanismo de autosave.
   - Criticidade: Alta

Invariantes do Script

1. O preenchimento programático dos campos ao carregar ou trocar de implementação reseta a sujeira (dirtyRef = false e dirtySnapshotRef = null).
2. O efeito de debounce agenda o salvamento automático (~0,7s) e nunca faz flush no cleanup.
3. O efeito de flush dispara no fechamento do drawer ou troca de implementação e faz o flush do snapshot sujo no cleanup se houver sujeira pendente.
4. Para checkpoints arquivados (onde checkpointData é null), o fallback usa o sumário da lista de checkpoints.
5. A atualização local do estado e da lista evita releitura desnecessária do JSON inteiro no disco.
6. Os dados do detalhe (checkpointData) só alimentam os campos de edição quando pertencem à implementação selecionada (id correspondente).
7. Os dados do detalhe são limpos a cada troca de seleção, nunca permanecendo obsoletos da implementação anterior.
8. O carregamento do detalhe usa token de invalidação: apenas a resposta da requisição mais recente é aplicada ao estado, descartando respostas obsoletas fora de ordem.
9. O efeito de carregamento do detalhe nunca depende de checkpoints — atualizações da lista (renomear, autosave, campanha) não exigem recarregamento do detalhe; apenas troca de implementação ou projeto dispara o carregamento.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { useState, useEffect, useCallback, useRef } from 'react'
import { CheckpointData, CheckpointSummary } from '../../../../../shared/types'
import { SaveStatus } from '../types'
import { AUTOSAVE_DEBOUNCE_MS, SAVED_STATUS_DISPLAY_MS } from '../../../constants/editor-constants'

interface UseJourneyEditorParams {
  activeProject: { path: string; name: string } | null
  selectedCheckpointId: string | null
  checkpoints: CheckpointSummary[]
  setCheckpoints: React.Dispatch<React.SetStateAction<CheckpointSummary[]>>
  isDrawerOpen: boolean
  isCreating: boolean
  previewMarkdown: string
  onStatusMessage: (message: string, isError?: boolean) => void
}

interface InitialFieldValues {
  instructions: string
  agentSummary: string
}

/**
 * Calcula os valores iniciais dos campos de edição.
 * Prioriza os dados do detalhe somente quando pertencem à implementação
 * selecionada (id correspondente); caso contrário, usa o sumário da lista
 * como fallback (garante que implementações arquivadas exibam seus metadados).
 */
function getInitialFieldValues(
  checkpointData: CheckpointData | null,
  selectedCheckpointId: string | null,
  checkpoints: CheckpointSummary[]
): InitialFieldValues {
  if (checkpointData && checkpointData.id === selectedCheckpointId) {
    return {
      instructions: checkpointData.instructions ?? '',
      agentSummary: checkpointData.agentSummary ?? ''
    }
  }
  if (selectedCheckpointId) {
    const selectedCp = checkpoints.find(c => c.id === selectedCheckpointId)
    if (selectedCp) {
      return {
        instructions: selectedCp.instructions ?? '',
        agentSummary: selectedCp.agentSummary ?? ''
      }
    }
  }
  return { instructions: '', agentSummary: '' }
}

export function useJourneyEditor({
  activeProject,
  selectedCheckpointId,
  checkpoints,
  setCheckpoints,
  isDrawerOpen,
  isCreating,
  previewMarkdown,
  onStatusMessage,
}: UseJourneyEditorParams) {
  const [checkpointData, setCheckpointData] = useState<CheckpointData | null>(null)
  const [editingInstructions, setEditingInstructions] = useState('')
  const [editingAgentSummary, setEditingAgentSummary] = useState('')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')

  // ─── Refs do autosave ─────────────────────────────────────────────────────
  // dirtyRef: true quando o usuário digitou desde o último save.
  // O preenchimento programático ao trocar de implementação NÃO marca sujeira
  // porque os handlers onChange só disparam em evento do usuário.
  const dirtyRef = useRef(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>()
  // Token de invalidação do carregamento do detalhe: incrementado a cada
  // chamada de loadCheckpointData. Só a resposta da requisição mais recente
  // é aplicada ao estado — respostas obsoletas de trocas rápidas de seleção
  // são descartadas, evitando que checkpointData receba dados fora de ordem.
  const loadRequestIdRef = useRef(0)
  // Snapshot dos valores sujos no momento da edição — garante que o flush
  // sempre salve o checkpoint e os valores corretos, independentemente de
  // mudanças posteriores em selectedCheckpointId ou nos campos de edição.
  const dirtySnapshotRef = useRef<{
    checkpointId: string
    instructions: string
    agentSummary: string
  } | null>(null)

  // ─── Carregamento de dados do checkpoint ───────────────────────────────────

  const loadCheckpointData = useCallback(async (repoPath: string, checkpointId: string) => {
    // BUGFIX: Token de invalidação — captura o id vigente antes do await e só
    // aplica a resposta se a requisição ainda for a mais recente. Sem isso, uma
    // resposta de um carregamento mais antigo (ex.: troca rápida de seleção)
    // poderia chegar depois e sobrescrever checkpointData com dados obsoletos.
    const requestId = ++loadRequestIdRef.current
    try {
      const result = await window.codeAwareness.loadCheckpoint(repoPath, checkpointId)
      if (loadRequestIdRef.current !== requestId) return
      if (result.success && result.data) setCheckpointData(result.data)
    } catch {
      if (loadRequestIdRef.current !== requestId) return
      setCheckpointData(null)
    }
  }, [])

  const resetCheckpointData = useCallback(() => {
    setCheckpointData(null)
  }, [])

  // ─── Efeito: carregar dados do detalhe ao selecionar checkpoint ───────────
  // BUGFIX: checkpoints não está nas deps de propósito. Incluí-lo faria o
  // efeito re-disparar a cada atualização da lista (ex.: após autosave que
  // atualiza o sumário), causando recarregamentos redundantes via IPC e
  // ampliando a janela de race. Os metadados do sumário já são atualizados
  // localmente em persistDetails, tornando a dependência desnecessária.

  useEffect(() => {
    if (!activeProject || !selectedCheckpointId) {
      setCheckpointData(null)
      return
    }

    loadCheckpointData(activeProject.path, selectedCheckpointId)
  }, [selectedCheckpointId, activeProject, loadCheckpointData])

  // ─── Efeito: limpar dados do detalhe ao trocar de seleção ────────────────
  // BUGFIX: Ao trocar de implementação, o carregamento do novo detalhe é
  // assíncrono. Sem esta limpeza, checkpointData ainda guarda os dados da
  // implementação anterior durante a janela de carregamento, vazando
  // metadados para os campos de edição. Depende APENAS de selectedCheckpointId
  // para não disparar em momentos errados (ex.: a cada autosave).

  useEffect(() => {
    setCheckpointData(null)
  }, [selectedCheckpointId])

  // ─── Efeito: inicializar campos de edição quando checkpoint carregado muda ──
  // BUGFIX: Para checkpoints arquivados (sem JSON), checkpointData é null.
  // Fallback para o sumário do checkpoint selecionado (que vem do catálogo do banco).
  // BUGFIX: Só usa checkpointData se o id dele corresponder à implementação
  // selecionada. Isso impede que dados obsoletos de um carregamento ainda em
  // andamento da implementação anterior alimentem os campos de edição.
  // Quando checkpointData não corresponde ou está ausente, os campos são
  // preenchidos com os metadados do sumário da lista (se disponível),
  // garantindo que implementações arquivadas ainda exibam seus metadados.

  useEffect(() => {
    // A lógica de preenchimento (detalhe → sumário → vazio) é isolada em
    // getInitialFieldValues para permitir testes unitários e manter o efeito enxuto.
    const values = getInitialFieldValues(checkpointData, selectedCheckpointId, checkpoints)
    setEditingInstructions(values.instructions)
    setEditingAgentSummary(values.agentSummary)
    // BUGFIX: Reseta a sujeira ao trocar de implementação para que o novo
    // checkpoint nunca herde sujeira do anterior. Belt-and-suspenders com o
    // reset no cleanup do efeito de autosave.
    dirtyRef.current = false
    // BUGFIX: Limpa o snapshot sujo para que o novo checkpoint não herde
    // valores de edição do checkpoint anterior. Se não for limpo, o
    // flushDirtySnapshot pode salvar valores stale.
    dirtySnapshotRef.current = null
  }, [checkpointData, checkpoints, selectedCheckpointId])

  // ─── Handlers de mudança dos campos ────────────────────────────────────────

  const handleInstructionsChange = useCallback((e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // Guard: não deve existir edição sem checkpoint selecionado
    if (!selectedCheckpointId) return
    const v = e.target.value
    setEditingInstructions(v)
    dirtyRef.current = true
    dirtySnapshotRef.current = {
      checkpointId: selectedCheckpointId,
      instructions: v,
      agentSummary: editingAgentSummary
    }
  }, [selectedCheckpointId, editingAgentSummary])

  const handleAgentSummaryChange = useCallback((e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // Guard: não deve existir edição sem checkpoint selecionado
    if (!selectedCheckpointId) return
    const v = e.target.value
    setEditingAgentSummary(v)
    dirtyRef.current = true
    dirtySnapshotRef.current = {
      checkpointId: selectedCheckpointId,
      instructions: editingInstructions,
      agentSummary: v
    }
  }, [selectedCheckpointId, editingInstructions])

  // ─── Persistência (extraída do handler original) + Autosave + Retry ───────
  // BUGFIX: O corpo de persistência (IPC + atualização local do detalhe e do
  // sumário da lista para arquivados) foi extraído de handleSaveDetails e
  // preservado intacto dentro de persistDetails. Os dois BUGFIX de atualização
  // local continuam vivos aqui.

  /**
   * Persiste os detalhes no banco. Se silent for true, não toca no saveStatus
   * (usado no flush mudo ao fechar/trocar). Se silent for false, percorre o
   * ciclo saving → saved → idle do selo de status.
   */
  const persistDetails = useCallback(async (silent?: boolean) => {
    if (!activeProject || !selectedCheckpointId) return
    if (!silent) setSaveStatus('saving')
    try {
      const result = await window.codeAwareness.updateCheckpointDetails(
        activeProject.path,
        selectedCheckpointId,
        { instructions: editingInstructions, agentSummary: editingAgentSummary }
      )
      if (result.success) {
        // BUGFIX: Atualiza o estado localmente em vez de recarregar o JSON inteiro.
        // O banco é a fonte autoritativa de metadados — a releitura do JSON é desnecessária.
        setCheckpointData(prev => prev
          ? { ...prev, instructions: editingInstructions, agentSummary: editingAgentSummary }
          : prev
        )
        // BUGFIX: Também atualiza o sumário na lista para checkpoints arquivados
        // (onde checkpointData é null, a atualização acima é no-op).
        setCheckpoints(prev => prev.map(cp =>
          cp.id === selectedCheckpointId
            ? { ...cp, instructions: editingInstructions, agentSummary: editingAgentSummary }
            : cp
        ))
        if (!silent) {
          setSaveStatus('saved')
          if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
          savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), SAVED_STATUS_DISPLAY_MS)
        }
      } else {
        onStatusMessage(`[useJourneyEditor] ${result.error || 'Erro ao salvar detalhes'}`, true)
        if (!silent) setSaveStatus('error')
      }
    } catch (error: any) {
      onStatusMessage(`[useJourneyEditor] ${error.message || 'Erro ao salvar detalhes'}`, true)
      if (!silent) setSaveStatus('error')
    }
  }, [activeProject, selectedCheckpointId, editingInstructions, editingAgentSummary, setCheckpoints, onStatusMessage])

  /** Handler de retry chamado pelo botão fantasma "Tentar de novo". */
  const handleRetrySave = useCallback(() => {
    persistDetails(false)
  }, [persistDetails])

  /**
   * Flush do snapshot sujo — usado pelo efeito de flush para salvar o checkpoint
   * e os valores que estavam sujos no momento da edição, independentemente de
   * mudanças posteriores em selectedCheckpointId ou nos campos de edição.
   * Lê de dirtySnapshotRef, que é atualizado sincronamente nos handlers onChange.
   */
  const flushDirtySnapshot = useCallback(async () => {
    const snapshot = dirtySnapshotRef.current
    if (!snapshot || !activeProject) return
    try {
      const result = await window.codeAwareness.updateCheckpointDetails(
        activeProject.path,
        snapshot.checkpointId,
        { instructions: snapshot.instructions, agentSummary: snapshot.agentSummary }
      )
      if (result.success) {
        // BUGFIX: Atualiza o estado localmente em vez de recarregar o JSON inteiro.
        setCheckpointData(prev => prev
          ? { ...prev, instructions: snapshot.instructions, agentSummary: snapshot.agentSummary }
          : prev
        )
        // BUGFIX: Também atualiza o sumário na lista para checkpoints arquivados.
        setCheckpoints(prev => prev.map(cp =>
          cp.id === snapshot.checkpointId
            ? { ...cp, instructions: snapshot.instructions, agentSummary: snapshot.agentSummary }
            : cp
        ))
        // BUGFIX: Limpa o snapshot após o flush bem-sucedido para evitar
        // re-flush redundante na próxima vez que o efeito de flush rodar.
        dirtySnapshotRef.current = null
      } else {
        onStatusMessage(`[useJourneyEditor] ${result.error || 'Erro ao salvar detalhes'}`, true)
      }
    } catch (error: any) {
      onStatusMessage(`[useJourneyEditor] ${error.message || 'Erro ao salvar detalhes'}`, true)
    }
  }, [activeProject, setCheckpoints, onStatusMessage])

  // ─── Efeito 1: Debounce do autosave ──────────────────────────────────────
  // Só agenda/limpa o timer de pausa (~0,7s). NUNCA flusha no cleanup.
  // Deps: os campos de edição para reagir a cada tecla + guards.
  // O persistDetails é incluído nas deps para garantir o closure mais recente
  // no timer que dispara (o cleanup sempre cancela o timer anterior).

  useEffect(() => {
    // Guards — autosave só roda quando todas as condições são verdadeiras
    if (!selectedCheckpointId || isCreating || previewMarkdown || !isDrawerOpen || !dirtyRef.current) return

    // Limpa o timer do "Salvo ✓" para não piscar no meio de um novo saving
    if (savedTimerRef.current) {
      clearTimeout(savedTimerRef.current)
      savedTimerRef.current = undefined
    }

    // Agenda o debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => {
      if (dirtyRef.current) {
        persistDetails(false)
        dirtyRef.current = false
        // BUGFIX: Limpa o snapshot após o save bem-sucedido para evitar
        // re-flush redundante ao fechar o drawer.
        dirtySnapshotRef.current = null
      }
    }, AUTOSAVE_DEBOUNCE_MS)

    // Cleanup: apenas limpa o timer — NUNCA flusha
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = undefined
      }
    }
  }, [editingInstructions, editingAgentSummary, selectedCheckpointId, isDrawerOpen, isCreating, previewMarkdown, persistDetails])

  // ─── Efeito 2: Flush no fechamento/troca ─────────────────────────────────
  // Só flusha quando o drawer fecha ou o checkpoint muda.
  // Usa flushDirtySnapshot (que lê de dirtySnapshotRef) para garantir que
  // o snapshot correto seja salvo mesmo que selectedCheckpointId ou os campos
  // de edição já tenham mudado. O corpo é no-op — apenas o cleanup importa.

  useEffect(() => {
    // Cleanup: flusha se houver sujeira pendente
    return () => {
      if (dirtyRef.current) {
        flushDirtySnapshot()
        dirtyRef.current = false
      }
    }
  }, [isDrawerOpen, selectedCheckpointId, flushDirtySnapshot])

  return {
    checkpointData,
    loadCheckpointData,
    resetCheckpointData,
    editingInstructions,
    editingAgentSummary,
    saveStatus,
    handleRetrySave,
    handleInstructionsChange,
    handleAgentSummaryChange,
  }
}
