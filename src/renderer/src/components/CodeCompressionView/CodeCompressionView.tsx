/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a interface da aba Code Compression com sidebar redimensionável e layout de duas linhas.
2. Gerenciar a seleção reativa de arquivos rastreados com sistema completo de Ignore (temporary/persistent).
3. Fornecer exportação dinâmica para Obsidian e prompt de auditoria customizável via localStorage.
4. Sincronizar classificações de importância em tempo real com outras abas via evento IPC.

Mapa de Relacionamentos do Script

1. CodeCompressionView.css
   - Tipo: Relação de UI
   - Relação: Consome estilos CSS do componente.
   - Criticidade: Alta

2. ImportanceBadge.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza badge de importância para cada arquivo.
   - Criticidade: Alta

3. ignore-patterns.ts
   - Tipo: Dependência Direta
   - Relação: Fornece padrões de ruído e extensões ignoradas.
   - Criticidade: Média

4. CodeSourceView.tsx
   - Tipo: Fluxo de Dados
   - Relação: Compartilha estrutura de sidebar e layout similar.
   - Criticidade: Média

5. SidebarActions.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza dropdown unificado de ações da sidebar (Varrer Mesa, Selecionar Críticos e Altos).
   - Criticidade: Alta

6. window.codeAwareness.onImportanceUpdated
   - Tipo: Comunicação por Evento
   - Relação: Escuta eventos de atualização de importância emitidos por outras abas.
   - Criticidade: Alta

Invariantes do Script

1. A sidebar deve ter largura entre 280px e 500px, nunca fora desse intervalo.
2. O resize handle deve estar sempre na borda direita da sidebar.
3. Os nomes dos arquivos nunca devem ser truncados sem ellipsis.
4. O total de tokens selecionados deve ser calculado apenas com base nos arquivos checkados.
5. A tríade arquitetural deve ser sempre atualizada junto com o código.
6. A sincronização de importância não deve afetar a seleção de arquivos (checkboxes).
7. O listener deve ser removido quando o componente desmonta para evitar memory leaks.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Markdown from 'markdown-to-jsx'
import { DiffFileStatus, ImportanceLevel, ImportanceSource } from '../../../../shared/types'
import { NOISE_FILES, COMMON_IGNORE_EXTENSIONS } from '../../constants/ignore-patterns'
import { ImportanceBadge } from '../ImportanceBadge/ImportanceBadge'
import { ImportanceGroup } from '../ImportanceGroup/ImportanceGroup'
import { SidebarActions } from '../SidebarActions/SidebarActions'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import './CodeCompressionView.css'

// Prompt padrão para análise de estrutura de código
const DEFAULT_COMPRESSION_PROMPT = `Analise a estrutura de código abaixo como um Arquiteto de Software Staff.

Seu papel é auditar o esqueleto estrutural do repositório e fornecer:
1. Uma visão geral da arquitetura do projeto.
2. O padrão de design predominante identificado.
3. Possíveis pontos de melhoria arquitetural.
4. Dependências externas críticas identificadas.

Abaixo está o esqueleto estrutural dos arquivos selecionados:
--------------------------------------------------`


interface CodeCompressionViewProps {
  activeProject: { path: string; name: string } | null
  onStatusMessage: (message: string, isError?: boolean) => void
}

