/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a interface da aba Code Source com layout de painéis independentes desacoplados e barra lateral retrátil.
2. Gerenciar a seleção reativa de arquivos com sistema de Ignore, seletor de formato (Markdown/XML) e contagem de tokens.
3. Monitorar alterações de arquivos em tempo real via WatcherService com debounce de 300ms.
4. Fornecer ações contextuais (Copiar, Salvar XML, Exportar Obsidian).
5. Sincronizar classificações de importância em tempo real com outras abas via evento IPC.

Mapa de Relacionamentos do Script

1. CodeSourceView.css
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

4. CodeCompressionView.tsx
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

7. ProjectSwitcher.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza o componente de seleção e alternância do projeto ativo na topbar.
   - Criticidade: Alta

Invariantes do Script

1. A sidebar deve ter largura entre 280px e 500px quando visível.
2. O resize handle deve estar sempre na borda direita da sidebar.
3. Os nomes dos arquivos nunca devem ser truncados sem ellipsis.
4. O total de tokens selecionados deve ser calculado apenas com base nos arquivos checkados.
5. A tríade arquitetural deve ser sempre atualizada junto com o código.
6. A sincronização de importância não deve afetar a seleção de arquivos (checkboxes).
7. O listener deve ser removido quando o componente desmonta para evitar memory leaks.
8. O estado de abertura da barra lateral (aberto/fechado) deve ser persistido por projeto no localStorage.

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
import { ProjectSwitcher } from '../ProjectSwitcher/ProjectSwitcher'
import './CodeSourceView.css'

interface CodeSourceViewProps {
  activeProject: { path: string; name: string } | null
  onSelectProject: (project: { path: string; name: string } | null) => void
  onStatusMessage: (message: string, isError?: boolean) => void
}

