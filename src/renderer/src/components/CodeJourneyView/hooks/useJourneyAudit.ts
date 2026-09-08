/*
-T ---
*/

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { CheckpointSummary } from '../../../../../shared/types'
import {
  AuditCopyLevel,
  COPY_LEVELS,
  CheckpointStatusInfo,
  buildAuditDocument,
  AuditDocumentInput,
  getRestoreAwareCompareIds,
} from '../restoreUtils'
import { DEFAULT_AUDIT_PROMPT } from '../../../constants/audit-prompt'

interface UseJourneyAuditParams {
  activeProject: { path: string; name: string } | null
  onStatusMessage: (message: string, isError?: boolean) => void
  checkpoints: CheckpointSummary[]
  selectedCheckpointId: string | null
  previewMarkdown: string
  selectedFilePaths: Set<string>
  filterMarkdownBySelection: (markdown: string) => string
  editingInstructions: string
  editingAgentSummary: string
  selectedStatusInfo: CheckpointStatusInfo | undefined
}

export function useJourneyAudit({
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
}: UseJourneyAuditParams) {
  const [auditPrompt, setAuditPrompt] = useState('')
  const [isPromptEditorOpen, setIsPromptEditorOpen] = useState(false)
  const [isCopied, setIsCopied] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  // Ref para cancelar o timer do "copiado" se o usuário clicar novamente antes do timeout
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // ─── Efeito: carregar prompt de auditoria ao trocar de projeto ────────────

  useEffect(() => {
    if (!activeProject) { setAuditPrompt(''); return }

    const saved = localStorage.getItem(`code_checkpoints_audit_prompt_${activeProject.path}`)
    if (saved) {
      setAuditPrompt(saved)
    } else {
      setAuditPrompt(DEFAULT_AUDIT_PROMPT)
      localStorage.setItem(`code_checkpoints_audit_prompt_${activeProject.path}`, DEFAULT_AUDIT_PROMPT)
    }
  }, [activeProject])

  // ─── Salvar prompt ────────────────────────────────────────────────────────

  const handleSavePrompt = useCallback((prompt: string) => {
    if (!activeProject) return
    setAuditPrompt(prompt)
    localStorage.setItem(`code_checkpoints_audit_prompt_${activeProject.path}`, prompt)
  }, [activeProject])

  // ─── Obtenção do markdown do diff ────────────────────────────────────────
  // Usa o preview já gerado quando disponível; caso contrário gera sob demanda
  // com ciência de restauração (getRestoreAwareCompareIds).

  const getDiffMarkdown = useCallback(async (): Promise<string | null> => {
    // Se já temos o preview, usa-o
    if (previewMarkdown) return previewMarkdown

    // Gera o diff sob demanda
    if (!activeProject || !selectedCheckpointId) return null
    if (selectedFilePaths.size === 0) {
      onStatusMessage('Selecione ao menos um arquivo para copiar o diff', true)
      return null
    }

    try {
      const { fromCheckpointId, toCheckpointId } = getRestoreAwareCompareIds(checkpoints, selectedCheckpointId)
      const result = await window.codeAwareness.generateCheckpointDiff(activeProject.path, fromCheckpointId, toCheckpointId)
      if (result.success && result.data) {
        return filterMarkdownBySelection(result.data)
      } else {
        onStatusMessage(result.error || 'Erro ao gerar diff', true)
        return null
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao gerar diff', true)
      return null
    }
  }, [activeProject, selectedCheckpointId, checkpoints, selectedFilePaths, previewMarkdown, filterMarkdownBySelection, onStatusMessage])

  // ─── Montagem da entrada do documento ────────────────────────────────────

  const buildAuditInput = useCallback((diffMd: string): AuditDocumentInput => {
    const selectedCp = checkpoints.find(c => c.id === selectedCheckpointId)
    return {
      name: selectedCp?.name ?? 'Checkpoint',
      createdAt: selectedCp?.createdAt ?? new Date().toISOString(),
      instructions: editingInstructions,
      agentSummary: editingAgentSummary,
      status: selectedStatusInfo,
      auditPrompt,
      diffMarkdown: diffMd
    }
  }, [checkpoints, selectedCheckpointId, editingInstructions, editingAgentSummary, selectedStatusInfo, auditPrompt])

  /** Mapa nível → rótulo derivado do COPY_LEVELS para manter fonte única de verdade. */
  const levelNames = useMemo((): Record<AuditCopyLevel, string> => {
    const map: Record<AuditCopyLevel, string> = {} as Record<AuditCopyLevel, string>
    for (const item of COPY_LEVELS) {
      map[item.level as AuditCopyLevel] = item.label
    }
    return map
  }, [])

  // ─── Copiar nível ─────────────────────────────────────────────────────────

  const handleCopyLevel = useCallback(async (level: AuditCopyLevel) => {
    const diffMd = await getDiffMarkdown()
    if (!diffMd) return

    const input = buildAuditInput(diffMd)
    const document = buildAuditDocument(input, level)

    try {
      await navigator.clipboard.writeText(document)
      // Cancela o timer anterior para não piscar ao clicar repetidamente
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      setIsCopied(true)
      onStatusMessage(`✓ ${levelNames[level]} copiado!`)
      copiedTimerRef.current = setTimeout(() => setIsCopied(false), 2000)
    } catch {
      onStatusMessage('Erro ao copiar para área de transferência', true)
    }
  }, [getDiffMarkdown, buildAuditInput, onStatusMessage])

  // ─── Exportar nível ───────────────────────────────────────────────────────

  const handleExportLevel = useCallback(async (level: AuditCopyLevel) => {
    if (!activeProject) return
    const diffMd = await getDiffMarkdown()
    if (!diffMd) return

    const input = buildAuditInput(diffMd)
    const document = buildAuditDocument(input, level)
    const selectedCp = checkpoints.find(c => c.id === selectedCheckpointId)
    const safeName = (selectedCp?.name ?? 'checkpoint').replace(/[^a-zA-Z0-9_-]/g, '_')
    const fileName = `auditoria-${safeName}-nivel-${level}`

    setIsExporting(true)
    try {
      const result = await window.codeAwareness.saveToDownloads(document, fileName)
      if (result.success) {
        onStatusMessage(`✓ Nível ${level} exportado para Downloads!`)
      } else {
        onStatusMessage(result.error || 'Erro ao exportar', true)
      }
    } catch {
      onStatusMessage('Erro ao exportar documento', true)
    } finally {
      setIsExporting(false)
    }
  }, [activeProject, getDiffMarkdown, buildAuditInput, checkpoints, selectedCheckpointId, onStatusMessage])

  return {
    auditPrompt,
    isPromptEditorOpen,
    setIsPromptEditorOpen,
    isCopied,
    isExporting,
    handleSavePrompt,
    handleCopyLevel,
    handleExportLevel,
  }
}