export const CodeCompressionView: React.FC<CodeCompressionViewProps> = ({ activeProject, onStatusMessage }) => {
  const [trackedFiles, setTrackedFiles] = useState<DiffFileStatus[]>([])
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [markdown, setMarkdown] = useState<string>('')
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [error, setError] = useState<string>('')
  const [auditPromptTemplate, setAuditPromptTemplate] = useState('')
  const [isCopied, setIsCopied] = useState(false)
  const [isCopyMarkdown, setIsCopyMarkdown] = useState(false)
  const [isExporting, setIsExporting] = useState(false)

  // Sistema de Importância Arquitetural
  const [importanceMap, setImportanceMap] = useState<Record<string, ImportanceLevel>>({})
  const [importanceSource, setImportanceSource] = useState<Record<string, ImportanceSource>>({})
  const [tokenEstimates, setTokenEstimates] = useState<Record<string, number>>({})
  const [isClassifying, setIsClassifying] = useState(false)

  // Ignore system
  const [ignoredFiles, setIgnoredFiles] = useState<string[]>([])
  const [persistentPatterns, setPersistentPatterns] = useState<string[]>([])
  const [ignoredAccordionOpen, setIgnoredAccordionOpen] = useState(false)
  const [ignorePopup, setIgnorePopup] = useState<{ path: string; ext: string } | null>(null)

  const ignorePopupRef = useRef<HTMLDivElement>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)
  const sidebarRef = useRef<HTMLDivElement>(null)

  // Sidebar redimensionável: largura inicial de 450px, min 280, max 500
  const [sidebarWidth, setSidebarWidth] = useState(450)
  const [isResizing, setIsResizing] = useState(false)

  // Formata contagem de tokens para exibição amigável (ex: 1234 → "1.2k")
  const formatTokenCount = useCallback((count: number): string => {
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}k`
    }
    return count.toString()
  }, [])

  // Extrai o diretório de um path relativo (ex: "src/components/foo.ts" → "src/components/")
  const getDirectoryPath = (relativePath: string): string => {
    const parts = relativePath.split('/')
    if (parts.length <= 1) return ''
    return parts.slice(0, -1).join('/') + '/'
  }

  // Handlers de resize da sidebar: mouse down inicia, mouse move atualiza, mouse up finaliza
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!sidebarRef.current) return
      const rect = sidebarRef.current.getBoundingClientRect()
      const newWidth = Math.max(280, Math.min(500, e.clientX - rect.left))
      setSidebarWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // Carrega largura da sidebar do localStorage por projeto
  useEffect(() => {
    if (!activeProject) return
    const saved = localStorage.getItem(`code_compression_sidebar_width_${activeProject.path}`)
    if (saved) {
      const width = parseInt(saved, 10)
      if (width >= 280 && width <= 500) setSidebarWidth(width)
    }
  }, [activeProject])

  // Salva largura da sidebar no localStorage quando muda (não durante o arrasto)
  useEffect(() => {
    if (!activeProject || isResizing) return
    localStorage.setItem(`code_compression_sidebar_width_${activeProject.path}`, sidebarWidth.toString())
  }, [sidebarWidth, activeProject, isResizing])

  // Carrega o template do prompt do localStorage
  useEffect(() => {
    const saved = localStorage.getItem('code_compression_prompt_template')
    setAuditPromptTemplate(saved ?? DEFAULT_COMPRESSION_PROMPT)
    if (!saved) {
      localStorage.setItem('code_compression_prompt_template', DEFAULT_COMPRESSION_PROMPT)
    }
  }, [])

  // Carrega os arquivos ignorados das settings para o repositório atual
  const loadIgnoredFiles = useCallback(async () => {
    if (!activeProject) return
    const settings = await window.codeAwareness.loadSettings()
    const repoIgnores = settings.ignoredDiffFiles[activeProject.path]
    setIgnoredFiles(repoIgnores?.temporary || [])
    setPersistentPatterns(repoIgnores?.persistent || [])
  }, [activeProject])

  // Carrega os tracked files e reseta seleção ao trocar de projeto
  useEffect(() => {
    let isMounted = true
    const fetchFiles = async () => {
      if (!activeProject) {
        if (isMounted) { setTrackedFiles([]); setSelectedFiles(new Set()); setMarkdown('') }
        return
      }
      try {
        const files = await window.codeAwareness.getAllTrackedFiles(activeProject.path)
        if (isMounted) { setTrackedFiles(files); setSelectedFiles(new Set()) }
      } catch (err) {
        console.error('Falha ao carregar tracked files:', err)
      }
    }
    fetchFiles()
    loadIgnoredFiles()
    return () => { isMounted = false }
  }, [activeProject, loadIgnoredFiles])

  // Fecha o popup ao clicar fora
  useEffect(() => {
    if (!ignorePopup) return
    const handleClick = (e: MouseEvent) => {
      if (ignorePopupRef.current && !ignorePopupRef.current.contains(e.target as Node)) {
        setIgnorePopup(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [ignorePopup])

  // Verifica se um arquivo casa com algum padrão persistente (ex: "*.css")
  const matchesPersistentPattern = useCallback((relativePath: string): boolean => {
    for (const pattern of persistentPatterns) {
      if (pattern.startsWith('*.')) {
        if (relativePath.endsWith(pattern.slice(1))) return true
      }
      if (pattern === relativePath) return true
    }
    return false
  }, [persistentPatterns])

  // Sincroniza classificações de importância quando outra aba faz override
  useEffect(() => {
    if (!activeProject) return

    const handleImportanceUpdated = (data: { repoPath: string; relativePath: string; level: ImportanceLevel; source: ImportanceSource }) => {
      // Só processa se o evento for para o projeto atual
      if (data.repoPath !== activeProject.path) return

      // Atualiza o estado local com a nova classificação
      setImportanceMap(prev => ({
        ...prev,
        [data.relativePath]: data.level
      }))
      setImportanceSource(prev => ({
        ...prev,
        [data.relativePath]: data.source
      }))
    }

    // Registra o listener
    window.codeAwareness.onImportanceUpdated(handleImportanceUpdated)

    // Cleanup: remove o listener quando o componente desmonta ou activeProject muda
    return () => {
      window.codeAwareness.removeImportanceUpdatedListener()
    }
  }, [activeProject])

  // Classifica a importância dos arquivos quando o projeto ou tracked files mudam
  useEffect(() => {
    if (!activeProject || trackedFiles.length === 0) {
      setImportanceMap({})
      setImportanceSource({})
      setTokenEstimates({})
      return
    }

    const classifyFiles = async () => {
      setIsClassifying(true)
      try {
        const result = await window.codeAwareness.classifyImportance(
          activeProject.path,
          activeProject.name,
          trackedFiles.map(f => ({ relativePath: f.relativePath }))
        )

        if (result.success && result.data) {
          const levelMap: Record<string, ImportanceLevel> = {}
          const sourceMap: Record<string, ImportanceSource> = {}
          const estimateMap: Record<string, number> = {}

          for (const [relativePath, importance] of Object.entries(result.data)) {
            levelMap[relativePath] = importance.level
            sourceMap[relativePath] = importance.source
            estimateMap[relativePath] = importance.tokenEstimate || 0
          }

          setImportanceMap(levelMap)
          setImportanceSource(sourceMap)
          setTokenEstimates(estimateMap)
        } else {
          console.error('Falha ao classificar importância:', result.error)
        }
      } catch (error) {
        console.error('Erro ao classificar importância:', error)
      } finally {
        setIsClassifying(false)
      }
    }

    classifyFiles()
  }, [activeProject, trackedFiles])

  // Lista visível: filtra ignorados e padrões persistentes da lista bruta, ordenada por importância
  const visibleFiles = useMemo(() => {
    const filtered = trackedFiles.filter(f => {
      if (ignoredFiles.includes(f.relativePath)) return false
      if (matchesPersistentPattern(f.relativePath)) return false
      return true
    })

    // Ordena por importância: critical > high > medium > low
    const importanceOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

    return filtered.sort((a, b) => {
      const levelA = importanceMap[a.relativePath] || 'low'
      const levelB = importanceMap[b.relativePath] || 'low'
      const orderDiff = importanceOrder[levelA] - importanceOrder[levelB]

      // Se mesma importância, ordena alfabeticamente
      if (orderDiff === 0) {
        return a.relativePath.localeCompare(b.relativePath)
      }

      return orderDiff
    })
  }, [trackedFiles, ignoredFiles, matchesPersistentPattern, importanceMap])

  // Arquivos agrupados por nível de importância para renderização por seção
  const groupedFiles = useMemo(() => ({
    critical: visibleFiles.filter(f => (importanceMap[f.relativePath] || 'low') === 'critical'),
    high:     visibleFiles.filter(f => (importanceMap[f.relativePath] || 'low') === 'high'),
    medium:   visibleFiles.filter(f => (importanceMap[f.relativePath] || 'low') === 'medium'),
    low:      visibleFiles.filter(f => (importanceMap[f.relativePath] || 'low') === 'low')
  }), [visibleFiles, importanceMap])

  // Total de tokens selecionados
  const totalSelectedTokens = useMemo(() => {
    let total = 0
    for (const path of selectedFiles) {
      total += tokenEstimates[path] || 0
    }
    return total
  }, [selectedFiles, tokenEstimates])

  // Detecta arquivos de ruído na lista visível
  const hasNoiseFiles = useMemo(() => visibleFiles.some(f => NOISE_FILES.has(f.name)), [visibleFiles])


  // Geração reativa com debounce de 200ms observando selectedFiles
  useEffect(() => {
    if (!activeProject) return

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)

    if (selectedFiles.size === 0) {
      setMarkdown('')
      setError('')
      setIsGenerating(false)
      return
    }

    const thisRequestId = ++requestIdRef.current
    setIsGenerating(true)
    setError('')

    debounceTimerRef.current = setTimeout(async () => {
      try {
        const selectedArray = Array.from(selectedFiles)
        const generatedMarkdown = await window.codeAwareness.generateCompressionMarkdown(activeProject.path, selectedArray)
        if (thisRequestId === requestIdRef.current) {
          setMarkdown(generatedMarkdown)
          setIsGenerating(false)
        }
      } catch (err: any) {
        if (thisRequestId === requestIdRef.current) {
          setError(err?.message || 'Falha ao gerar a compressão estrutural.')
          setIsGenerating(false)
        }
      }
    }, 200)

    return () => {
      if (debounceTimerRef.current) { clearTimeout(debounceTimerRef.current); debounceTimerRef.current = null }
    }
  }, [activeProject, selectedFiles])

  // Alterna o master checkbox entre selecionar tudo e desmarcar tudo
  const toggleMasterCheckbox = useCallback(() => {
    setSelectedFiles(prev => {
      const allSelected = prev.size === visibleFiles.length
      return allSelected ? new Set() : new Set(visibleFiles.map(f => f.relativePath))
    })
  }, [visibleFiles])

  const toggleFileSelection = useCallback((relativePath: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev)
      next.has(relativePath) ? next.delete(relativePath) : next.add(relativePath)
      return next
    })
  }, [])

  // Ignora arquivo como temporary e remove da seleção
  const ignoreFileTemporary = useCallback(async (relativePath: string) => {
    if (!activeProject) return
    setSelectedFiles(prev => { const next = new Set(prev); next.delete(relativePath); return next })
    const result = await window.codeAwareness.addIgnoredFile(activeProject.path, relativePath, 'temporary')
    if (result) {
      setIgnoredFiles(result.ignoredDiffFiles[activeProject.path]?.temporary || [])
      onStatusMessage('Arquivo ocultado!')
    }
  }, [activeProject, onStatusMessage])

  // Ignora todos os arquivos da extensão como persistent
  const ignoreExtensionPersistent = useCallback(async (ext: string) => {
    if (!activeProject) return
    const pattern = `*${ext}`
    setSelectedFiles(prev => {
      const next = new Set(prev)
      trackedFiles.forEach(f => { if (f.relativePath.endsWith(ext)) next.delete(f.relativePath) })
      return next
    })
    const result = await window.codeAwareness.addIgnoredFile(activeProject.path, pattern, 'persistent')
    if (result) {
      setPersistentPatterns(result.ignoredDiffFiles[activeProject.path]?.persistent || [])
      onStatusMessage(`Padrão ${pattern} ignorado permanentemente!`)
    }
  }, [activeProject, trackedFiles, onStatusMessage])

  // Abre popup inteligente ou ignora diretamente dependendo da extensão
  const handleHideClick = useCallback((relativePath: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const ext = relativePath.slice(relativePath.lastIndexOf('.'))
    if (COMMON_IGNORE_EXTENSIONS.has(ext)) {
      setIgnorePopup({ path: relativePath, ext })
    } else {
      ignoreFileTemporary(relativePath)
    }
  }, [ignoreFileTemporary])

  // Nota: o toast já é disparado dentro de ignoreFileTemporary
  const handlePopupIgnoreThis = useCallback(() => {
    if (!ignorePopup) return
    ignoreFileTemporary(ignorePopup.path)
    setIgnorePopup(null)
  }, [ignorePopup, ignoreFileTemporary])

  const handlePopupIgnoreAll = useCallback(() => {
    if (!ignorePopup) return
    ignoreExtensionPersistent(ignorePopup.ext)
    setIgnorePopup(null)
  }, [ignorePopup, ignoreExtensionPersistent])

  // Handler para override manual da importância de um arquivo
  const handleImportanceChange = useCallback(async (relativePath: string, newLevel: ImportanceLevel) => {
    if (!activeProject) return

    try {
      const result = await window.codeAwareness.setImportanceOverride(
        activeProject.path,
        activeProject.name,
        relativePath,
        newLevel
      )

      if (result.success && result.data) {
        const importance = result.data[relativePath]
        if (importance) {
          setImportanceMap(prev => ({ ...prev, [relativePath]: importance.level }))
          setImportanceSource(prev => ({ ...prev, [relativePath]: importance.source }))
        }
        onStatusMessage('Importância atualizada!')
      } else {
        console.error('Falha ao atualizar importância:', result.error)
      }
    } catch (error) {
      console.error('Erro ao atualizar importância:', error)
    }
  }, [activeProject, onStatusMessage])

  // Handlers para ActionsDropdown
  const handleCopyPath = useCallback((relativePath: string) => {
    navigator.clipboard.writeText(relativePath)
    onStatusMessage('Caminho copiado!')
  }, [onStatusMessage])

  const handleCopyName = useCallback((name: string) => {
    navigator.clipboard.writeText(name)
    onStatusMessage('Nome copiado!')
  }, [onStatusMessage])

  const handleRevealInExplorer = useCallback(async (relativePath: string) => {
    if (!activeProject) return
    await window.codeAwareness.revealInExplorer(activeProject.path, relativePath)
  }, [activeProject])

  const handleHideExtension = useCallback(async (ext: string) => {
    await ignoreExtensionPersistent(`.${ext}`)
  }, [ignoreExtensionPersistent])

  // Handler para selecionar todos os arquivos críticos e altos de uma vez
  const handleSelectCriticalAndHigh = useCallback(() => {
    const criticalAndHighFiles = visibleFiles.filter(f => {
      const level = importanceMap[f.relativePath] || 'low'
      return level === 'critical' || level === 'high'
    })

    setSelectedFiles(new Set(criticalAndHighFiles.map(f => f.relativePath)))
    onStatusMessage(`${criticalAndHighFiles.length} arquivo(s) crítico(s) e alto(s) selecionado(s)!`)
  }, [visibleFiles, importanceMap, onStatusMessage])

  // Varre e ignora todos os arquivos de ruído visíveis de uma vez
  const handleSweepNoise = useCallback(async () => {
    if (!activeProject) return
    const noiseToIgnore = visibleFiles.filter(f => NOISE_FILES.has(f.name))
    for (const file of noiseToIgnore) {
      await window.codeAwareness.addIgnoredFile(activeProject.path, file.relativePath, 'temporary')
    }
    setSelectedFiles(prev => {
      const next = new Set(prev)
      noiseToIgnore.forEach(f => next.delete(f.relativePath))
      return next
    })
    await loadIgnoredFiles()
    onStatusMessage(`${noiseToIgnore.length} arquivo(s) de ruído ignorado(s)!`)
  }, [activeProject, visibleFiles, loadIgnoredFiles, onStatusMessage])

  const handleRestoreFile = useCallback(async (relativePath: string) => {
    if (!activeProject) return
    const result = await window.codeAwareness.removeIgnoredFile(activeProject.path, relativePath, 'temporary')
    if (result) {
      setIgnoredFiles(result.ignoredDiffFiles[activeProject.path]?.temporary || [])
      onStatusMessage('Arquivo restaurado!')
    }
    setSelectedFiles(prev => { const next = new Set(prev); next.add(relativePath); return next })
  }, [activeProject, onStatusMessage])

  const handleRestoreAll = useCallback(async () => {
    if (!activeProject) return
    const count = ignoredFiles.length
    for (const path of ignoredFiles) {
      await window.codeAwareness.removeIgnoredFile(activeProject.path, path, 'temporary')
    }
    await loadIgnoredFiles()
    setSelectedFiles(prev => { const next = new Set(prev); ignoredFiles.forEach(p => next.add(p)); return next })
    onStatusMessage(`${count} arquivo(s) restaurado(s)!`)
  }, [activeProject, ignoredFiles, loadIgnoredFiles, onStatusMessage])

  const handleRestorePersistentPattern = useCallback(async (pattern: string) => {
    if (!activeProject) return
    const result = await window.codeAwareness.removeIgnoredFile(activeProject.path, pattern, 'persistent')
    if (result) {
      setPersistentPatterns(result.ignoredDiffFiles[activeProject.path]?.persistent || [])
      onStatusMessage('Padrão restaurado!')
    }
  }, [activeProject, onStatusMessage])

  const handleRestoreAllPersistent = useCallback(async () => {
    if (!activeProject) return
    const count = persistentPatterns.length
    for (const pattern of persistentPatterns) {
      await window.codeAwareness.removeIgnoredFile(activeProject.path, pattern, 'persistent')
    }
    await loadIgnoredFiles()
    onStatusMessage(`${count} padrão(ões) restaurado(s)!`)
  }, [activeProject, persistentPatterns, loadIgnoredFiles, onStatusMessage])

  // Promove um arquivo temporário para persistente
  const handleUpgradeToPersistent = useCallback(async (relativePath: string) => {
    if (!activeProject) return
    await window.codeAwareness.removeIgnoredFile(activeProject.path, relativePath, 'temporary')
    await window.codeAwareness.addIgnoredFile(activeProject.path, relativePath, 'persistent')
    await loadIgnoredFiles()
    onStatusMessage('Arquivo promovido para permanente!')
  }, [activeProject, loadIgnoredFiles, onStatusMessage])

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newVal = e.target.value
    setAuditPromptTemplate(newVal)
    localStorage.setItem('code_compression_prompt_template', newVal)
  }

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(`${auditPromptTemplate}\n\n${markdown}`)
    setIsCopied(true)
    setTimeout(() => setIsCopied(false), 2000)
  }

  const handleCopyMarkdown = () => {
    navigator.clipboard.writeText(markdown)
    setIsCopyMarkdown(true)
    setTimeout(() => setIsCopyMarkdown(false), 2000)
  }

  const handleExportObsidian = async () => {
    if (!activeProject) return
    setIsExporting(true)
    try {
      const settings = await window.codeAwareness.loadSettings()
      let vaultPath = settings.obsidianVaultPath

      if (!vaultPath) {
        const selectedPath = await window.codeAwareness.selectVaultFolder()
        if (!selectedPath) return
        vaultPath = selectedPath
        await window.codeAwareness.saveSettings({ ...settings, obsidianVaultPath: vaultPath })
      }

      const result = await window.codeAwareness.saveToObsidian(markdown, `${activeProject.name}-compression`, vaultPath)
      if (!result.success) console.error('Erro na exportação para Obsidian:', result.error)
    } catch (err) {
      console.error('Falha ao exportar:', err)
    } finally {
      setIsExporting(false)
    }
  }

  if (!activeProject) {
    return (
      <div className="cdf-dropzone-wrapper">
        <div className="empty-selection-banner" style={{ border: 'none', background: 'transparent' }}>
          <h3>Nenhum projeto selecionado</h3>
          <p>Volte para a aba <strong>Projetos</strong> e ative um repositório para comprimir arquivos.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="cdf-container">
      <div className="cdf-topbar">
        <div className="cdf-repo-info">
          <span className="cdf-repo-name">{activeProject.name}</span>
          <span className="cdf-status-badge watching">Compressão Estrutural</span>
        </div>
      </div>

      <div className="cdf-split">
        {/* Sidebar com lista de arquivos tracked */}
        <aside className="cdf-sidebar" ref={sidebarRef} style={{ width: sidebarWidth }}>
          {/* Resize handle na borda direita — permite arrastar para redimensionar */}
          <div
            className={`cdf-sidebar-resize-handle${isResizing ? ' resizing' : ''}`}
            onMouseDown={handleResizeMouseDown}
          />
          <div className="cdf-sidebar-header">
            <span className="cdf-sidebar-header-left">
              {visibleFiles.length > 0 && (
                <ToggleSwitch
                  checked={selectedFiles.size === visibleFiles.length && visibleFiles.length > 0}
                  indeterminate={selectedFiles.size > 0 && selectedFiles.size < visibleFiles.length}
                  onChange={toggleMasterCheckbox}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
              <span>Arquivos Tracked</span>
            </span>
            <span className="cdf-sidebar-header-right">
              {/* Dropdown unificado de ações no topo da sidebar */}
              <SidebarActions
                classPrefix="cdf"
                hasNoiseFiles={hasNoiseFiles}
                onSweepNoise={handleSweepNoise}
                hasImportanceData={Object.keys(importanceMap).length > 0}
                onSelectCriticalAndHigh={handleSelectCriticalAndHigh}
                isClassifying={isClassifying}
              />

              <span className="cdf-count-badge">{trackedFiles.length}</span>
              {totalSelectedTokens > 0 && (
                <span className="cdf-token-total" title="Total de tokens selecionados (estimativa)">
                  ≈ {formatTokenCount(totalSelectedTokens)} tokens
                </span>
              )}
            </span>
          </div>

          {visibleFiles.length === 0 && trackedFiles.length === 0 ? (
            <p className="cdf-empty-state">Nenhum arquivo encontrado.</p>
          ) : visibleFiles.length === 0 ? (
            <p className="cdf-empty-state">Todos os arquivos estão ocultos.</p>
          ) : (
            // Arquivos agrupados por nível de importância
            <div className="cdf-file-list">
              {(['critical', 'high', 'medium', 'low'] as const).map((level) => {
                const levelLabels = { critical: 'Críticos', high: 'Altos', medium: 'Médios', low: 'Baixos' }
                const levelEmojis = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }
                return (
                  <ImportanceGroup
                    key={level}
                    level={level}
                    files={groupedFiles[level]}
                    emoji={levelEmojis[level]}
                    label={levelLabels[level]}
                    classPrefix="cdf"
                    selectedFiles={selectedFiles}
                    importanceMap={importanceMap}
                    importanceSource={importanceSource}
                    tokenEstimates={tokenEstimates}
                    formatTokenCount={formatTokenCount}
                    toggleFileSelection={toggleFileSelection}
                    handleImportanceChange={handleImportanceChange}
                    onHideFile={ignoreFileTemporary}
                    onHideExtension={handleHideExtension}
                    onCopyPath={handleCopyPath}
                    onCopyName={handleCopyName}
                    onRevealInExplorer={handleRevealInExplorer}
                  />
                )
              })}
            </div>
          )}

          {/* Popup flutuante de ignore inteligente */}
          {ignorePopup && (
            <div className="cdf-ignore-popup" ref={ignorePopupRef}>
              <div className="cdf-ignore-popup-text">
                Ignorar <strong>{ignorePopup.path.split('/').pop()}</strong>
              </div>
              <div className="cdf-ignore-popup-actions">
                <button className="cdf-ignore-popup-btn" onClick={handlePopupIgnoreThis}>
                  Ignorar apenas este
                </button>
                <button className="cdf-ignore-popup-btn cdf-ignore-popup-btn-all" onClick={handlePopupIgnoreAll}>
                  Ignorar todos os *{ignorePopup.ext}
                </button>
              </div>
            </div>
          )}

          {/* Sanfona de arquivos ignorados no rodapé */}
          <div className="cdf-sidebar-footer">
            {ignoredFiles.length > 0 && (
              <details
                className="cdf-ignored-accordion"
                open={ignoredAccordionOpen}
                onToggle={(e) => setIgnoredAccordionOpen((e.target as HTMLDetailsElement).open)}
              >
                <summary className="cdf-ignored-summary">
                  <span className="cdf-ignored-title">🚫 Ignorados nesta sessão ({ignoredFiles.length})</span>
                  <button
                    className="cdf-pill-btn"
                    onClick={(e) => { e.stopPropagation(); handleRestoreAll() }}
                  >
                    Restaurar Todos
                  </button>
                </summary>
                <ul className="cdf-ignored-list">
                  {ignoredFiles.map((path) => {
                    const name = path.split('/').pop() ?? path
                    return (
                      <li key={path} className="cdf-ignored-item">
                        <span className="cdf-ignored-name" title={path}>{name}</span>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button className="cdf-icon-btn small" title="Restaurar este arquivo" onClick={() => handleRestoreFile(path)}>
                            <svg viewBox="0 0 24 24">
                              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                              <path d="M3 3v5h5" />
                            </svg>
                          </button>
                          <button className="cdf-icon-btn small" title="Promover para permanente" onClick={() => handleUpgradeToPersistent(path)}>
                            <svg viewBox="0 0 24 24">
                              <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                            </svg>
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </details>
            )}

            {persistentPatterns.length > 0 && (
              <details className="cdf-ignored-accordion">
                <summary className="cdf-ignored-summary">
                  <span className="cdf-ignored-title">🔒 Ignorados no Projeto ({persistentPatterns.length})</span>
                  <button
                    className="cdf-pill-btn"
                    onClick={(e) => { e.stopPropagation(); handleRestoreAllPersistent() }}
                  >
                    Restaurar Todos
                  </button>
                </summary>
                <ul className="cdf-ignored-list">
                  {persistentPatterns.map((pattern) => (
                    <li key={pattern} className="cdf-ignored-item">
                      <span className="cdf-ignored-name" title={pattern}>{pattern}</span>
                      <button className="cdf-icon-btn small" title="Restaurar este padrão" onClick={() => handleRestorePersistentPattern(pattern)}>
                        <svg viewBox="0 0 24 24">
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <path d="M3 3v5h5" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </aside>

        {/* Painel principal de renderização */}
        <main className="cdf-diff-panel">
          <div className="cdf-diff-actions">
            {/* Prompt customizável — salvo no localStorage */}
            <details className="cdf-prompt-details">
              <summary>Personalizar Instruções do Prompt (Opcional)</summary>
              <textarea
                className="cdf-prompt-textarea"
                value={auditPromptTemplate}
                onChange={handlePromptChange}
                rows={8}
              />
            </details>
          </div>

          <div className={`cdf-diff-code-rendered${!markdown && !isGenerating && !error ? ' empty-state' : ''}`}>
            {/* Banner de erro da geração */}
            {error && (
              <div className="error-banner">
                <span className="error-icon">❌</span>
                <div className="error-text">
                  <strong>Erro na compressão:</strong> {error}
                </div>
              </div>
            )}

            {isGenerating ? (
              <div className="cdf-empty-hero">
                <p>Gerando compressão estrutural...</p>
              </div>
            ) : markdown ? (
              <Markdown>{markdown}</Markdown>
            ) : (
              <div className="cdf-empty-hero">
                <svg viewBox="0 0 24 24" style={{ width: '48px', height: '48px', stroke: 'var(--text-secondary)', fill: 'none', strokeWidth: 1.5 }}>
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" x2="8" y1="13" y2="13" />
                  <line x1="16" x2="8" y1="17" y2="17" />
                  <line x1="10" x2="8" y1="9" y2="9" />
                </svg>
                <h3>Esqueleto Estrutural</h3>
                <p>Selecione os arquivos na sidebar para gerar a compressão.</p>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Barra de ações inferior */}
      <div className="cdf-diff-actions-bottom">
        <button className="app-pill-btn" onClick={handleCopyPrompt} disabled={!markdown}>
          {isCopied ? 'Copiado!' : 'Copiar Prompt de Auditoria'}
        </button>
        <button className="app-pill-btn" onClick={handleCopyMarkdown} disabled={!markdown}>
          {isCopyMarkdown ? 'Markdown Copiado!' : 'Copiar Markdown'}
        </button>
        <button className="app-pill-btn" onClick={handleExportObsidian} disabled={isExporting || !markdown}>
          {isExporting ? 'Exportando...' : 'Exportar para Obsidian'}
        </button>
      </div>
    </div>
  )
}