export const CodeSourceView: React.FC<CodeSourceViewProps> = ({ 
  activeProject, 
  onSelectProject, 
  onStatusMessage 
}) => {
  const [trackedFiles, setTrackedFiles] = useState<DiffFileStatus[]>([])

  // Estado de controle da abertura da barra lateral (persistido por projeto no localStorage)
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(() => {
    if (!activeProject) return true
    const saved = localStorage.getItem(`code_source_sidebar_open_${activeProject.path}`)
    return saved !== 'false'
  })

  // Sincroniza o estado de abertura da barra lateral no localStorage
  useEffect(() => {
    if (activeProject) {
      localStorage.setItem(`code_source_sidebar_open_${activeProject.path}`, isSidebarOpen.toString())
    }
  }, [isSidebarOpen, activeProject])

  // Restaura o estado da barra lateral quando o projeto ativo muda
  useEffect(() => {
    if (activeProject) {
      const saved = localStorage.getItem(`code_source_sidebar_open_${activeProject.path}`)
      setIsSidebarOpen(saved !== 'false')
    }
  }, [activeProject])

  // Checkboxes iniciam desmarcados por padrão, diferente do CodeCompressionView
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [markdown, setMarkdown] = useState<string>('')
  const [tokenCount, setTokenCount] = useState<number>(0)
  const [format, setFormat] = useState<'markdown' | 'xml'>('markdown')
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [error, setError] = useState<string>('')
  const [isCopied, setIsCopied] = useState(false)
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
    const saved = localStorage.getItem(`code_source_sidebar_width_${activeProject.path}`)
    if (saved) {
      const width = parseInt(saved, 10)
      if (width >= 280 && width <= 500) setSidebarWidth(width)
    }
  }, [activeProject])

  // Salva largura da sidebar no localStorage quando muda (não durante o arrasto)
  useEffect(() => {
    if (!activeProject || isResizing) return
    localStorage.setItem(`code_source_sidebar_width_${activeProject.path}`, sidebarWidth.toString())
  }, [sidebarWidth, activeProject, isResizing])

  // Carrega formato do localStorage
  useEffect(() => {
    if (activeProject) {
      const savedFormat = localStorage.getItem(`code_source_format_${activeProject.path}`) as 'markdown' | 'xml'
      if (savedFormat === 'markdown' || savedFormat === 'xml') {
        setFormat(savedFormat)
      } else {
        setFormat('markdown')
      }
    }
  }, [activeProject])

  const handleFormatChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newFormat = e.target.value as 'markdown' | 'xml'
    setFormat(newFormat)
    if (activeProject) {
      localStorage.setItem(`code_source_format_${activeProject.path}`, newFormat)
    }
  }

  // Carrega os arquivos ignorados das settings para o repositório atual
  const loadIgnoredFiles = useCallback(async () => {
    if (!activeProject) return
    const settings = await window.codeAwareness.loadSettings()
    const repoIgnores = settings.ignoredDiffFiles[activeProject.path]
    setIgnoredFiles(repoIgnores?.temporary || [])
    setPersistentPatterns(repoIgnores?.persistent || [])
  }, [activeProject])

  // Carrega os tracked files, inicia o watcher e escuta mudanças de arquivos
  useEffect(() => {
    let isMounted = true

    const bootstrapProject = async () => {
      if (!activeProject) {
        if (isMounted) { setTrackedFiles([]); setSelectedFiles(new Set()); setMarkdown(''); setTokenCount(0) }
        await window.codeAwareness.stopWatcher()
        return
      }
      try {
        // Inicia watcher e busca arquivos em paralelo
        const [, files] = await Promise.all([
          window.codeAwareness.startWatcher(activeProject.path),
          window.codeAwareness.getAllTrackedFiles(activeProject.path)
        ])
        if (!isMounted) return

        // Reconcilia ignores temporários ao iniciar
        const currentPaths = files.map(f => f.relativePath)
        await window.codeAwareness.reconcileIgnoredFiles(activeProject.path, currentPaths)
        if (!isMounted) return
        await loadIgnoredFiles()
        if (!isMounted) return

        setTrackedFiles(files)
        setSelectedFiles(new Set())
      } catch (err) {
        console.error('Falha ao inicializar projeto no Code Source:', err)
      }
    }

    bootstrapProject()

    // Escuta eventos do watcher: atualiza lista de arquivos ao detectar mudança
    const unsubscribe = window.codeAwareness.onFileChanged(async () => {
      if (!activeProject || !isMounted) return
      try {
        const files = await window.codeAwareness.getAllTrackedFiles(activeProject.path)
        if (!isMounted) return

        const currentPaths = files.map(f => f.relativePath)
        await window.codeAwareness.reconcileIgnoredFiles(activeProject.path, currentPaths)
        if (!isMounted) return
        await loadIgnoredFiles()
        if (!isMounted) return

        setTrackedFiles(files)
      } catch (err) {
        console.error('Falha ao atualizar lista de arquivos:', err)
      }
    })

    return () => {
      isMounted = false
      unsubscribe()
      window.codeAwareness.stopWatcher()
    }
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

  // Verifica se um arquivo casa com algum padrão persistente
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

  // Lista visível: filtra ignorados e padrões persistentes, ordenada por importância
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

  const hasNoiseFiles = useMemo(() => visibleFiles.some(f => NOISE_FILES.has(f.name)), [visibleFiles])


  // Geração reativa
  useEffect(() => {
    if (!activeProject) return

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)

    if (selectedFiles.size === 0) {
      setMarkdown('')
      setTokenCount(0)
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
        const result = await window.codeAwareness.generateCodeSource(activeProject.path, {
          selectedFiles: selectedArray,
          format
        })
        if (thisRequestId === requestIdRef.current) {
          if (result.success && result.markdown) {
            setMarkdown(result.markdown)
            setTokenCount(result.tokenCount || 0)
          } else {
            setError(result.error || 'Falha ao gerar Code Source.')
            setMarkdown('')
            setTokenCount(0)
          }
          setIsGenerating(false)
        }
      } catch (err: any) {
        if (thisRequestId === requestIdRef.current) {
          setError(err?.message || 'Falha ao gerar Code Source.')
          setIsGenerating(false)
        }
      }
    }, 300)

    return () => {
      if (debounceTimerRef.current) { clearTimeout(debounceTimerRef.current); debounceTimerRef.current = null }
    }
  }, [activeProject, selectedFiles, format])

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

  const ignoreFileTemporary = useCallback(async (relativePath: string) => {
    if (!activeProject) return
    setSelectedFiles(prev => { const next = new Set(prev); next.delete(relativePath); return next })
    const result = await window.codeAwareness.addIgnoredFile(activeProject.path, relativePath, 'temporary')
    if (result) {
      setIgnoredFiles(result.ignoredDiffFiles[activeProject.path]?.temporary || [])
      onStatusMessage('Arquivo ocultado!')
    }
  }, [activeProject, onStatusMessage])

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

  const handleHideClick = useCallback((relativePath: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const ext = relativePath.slice(relativePath.lastIndexOf('.'))
    if (COMMON_IGNORE_EXTENSIONS.has(ext)) {
      setIgnorePopup({ path: relativePath, ext })
    } else {
      ignoreFileTemporary(relativePath)
    }
  }, [ignoreFileTemporary])

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
    onStatusMessage('Arquivo revelado no sistema!')
  }, [activeProject, onStatusMessage])

  const handleHideExtension = useCallback(async (ext: string) => {
    await ignoreExtensionPersistent(`.${ext}`)
  }, [ignoreExtensionPersistent])

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
      }
    } catch (error) {
      console.error('Erro ao atualizar importância:', error)
    }
  }, [activeProject, onStatusMessage])

  // Handler para selecionar todos os arquivos críticos e altos de uma vez
  const handleSelectCriticalAndHigh = useCallback(() => {
    const criticalAndHighFiles = visibleFiles.filter(f => {
      const level = importanceMap[f.relativePath] || 'low'
      return level === 'critical' || level === 'high'
    })

    setSelectedFiles(new Set(criticalAndHighFiles.map(f => f.relativePath)))
    onStatusMessage(`${criticalAndHighFiles.length} arquivo(s) crítico(s) e alto(s) selecionado(s)!`)
  }, [visibleFiles, importanceMap, onStatusMessage])

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

  const handleUpgradeToPersistent = useCallback(async (relativePath: string) => {
    if (!activeProject) return
    await window.codeAwareness.removeIgnoredFile(activeProject.path, relativePath, 'temporary')
    await window.codeAwareness.addIgnoredFile(activeProject.path, relativePath, 'persistent')
    await loadIgnoredFiles()
    onStatusMessage('Arquivo promovido para permanente!')
  }, [activeProject, loadIgnoredFiles, onStatusMessage])

  const handleCopy = () => {
    navigator.clipboard.writeText(markdown)
    setIsCopied(true)
    const label = format === 'markdown' ? 'Markdown' : 'XML'
    onStatusMessage(`${label} copiado!`)
    setTimeout(() => setIsCopied(false), 2000)
  }

  const handleExportDownloads = async () => {
    if (!activeProject || !markdown) return
    setIsExporting(true)
    try {
      const fileName = `${activeProject.name}-source`
      const result = await window.codeAwareness.saveToDownloads(markdown, fileName)
      if (result.success) {
        onStatusMessage('Exportado para Downloads!')
      } else {
        onStatusMessage('Erro ao exportar', true)
      }
    } catch (err) {
      console.error('Falha ao exportar:', err)
      onStatusMessage('Erro ao exportar', true)
    } finally {
      setIsExporting(false)
    }
  }

  if (!activeProject) {
    return (
      <div className="cs-dropzone-wrapper">
        <div className="empty-selection-banner" style={{ border: 'none', background: 'transparent' }}>
          <h3>Nenhum projeto selecionado</h3>
          <p>Volte para a aba <strong>Projetos</strong> e ative um repositório para gerar o código fonte.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="cs-container">
      {/* Topbar global para alternância e status do projeto */}
      <div className="cs-topbar">
        <div className="cs-repo-info">
          <ProjectSwitcher activeProject={activeProject} onSelectProject={onSelectProject} />
          <span className="cs-status-badge watching">● Monitorando</span>
        </div>
      </div>

      <div className="cs-layout-wrapper">
        {/* Sidebar com lista de arquivos tracked */}
        {isSidebarOpen && (
          <aside className="cs-sidebar" ref={sidebarRef} style={{ width: sidebarWidth }}>
            {/* Resize handle na borda direita — permite arrastar para redimensionar */}
            <div
              className={`cs-sidebar-resize-handle${isResizing ? ' resizing' : ''}`}
              onMouseDown={handleResizeMouseDown}
            />
            <div className="cs-sidebar-header">
              <span className="cs-sidebar-header-left">
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
              <span className="cs-sidebar-header-right">
                {/* Dropdown unificado de ações no topo da sidebar */}
                <SidebarActions
                  classPrefix="cs"
                  hasNoiseFiles={hasNoiseFiles}
                  onSweepNoise={handleSweepNoise}
                  hasImportanceData={Object.keys(importanceMap).length > 0}
                  onSelectCriticalAndHigh={handleSelectCriticalAndHigh}
                  isClassifying={isClassifying}
                />

                <span className="cs-count-badge">{trackedFiles.length}</span>
                {totalSelectedTokens > 0 && (
                  <span className="cs-token-total" title="Total de tokens selecionados (estimativa)">
                    ≈ {formatTokenCount(totalSelectedTokens)} tokens
                  </span>
                )}
              </span>
            </div>

            {visibleFiles.length === 0 && trackedFiles.length === 0 ? (
              <p className="cs-empty-state">Nenhum arquivo encontrado.</p>
            ) : visibleFiles.length === 0 ? (
              <p className="cs-empty-state">Todos os arquivos estão ocultos.</p>
            ) : (
              // Arquivos agrupados por nível de importância
              <div className="cs-file-list">
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
                      classPrefix="cs"
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
              <div className="cs-ignore-popup" ref={ignorePopupRef}>
                <div className="cs-ignore-popup-text">
                  Ignorar <strong>{ignorePopup.path.split('/').pop()}</strong>
                </div>
                <div className="cs-ignore-popup-actions">
                  <button className="cs-ignore-popup-btn" onClick={handlePopupIgnoreThis}>
                    Ignorar apenas este
                  </button>
                  <button className="cs-ignore-popup-btn cs-ignore-popup-btn-all" onClick={handlePopupIgnoreAll}>
                    Ignorar todos os *{ignorePopup.ext}
                  </button>
                </div>
              </div>
            )}

            {/* Sanfona de arquivos ignorados no rodapé */}
            <div className="cs-sidebar-footer">
              {ignoredFiles.length > 0 && (
                <details
                  className="cs-ignored-accordion"
                  open={ignoredAccordionOpen}
                  onToggle={(e) => setIgnoredAccordionOpen((e.target as HTMLDetailsElement).open)}
                >
                  <summary className="cs-ignored-summary">
                    <span className="cs-ignored-title">🚫 Ignorados nesta sessão ({ignoredFiles.length})</span>
                    <button
                      className="cs-pill-btn"
                      onClick={(e) => { e.stopPropagation(); handleRestoreAll() }}
                    >
                      Restaurar Todos
                    </button>
                  </summary>
                  <ul className="cs-ignored-list">
                    {ignoredFiles.map((path) => {
                      const name = path.split('/').pop() ?? path
                      return (
                        <li key={path} className="cs-ignored-item">
                          <span className="cs-ignored-name" title={path}>{name}</span>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button className="cs-icon-btn small" title="Restaurar este arquivo" onClick={() => handleRestoreFile(path)}>
                              <svg viewBox="0 0 24 24">
                                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                                <path d="M3 3v5h5" />
                              </svg>
                            </button>
                            <button className="cs-icon-btn small" title="Promover para permanente" onClick={() => handleUpgradeToPersistent(path)}>
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
                <details className="cs-ignored-accordion">
                  <summary className="cs-ignored-summary">
                    <span className="cs-ignored-title">🔒 Ignorados no Projeto ({persistentPatterns.length})</span>
                    <button
                      className="cs-pill-btn"
                      onClick={(e) => { e.stopPropagation(); handleRestoreAllPersistent() }}
                    >
                      Restaurar Todos
                    </button>
                  </summary>
                  <ul className="cs-ignored-list">
                    {persistentPatterns.map((pattern) => (
                      <li key={pattern} className="cs-ignored-item">
                        <span className="cs-ignored-name" title={pattern}>{pattern}</span>
                        <button className="cs-icon-btn small" title="Restaurar este padrão" onClick={() => handleRestorePersistentPattern(pattern)}>
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
        )}

        {/* Painel principal de renderização */}
        <main className="cs-diff-panel">
          {/* Cabeçalho do painel principal */}
          <div className="cs-panel-header">
            <div className="cs-panel-header-left">
              <button
                className={`cs-sidebar-toggle-btn ${!isSidebarOpen ? 'sidebar-closed' : ''}`}
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                title={isSidebarOpen ? 'Ocultar barra lateral' : 'Mostrar barra lateral'}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              </button>
            </div>

            <div className="cs-panel-header-right">
              <div className="cs-format-container">
                <label htmlFor="format-select" className="cs-format-label">Formato:</label>
                <select
                  id="format-select"
                  value={format}
                  onChange={handleFormatChange}
                  className="cs-format-select"
                >
                  <option value="markdown">Markdown</option>
                  <option value="xml">XML</option>
                </select>
              </div>

              <button className="app-pill-btn" onClick={handleCopy} disabled={!markdown || isGenerating}>
                {isCopied ? 'Copiado!' : 'Copiar'}
              </button>
              <button className="app-pill-btn" onClick={handleExportDownloads} disabled={!markdown || isGenerating || isExporting}>
                {isExporting ? 'Exportando...' : 'Exportar'}
              </button>
            </div>
          </div>

          {/* Contagem de Tokens secundária */}
          <div className="cs-token-bar">
            <strong>Total estimado: {tokenCount > 0 ? tokenCount.toLocaleString('pt-BR') : '0'} tokens</strong>
            <span style={{ opacity: 0.3 }}>|</span>
            <span>{selectedFiles.size} arquivo(s) selecionado(s)</span>
          </div>

          <div className={`cs-diff-code-rendered${!markdown && !isGenerating && !error ? ' empty-state' : ''}`}>
            {error && (
              <div className="error-banner">
                <span className="error-icon">❌</span>
                <div className="error-text">
                  <strong>Erro:</strong> {error}
                </div>
              </div>
            )}

            {isGenerating ? (
              <div className="cs-empty-hero">
                <p>Gerando código fonte...</p>
              </div>
            ) : markdown ? (
              format === 'markdown' ? <Markdown>{markdown}</Markdown> : <pre className="cs-xml-code"><code>{markdown}</code></pre>
            ) : (
              <div className="cs-empty-hero">
                <svg viewBox="0 0 24 24" style={{ width: '48px', height: '48px', stroke: 'var(--text-secondary)', fill: 'none', strokeWidth: 1.5 }}>
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" x2="8" y1="13" y2="13" />
                  <line x1="16" x2="8" y1="17" y2="17" />
                  <line x1="10" x2="8" y1="9" y2="9" />
                </svg>
                <h3>Código Fonte</h3>
                <p>Selecione os arquivos na sidebar para gerar o Markdown ou XML.</p>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}