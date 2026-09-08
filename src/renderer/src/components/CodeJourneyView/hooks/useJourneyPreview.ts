/*
-T ---
*/

import { useState, useEffect, useCallback, useMemo } from 'react'
import { CheckpointSummary, CheckpointDiffFile } from '../../../../../shared/types'
import { FileListItem } from '../types'
import { getCompareIds, estimateDiffTokens, calculateTokens } from '../checkpointUtils'
import { filterMarkdownBySelection } from '../../../utils/markdown-filter'

interface UseJourneyPreviewParams {
  activeProject: { path: string; name: string } | null
  selectedCheckpointId: string | null
  checkpoints: CheckpointSummary[]
  isCheckpointDataLoaded: boolean
  setPreviewMarkdown: React.Dispatch<React.SetStateAction<string>>
  setPreviewError: React.Dispatch<React.SetStateAction<string>>
  onStatusMessage: (message: string, isError?: boolean) => void
}

export function useJourneyPreview({
  activeProject,
  selectedCheckpointId,
  checkpoints,
  isCheckpointDataLoaded,
  setPreviewMarkdown,
  setPreviewError,
  onStatusMessage,
}: UseJourneyPreviewParams) {
  const [changedFiles, setChangedFiles] = useState<CheckpointDiffFile[]>([])
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(new Set())
  const [diffTokenCount, setDiffTokenCount] = useState(0)
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false)

  // ─── Carregamento dos arquivos alterados ──────────────────────────────────

  const loadChangedFiles = useCallback(async (repoPath: string, fromId: string, toId: string) => {
    try {
      const result = await window.codeAwareness.getCheckpointChangedFiles(repoPath, fromId, toId)
      if (result.success && result.data) {
        setChangedFiles(result.data)
      } else {
        setChangedFiles([])
      }
    } catch {
      setChangedFiles([])
    }
  }, [])

  // ─── Efeito: carregar arquivos alterados ao selecionar checkpoint ─────────

  useEffect(() => {
    if (!activeProject || !selectedCheckpointId) {
      setChangedFiles([])
      return
    }

    const { fromCheckpointId, toCheckpointId } = getCompareIds(checkpoints, selectedCheckpointId)
    loadChangedFiles(activeProject.path, fromCheckpointId, toCheckpointId)
  }, [selectedCheckpointId, checkpoints, activeProject, loadChangedFiles])

  // ─── Efeito: inicializar seleção de arquivos e tokens após carregar dados ──
  // INVARIANT: A dependência em isCheckpointDataLoaded é obrigatória —
  // reinicializa a seleção quando os dados do detalhe são carregados.

  useEffect(() => {
    if (!activeProject || !isCheckpointDataLoaded || !selectedCheckpointId) return

    const filePaths = changedFiles.map(f => f.relativePath)

    const newSelectedPaths = new Set(filePaths)
    setSelectedFilePaths(newSelectedPaths)

    const estimated = estimateDiffTokens(changedFiles, newSelectedPaths)
    setDiffTokenCount(estimated)
  }, [isCheckpointDataLoaded, activeProject, selectedCheckpointId, changedFiles])

  // ─── Efeito: recalcular tokens quando seleção muda ────────────────────────

  useEffect(() => {
    if (!changedFiles.length) return
    setDiffTokenCount(estimateDiffTokens(changedFiles, selectedFilePaths))
  }, [changedFiles, selectedFilePaths])

  // ─── Efeito: resetar preview ao trocar de checkpoint ─────────────────────

  useEffect(() => {
    setPreviewMarkdown('')
    setPreviewError('')
    setDiffTokenCount(0)
  }, [selectedCheckpointId, setPreviewMarkdown, setPreviewError])

  // ─── Memo: lista de arquivos ──────────────────────────────────────────────

  const fileList = useMemo((): FileListItem[] => {
    if (!isCheckpointDataLoaded || !activeProject) return []
    return changedFiles.map(file => ({
      path: file.relativePath,
      name: file.relativePath.split('/').pop() ?? file.relativePath,
      changeType: file.changeType
    }))
  }, [isCheckpointDataLoaded, activeProject, changedFiles])

  // ─── Alternância de arquivo ────────────────────────────────────────────────

  const handleToggleFile = useCallback((path: string) => {
    setSelectedFilePaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // ─── Filtro do markdown pela seleção ─────────────────────────────────────────────
  // Compartilhado entre o preview e o documento de auditoria (cópia/exportação).

  // Adaptador estável que injeta selectedFilePaths no utilitario puro.
  const filterBySelection = useCallback(
    (markdown: string) => filterMarkdownBySelection(markdown, selectedFilePaths),
    [selectedFilePaths]
  )

  // ─── Gerar preview ────────────────────────────────────────────────────────

  const handlePreview = useCallback(async () => {
    if (!activeProject || !selectedCheckpointId) return
    if (selectedFilePaths.size === 0) {
      setPreviewError('Selecione ao menos um arquivo para gerar o preview.')
      return
    }

    setIsGeneratingPreview(true)
    setPreviewError('')
    setPreviewMarkdown('')

    try {
      const { fromCheckpointId, toCheckpointId } = getCompareIds(checkpoints, selectedCheckpointId)
      const result = await window.codeAwareness.generateCheckpointDiff(activeProject.path, fromCheckpointId, toCheckpointId)

      if (result.success && result.data) {
        const filtered = filterBySelection(result.data)
        setPreviewMarkdown(filtered)
        setDiffTokenCount(calculateTokens(filtered))
      } else {
        setPreviewError(result.error || 'Erro ao gerar preview do diff')
        onStatusMessage(result.error || 'Erro ao gerar preview', true)
      }
    } catch (error: any) {
      setPreviewError(error.message || 'Erro ao gerar preview')
      onStatusMessage('Erro ao gerar preview do diff', true)
    } finally {
      setIsGeneratingPreview(false)
    }
  }, [activeProject, selectedCheckpointId, checkpoints, selectedFilePaths, filterBySelection, setPreviewMarkdown, setPreviewError, onStatusMessage])

  // ─── Voltar aos detalhes ──────────────────────────────────────────────────

  const handleBackToDetails = useCallback(() => {
    setPreviewMarkdown('')
    setPreviewError('')
  }, [setPreviewMarkdown, setPreviewError])

  return {
    selectedFilePaths,
    diffTokenCount,
    isGeneratingPreview,
    fileList,
    handlePreview,
    handleBackToDetails,
    handleToggleFile,
    filterMarkdownBySelection: filterBySelection,
  }
}