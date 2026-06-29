/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerenciar o ciclo de vida do WatcherService e monitorar alterações de arquivos.
2. Renderizar a interface com topbar global (ProjectSwitcher + badges), sidebar retrátil e painel de diff semântico.
3. Gerenciar seleção de arquivos e sistema de ignore (temporary/persistent).
4. Classificar arquivos por importância arquitetural com override manual.
5. Suportar ordenação por importância ou recência com persistência em localStorage.
6. Exibir badges de tipo (M/A/D) e badges de importância por arquivo, agrupados por nível.
7. Sidebar retrátil com persistência no localStorage por projeto.
8. Sidebar redimensionável entre 280px e 500px.
9. Copiar (diff + prompt) e Exportar (diff apenas) como ações no cabeçalho do painel principal; copiar diff semântico de um único arquivo selecionado na sidebar.
10. Sincronizar classificações de importância em tempo real com outras abas via evento IPC.

Mapa de Relacionamentos do Script

1. CodeDiffView.css
   - Tipo: Relação de UI
   - Relação: Consome estilos CSS do componente.
   - Criticidade: Alta

2. ImportanceGroup.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza grupos colapsáveis por nível de importância com badges M/A/D.
   - Criticidade: Alta

3. ActionsDropdown.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza dropdown de ações contextuais para cada arquivo no modo recência.
   - Criticidade: Média

4. ToggleSwitch.tsx
   - Tipo: Dependência Direta
   - Relação: Usado como master toggle de seleção no cabeçalho da sidebar.
   - Criticidade: Média

5. SidebarActions.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza dropdown unificado de ações com toggle de ordenação.
   - Criticidade: Alta

6. ProjectSwitcher.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza dropdown de troca de projeto ativo na topbar.
   - Criticidade: Alta

7. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Define DiffFileStatus, ImportanceLevel e ImportanceSource.
   - Criticidade: Alta

8. ignore-patterns.ts
   - Tipo: Dependência Direta
   - Relação: Fornece padrões de ruído e extensões ignoradas.
   - Criticidade: Média

9. window.codeAwareness.onImportanceUpdated
   - Tipo: Comunicação por Evento
   - Relação: Escuta eventos de atualização de importância emitidos por outras abas.
   - Criticidade: Alta

Invariantes do Script

1. A sidebar deve ter largura entre 280px e 500px.
2. As badges de tipo (M/A/D) devem ser preservadas para todos os arquivos.
3. O diff só é regenerado via pipeline reativo com debounce.
4. Erros de classificação não devem impedir a renderização da lista.
5. A preferência de ordenação deve ser persistida por projeto no localStorage.
6. Deleted devem aparecer sempre no final da lista, independente do modo de ordenação.
7. A sincronização de importância não deve afetar a seleção de arquivos (checkboxes).
8. O listener deve ser removido quando o componente desmonta para evitar memory leaks.
9. No modo recência, a lista deve ser plana (sem agrupamentos), mantendo a mesma estrutura visual do modo importância.
10. No modo importância, grupos vazios não devem ser renderizados.
11. O estado de abertura da sidebar deve ser persistido por projeto no localStorage.
12. A topbar deve exibir o ProjectSwitcher e badges de status; a sidebar é condicional com base em isSidebarOpen.
13. A lógica interna da sidebar (ordenamento, ImportanceGroup, SidebarActions) nunca deve ser alterada.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Markdown from 'markdown-to-jsx'
import { DiffFileStatus, ImportanceLevel, ImportanceSource } from '../../../../shared/types'
import { NOISE_FILES, COMMON_IGNORE_EXTENSIONS } from '../../constants/ignore-patterns'
import { ImportanceGroup } from '../ImportanceGroup/ImportanceGroup'
import { ActionsDropdown } from '../ActionsDropdown/ActionsDropdown'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import { SidebarActions } from '../SidebarActions/SidebarActions'
import { ProjectSwitcher } from '../ProjectSwitcher/ProjectSwitcher'
import './CodeDiffView.css'

const DEFAULT_PROMPT = `Analise as alterações de código abaixo como um Engenheiro de Software Staff extremamente rigoroso.

Seu papel é auditar o trabalho realizado pelo agente de implementação e validar se a tarefa foi cumprida de forma íntegra, segura e profissional.

Instruções da sua auditoria:
1. Avalie se os requisitos parecem ter sido completamente atendidos com base nas modificações apresentadas.
2. Identifique mentiras ou omissões (se o agente disse que fez algo, mas o diff mostra que ele não alterou as linhas necessárias).
3. Procure por bugs ocultos, problemas de lógica, quebras de arquitetura ou caminhos inacabados.
4. Identifique "code smells" ou soluções provisórias de baixa qualidade (gambiarras).
5. Forneça um veredito direto: "APROVADO" ou "REPROVADO COM AJUSTES" acompanhado de uma lista clara e numerada do que precisa ser corrigido (caso necessário).

Abaixo está o mapeamento semântico das funções alteradas:
--------------------------------------------------`

export const CodeDiffView: React.FC<{
  activeProject: { path: string; name: string } | null
  onSelectProject: (project: { path: string; name: string } | null) => void
  onStatusMessage: (message: string, isError?: boolean) => void
}> = ({ activeProject, onSelectProject, onStatusMessage }) => {
  const [isWatching, setIsWatching] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null)
  const [modifiedFiles, setModifiedFiles] = useState<DiffFileStatus[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diffMarkdown, setDiffMarkdown] = useState<string>('')
  const [auditPromptTemplate, setAuditPromptTemplate] = useState('')
  const [isCopyMarkdown, setIsCopyMarkdown] = useState(false)
  const [isExporting, setIsExporting] = useState(false)

  // Seleção de arquivos para o diff
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())

  // Ignorados temporários (sessão) e persistentes (projeto)
  const [ignoredFiles, setIgnoredFiles] = useState<string[]>([])
  const [persistentPatterns, setPersistentPatterns] = useState<string[]>([])
  const [ignoredAccordionOpen, setIgnoredAccordionOpen] = useState(false)

  // Popup de ignore inteligente: { path, ext } | null
  const [ignorePopup, setIgnorePopup] = useState<{ path: string; ext: string } | null>(null)

  // Feedback visual de cópia unitária
  const [copiedFile, setCopiedFile] = useState<string | null>(null)

  // ── Importância Arquitetural ──────────────────────────────────────────────
  const [importanceMap, setImportanceMap] = useState<Record<string, ImportanceLevel>>({})
  const [importanceSource, setImportanceSource] = useState<Record<string, ImportanceSource>>({})
  const [tokenEstimates, setTokenEstimates] = useState<Record<string, number>>({})
  const [isClassifying, setIsClassifying] = useState(false)

  // ── Sidebar retrátil (persistida no localStorage) ─────────────────────────
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(() => {
    if (!activeProject) return true
    const saved = localStorage.getItem(`code_diff_sidebar_open_${activeProject.path}`)
    return saved !== 'false'
  })

  // Sincroniza o estado de abertura da barra lateral no localStorage
  useEffect(() => {
    if (activeProject) {
      localStorage.setItem(`code_diff_sidebar_open_${activeProject.path}`, isSidebarOpen.toString())
    }
  }, [isSidebarOpen, activeProject])

  // Restaura o estado da barra lateral quando o projeto ativo muda
  useEffect(() => {
    if (activeProject) {
      const saved = localStorage.getItem(`code_diff_sidebar_open_${activeProject.path}`)
      setIsSidebarOpen(saved !== 'false')
    }
  }, [activeProject])

  // ── Sidebar redimensionável ───────────────────────────────────────────────
  const sidebarRef = useRef<HTMLDivElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState(450)
  const [isResizing, setIsResizing] = useState(false)

  // Refs auxiliares
  const ignorePopupRef = useRef<HTMLDivElement>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)

  // ── Resize da sidebar ─────────────────────────────────────────────────────
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

    const handleMouseUp = () => setIsResizing(false)

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // Carrega largura da sidebar do localStorage
  useEffect(() => {
    if (!activeProject) return
    const saved = localStorage.getItem(`code_diff_sidebar_width_${activeProject.path}`)
    if (saved) {
      const width = parseInt(saved, 10)
      if (width >= 280 && width <= 500) {
        setSidebarWidth(width)
      }
    }
  }, [activeProject])

  // Salva largura da sidebar no localStorage quando muda
  useEffect(() => {
    if (!activeProject || isResizing) return
    localStorage.setItem(`code_diff_sidebar_width_${activeProject.path}`, sidebarWidth.toString())
  }, [sidebarWidth, activeProject, isResizing])

  // ── Ordenação por Data de Modificação / Recência ──────────────────────────
  const [sortMode, setSortMode] = useState<'importance' | 'recent'>('importance')

  useEffect(() => {
    if (!activeProject) return
    const saved = localStorage.getItem(`code_diff_sort_mode_${activeProject.path}`)
    if (saved === 'importance' || saved === 'recent') {
      setSortMode(saved)
    } else {
      setSortMode('importance')
    }
  }, [activeProject])

  const handleSortModeChange = useCallback((mode: 'importance' | 'recent') => {
    setSortMode(mode)
    if (activeProject) {
      localStorage.setItem(`code_diff_sort_mode_${activeProject.path}`, mode)
    }
    onStatusMessage(mode === 'importance' ? 'Ordenação por importância!' : 'Ordenação por recência!')
  }, [activeProject, onStatusMessage])

  // ── Classificação de importância ──────────────────────────────────────────
  useEffect(() => {
    if (!activeProject) return

    const handleImportanceUpdated = (data: {
      repoPath: string
      relativePath: string
      level: ImportanceLevel
      source: ImportanceSource
    }) => {
      if (data.repoPath !== activeProject.path) return
      setImportanceMap(prev => ({ ...prev, [data.relativePath]: data.level }))
      setImportanceSource(prev => ({ ...prev, [data.relativePath]: data.source }))
    }

    window.codeAwareness.onImportanceUpdated(handleImportanceUpdated)
    return () => {
      window.codeAwareness.removeImportanceUpdatedListener()
    }
  }, [activeProject])

  useEffect(() => {
    if (!activeProject || modifiedFiles.length === 0) {
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
          modifiedFiles.map(f => ({ relativePath: f.relativePath }))
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
        }
      } catch (error) {
        console.error('Erro ao classificar importância:', error)
      } finally {
        setIsClassifying(false)
      }
    }

    classifyFiles()
  }, [activeProject, modifiedFiles])

  const formatTokenCount = useCallback((count: number): string => {
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
    return count.toString()
  }, [])

  const handleImportanceChange = useCallback(
    async (relativePath: string, newLevel: ImportanceLevel) => {
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
    },
    [activeProject, onStatusMessage]
  )

  // ── Carregamento de ignorados ─────────────────────────────────────────────
  const loadIgnoredFiles = useCallback(async () => {
    if (!activeProject) return
    const settings = await window.codeAwareness.loadSettings()
    const repoIgnores = settings.ignoredDiffFiles[activeProject.path]
    setIgnoredFiles(repoIgnores?.temporary || [])
    setPersistentPatterns(repoIgnores?.persistent || [])
  }, [activeProject])

  useEffect(() => {
    const saved = localStorage.getItem('code_diff_prompt_template')
    setAuditPromptTemplate(saved ?? DEFAULT_PROMPT)
    if (!saved) localStorage.setItem('code_diff_prompt_template', DEFAULT_PROMPT)
  }, [])

  useEffect(() => {
    loadIgnoredFiles()
  }, [loadIgnoredFiles])

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

  // ── Computados ────────────────────────────────────────────────────────────
  const matchesPersistentPattern = useCallback(
    (relativePath: string): boolean => {
      for (const pattern of persistentPatterns) {
        if (pattern.startsWith('*.')) {
          const ext = pattern.slice(1)
          if (relativePath.endsWith(ext)) return true
        }
        if (pattern === relativePath) return true
      }
      return false
    },
    [persistentPatterns]
  )

  // Lista filtrada e ordenada (importância vs recência)
  const visibleFiles = useMemo(() => {
    const filtered = modifiedFiles.filter(f => {
      if (ignoredFiles.includes(f.relativePath)) return false
      if (matchesPersistentPattern(f.relativePath)) return false
      return true
    })

    if (sortMode === 'recent') {
      const active = filtered.filter(f => f.changeType !== 'deleted')
      const deleted = filtered.filter(f => f.changeType === 'deleted')
      active.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
      deleted.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      return [...active, ...deleted]
    } else {
      const importanceOrder: Record<string, number> = {
        critical: 0,
        bridge: 4,
        high: 1,
        medium: 2,
        low: 3
      }

      return filtered.sort((a, b) => {
        const levelA = importanceMap[a.relativePath] || 'low'
        const levelB = importanceMap[b.relativePath] || 'low'
        const orderDiff = (importanceOrder[levelA] ?? 3) - (importanceOrder[levelB] ?? 3)
        if (orderDiff === 0) {
          return a.relativePath.localeCompare(b.relativePath)
        }
        return orderDiff
      })
    }
  }, [modifiedFiles, ignoredFiles, matchesPersistentPattern, importanceMap, sortMode])

  const groupedFiles = useMemo(
    () => ({
      critical: visibleFiles.filter(f => (importanceMap[f.relativePath] || 'low') === 'critical'),
      high: visibleFiles.filter(f => (importanceMap[f.relativePath] || 'low') === 'high'),
      medium: visibleFiles.filter(f => (importanceMap[f.relativePath] || 'low') === 'medium'),
      low: visibleFiles.filter(f => (importanceMap[f.relativePath] || 'low') === 'low')
    }),
    [visibleFiles, importanceMap]
  )

  const changeTypeMap = useMemo(() => {
    const map: Record<string, 'modified' | 'added' | 'deleted' | 'tracked'> = {}
    for (const f of modifiedFiles) {
      map[f.relativePath] = f.changeType
    }
    return map
  }, [modifiedFiles])

  const totalSelectedTokens = useMemo(() => {
    let total = 0
    for (const path of selectedFiles) {
      total += tokenEstimates[path] || 0
    }
    return total
  }, [selectedFiles, tokenEstimates])

  const hasNoiseFiles = useMemo(() => visibleFiles.some(f => NOISE_FILES.has(f.name)), [visibleFiles])

  // ── Efeitos de sincronização ──────────────────────────────────────────────
  useEffect(() => {
    const currentPaths = new Set(visibleFiles.map(f => f.relativePath))
    setSelectedFiles(prev => {
      const next = new Set<string>()
      for (const path of prev) {
        if (currentPaths.has(path)) next.add(path)
      }
      return next
    })
  }, [visibleFiles])

  // Pipeline reativo: gera diff com debounce de 200ms ao mudar seleção
  useEffect(() => {
    if (!activeProject) return
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)

    if (selectedFiles.size === 0) {
      const name = modifiedFiles.length > 0 ? `\`${activeProject.name}\`` : ''
      setDiffMarkdown(
        `# Nenhum arquivo selecionado\n\n${name ? `*Nenhuma alteração de ${name} será incluída.*` : ''}`
      )
      return
    }

    const thisRequestId = ++requestIdRef.current
    debounceTimerRef.current = setTimeout(async () => {
      const selectedArray = Array.from(selectedFiles)
      const markdown = await window.codeAwareness.generateSemanticDiff(activeProject.path, selectedArray)
      if (thisRequestId === requestIdRef.current) {
        setDiffMarkdown(markdown)
      }
    }, 200)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [activeProject, selectedFiles, modifiedFiles.length])

  // ── Handlers de seleção ───────────────────────────────────────────────────
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

  const handleSelectCriticalAndHigh = useCallback(() => {
    const targets = visibleFiles.filter(f => {
      const level = importanceMap[f.relativePath] || 'low'
      return level === 'critical' || level === 'high'
    })
    setSelectedFiles(new Set(targets.map(f => f.relativePath)))
    onStatusMessage(`${targets.length} arquivo(s) crítico(s) e alto(s) selecionado(s)!`)
  }, [visibleFiles, importanceMap, onStatusMessage])

  // ── Handlers de ignore ────────────────────────────────────────────────────
  const ignoreFileTemporary = useCallback(
    async (relativePath: string) => {
      if (!activeProject) return
      setSelectedFiles(prev => {
        const next = new Set(prev)
        next.delete(relativePath)
        return next
      })
      const result = await window.codeAwareness.addIgnoredFile(activeProject.path, relativePath, 'temporary')
      if (result) {
        const repoIgnores = result.ignoredDiffFiles[activeProject.path]
        setIgnoredFiles(repoIgnores?.temporary || [])
        onStatusMessage('Arquivo ocultado!')
      }
    },
    [activeProject, onStatusMessage]
  )

  const ignoreExtensionPersistent = useCallback(
    async (ext: string) => {
      if (!activeProject) return
      const pattern = `*${ext}`
      setSelectedFiles(prev => {
        const next = new Set(prev)
        for (const path of modifiedFiles) {
          if (path.relativePath.endsWith(ext) && !ignoredFiles.includes(path.relativePath)) {
            next.delete(path.relativePath)
          }
        }
        return next
      })
      const result = await window.codeAwareness.addIgnoredFile(activeProject.path, pattern, 'persistent')
      if (result) {
        const repoIgnores = result.ignoredDiffFiles[activeProject.path]
        setPersistentPatterns(repoIgnores?.persistent || [])
        onStatusMessage(`Padrão ${pattern} ignorado permanentemente!`)
      }
    },
    [activeProject, modifiedFiles, ignoredFiles, onStatusMessage]
  )

  const handleHideClick = useCallback(
    (relativePath: string, e: React.MouseEvent) => {
      e.stopPropagation()
      const ext = relativePath.slice(relativePath.lastIndexOf('.'))
      if (COMMON_IGNORE_EXTENSIONS.has(ext)) {
        setIgnorePopup({ path: relativePath, ext })
      } else {
        ignoreFileTemporary(relativePath)
      }
    },
    [ignoreFileTemporary]
  )

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

  const handleSweepNoise = useCallback(async () => {
    if (!activeProject) return
    const noiseToIgnore = visibleFiles.filter(f => NOISE_FILES.has(f.name))
    for (const file of noiseToIgnore) {
      await window.codeAwareness.addIgnoredFile(activeProject.path, file.relativePath, 'temporary')
    }
    setSelectedFiles(prev => {
      const next = new Set(prev)
      for (const file of noiseToIgnore) next.delete(file.relativePath)
      return next
    })
    await loadIgnoredFiles()
    onStatusMessage(`${noiseToIgnore.length} arquivo(s) de ruído ignorado(s)!`)
  }, [activeProject, visibleFiles, loadIgnoredFiles, onStatusMessage])

  // ── Handlers de restauração ───────────────────────────────────────────────
  const handleRestoreFile = useCallback(
    async (relativePath: string) => {
      if (!activeProject) return
      const result = await window.codeAwareness.removeIgnoredFile(activeProject.path, relativePath, 'temporary')
      if (result) {
        const repoIgnores = result.ignoredDiffFiles[activeProject.path]
        setIgnoredFiles(repoIgnores?.temporary || [])
        onStatusMessage('Arquivo restaurado!')
      }
      setSelectedFiles(prev => new Set([...prev, relativePath]))
    },
    [activeProject, onStatusMessage]
  )

  const handleRestoreAll = useCallback(async () => {
    if (!activeProject) return
    const count = ignoredFiles.length
    for (const path of ignoredFiles) {
      await window.codeAwareness.removeIgnoredFile(activeProject.path, path, 'temporary')
    }
    await loadIgnoredFiles()
    setSelectedFiles(prev => new Set([...prev, ...ignoredFiles]))
    onStatusMessage(`${count} arquivo(s) restaurado(s)!`)
  }, [activeProject, ignoredFiles, loadIgnoredFiles, onStatusMessage])

  const handleRestorePersistentPattern = useCallback(
    async (pattern: string) => {
      if (!activeProject) return
      const result = await window.codeAwareness.removeIgnoredFile(activeProject.path, pattern, 'persistent')
      if (result) {
        const repoIgnores = result.ignoredDiffFiles[activeProject.path]
        setPersistentPatterns(repoIgnores?.persistent || [])
        onStatusMessage('Padrão restaurado!')
      }
    },
    [activeProject, onStatusMessage]
  )

  const handleRestoreAllPersistent = useCallback(async () => {
    if (!activeProject) return
    const count = persistentPatterns.length
    for (const pattern of persistentPatterns) {
      await window.codeAwareness.removeIgnoredFile(activeProject.path, pattern, 'persistent')
    }
    await loadIgnoredFiles()
    onStatusMessage(`${count} padrão(ões) restaurado(s)!`)
  }, [activeProject, persistentPatterns, loadIgnoredFiles, onStatusMessage])

  const handleUpgradeToPersistent = useCallback(
    async (relativePath: string) => {
      if (!activeProject) return
      await window.codeAwareness.removeIgnoredFile(activeProject.path, relativePath, 'temporary')
      await window.codeAwareness.addIgnoredFile(activeProject.path, relativePath, 'persistent')
      await loadIgnoredFiles()
      onStatusMessage('Arquivo promovido para permanente!')
    },
    [activeProject, loadIgnoredFiles, onStatusMessage]
  )

  // ── Handlers para ActionsDropdown ─────────────────────────────────────────
  const handleCopyPath = useCallback(
    (relativePath: string) => {
      navigator.clipboard.writeText(relativePath)
      onStatusMessage('Caminho copiado!')
    },
    [onStatusMessage]
  )

  const handleCopyName = useCallback(
    (name: string) => {
      navigator.clipboard.writeText(name)
      onStatusMessage('Nome copiado!')
    },
    [onStatusMessage]
  )

  const handleRevealInExplorer = useCallback(
    async (relativePath: string) => {
      if (!activeProject) return
      await window.codeAwareness.revealInExplorer(activeProject.path, relativePath)
      onStatusMessage('Arquivo revelado no sistema!')
    },
    [activeProject, onStatusMessage]
  )

  const handleHideExtension = useCallback(
    async (ext: string) => {
      await ignoreExtensionPersistent(`.${ext}`)
    },
    [ignoreExtensionPersistent]
  )

  // ── Handlers de cópia e exportação ───────────────────────────────────────
  const handleCopySingleFileDiff = useCallback(
    async (relativePath: string, e: React.MouseEvent) => {
      e.stopPropagation()
      if (!activeProject) return

      let markdown = await window.codeAwareness.generateSemanticDiff(activeProject.path, [relativePath])

      const fileHeaderPattern = new RegExp(
        `^## 📄 \`${relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``,
        'm'
      )
      const match = markdown.match(fileHeaderPattern)

      if (match && match.index !== undefined) {
        const afterMatch = markdown.substring(match.index)
        const nextFileMatch = afterMatch.match(/\n## 📄 /)
        markdown =
          nextFileMatch?.index !== undefined
            ? afterMatch.substring(0, nextFileMatch.index).trim()
            : afterMatch.trim()
      }

      await navigator.clipboard.writeText(markdown)
      setCopiedFile(relativePath)
      onStatusMessage('Diff do arquivo copiado!')
      setTimeout(() => setCopiedFile(null), 1500)
    },
    [activeProject, onStatusMessage]
  )

  // ── Watcher do projeto ────────────────────────────────────────────────────
  useEffect(() => {
    let isMounted = true

    const bootstrapProject = async () => {
      if (!activeProject) {
        if (isMounted) {
          setModifiedFiles([])
          setDiffMarkdown('')
          setIsGitRepo(null)
          setIsWatching(false)
          setSelectedFile(null)
        }
        await window.codeAwareness.stopWatcher()
        return
      }

      setIsLoading(true)
      try {
        const isGit = await window.codeAwareness.checkRepository(activeProject.path)
        if (!isMounted) return
        setIsGitRepo(isGit)

        if (!isGit) {
          setIsWatching(false)
          return
        }

        const [, files] = await Promise.all([
          window.codeAwareness.startWatcher(activeProject.path),
          window.codeAwareness.getModifiedFiles(activeProject.path)
        ])

        if (!isMounted) return

        const currentPaths = files.map(f => f.relativePath)
        await window.codeAwareness.reconcileIgnoredFiles(activeProject.path, currentPaths)
        if (!isMounted) return
        await loadIgnoredFiles()
        if (!isMounted) return

        setModifiedFiles(files)
        setIsWatching(true)
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    bootstrapProject()

    const unsubscribe = window.codeAwareness.onFileChanged(async () => {
      if (!activeProject || !isMounted) return
      const files = await window.codeAwareness.getModifiedFiles(activeProject.path)
      if (!isMounted) return

      const currentPaths = files.map(f => f.relativePath)
      await window.codeAwareness.reconcileIgnoredFiles(activeProject.path, currentPaths)
      if (!isMounted) return
      await loadIgnoredFiles()
      if (!isMounted) return

      setModifiedFiles(files)
    })

    return () => {
      isMounted = false
      unsubscribe()
      window.codeAwareness.stopWatcher()
    }
  }, [activeProject])

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newVal = e.target.value
    setAuditPromptTemplate(newVal)
    localStorage.setItem('code_diff_prompt_template', newVal)
  }

  const handleCopy = () => {
    const finalPrompt = `${auditPromptTemplate}\n\n${diffMarkdown}`
    navigator.clipboard.writeText(finalPrompt)
    setIsCopyMarkdown(true)
    onStatusMessage('Prompt com diff copiado!')
    setTimeout(() => setIsCopyMarkdown(false), 2000)
  }

  const handleExportDownloads = async () => {
    if (!activeProject || !diffMarkdown) return
    setIsExporting(true)
    try {
      const fileName = `${activeProject.name}-diff`
      const result = await window.codeAwareness.saveToDownloads(diffMarkdown, fileName)
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

  const handleFileClick = (relativePath: string) => {
    setSelectedFile(relativePath)
    setTimeout(() => {
      const headings = document.querySelectorAll('.cdf-diff-code-rendered h2')
      for (const heading of headings) {
        if (heading.textContent?.includes(relativePath)) {
          heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
          break
        }
      }
    }, 50)
  }


  if (!activeProject) {
    return (
      <div className="cdf-dropzone-wrapper">
        <div className="empty-selection-banner" style={{ border: 'none', background: 'transparent' }}>
          <h3>Nenhum projeto selecionado</h3>
          <p>
            Volte para a aba <strong>Projetos</strong> e ative um repositório para inspecionar e
            monitorar alterações de código.
          </p>
        </div>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="cdf-container">
      <div className="cdf-topbar">
        <div className="cdf-repo-info">
          <ProjectSwitcher activeProject={activeProject} onSelectProject={onSelectProject} />
          {isLoading && <span className="cdf-status-badge loading">carregando...</span>}
          {!isLoading && isWatching && <span className="cdf-status-badge watching">● Monitorando</span>}
          {!isLoading && isGitRepo === false && (
            <span className="cdf-status-badge error">Não é um repositório Git</span>
          )}
        </div>
      </div>

      <div className="cdf-layout-wrapper">
        {/* ── Sidebar ─────────────────────────────────────────────────────── */}
        {isSidebarOpen && (
        <aside className="cdf-sidebar" ref={sidebarRef} style={{ width: sidebarWidth }}>
          {/* Handle de resize */}
          <div
            className={`cdf-sidebar-resize-handle${isResizing ? ' resizing' : ''}`}
            onMouseDown={handleResizeMouseDown}
          />

          <div className="cdf-sidebar-header">
            <span className="cdf-sidebar-header-left">
              {/* Toggle circular — substitui o checkbox tradicional */}
              {visibleFiles.length > 0 && (
                <ToggleSwitch
                  checked={selectedFiles.size === visibleFiles.length && visibleFiles.length > 0}
                  onChange={toggleMasterCheckbox}
                  indeterminate={selectedFiles.size > 0 && selectedFiles.size < visibleFiles.length}
                />
              )}
              <span>Arquivos alterados</span>
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
                sortMode={sortMode}
                onSortModeChange={handleSortModeChange}
              />

              {totalSelectedTokens > 0 && (
                <span className="cdf-token-total" title="Total de tokens selecionados (estimativa)">
                  ≈ {formatTokenCount(totalSelectedTokens)} tokens
                </span>
              )}
              <span className="cdf-count-badge">{modifiedFiles.length}</span>
            </span>
          </div>

          {modifiedFiles.length === 0 ? (
            <p className="cdf-empty-state">
              {isGitRepo === false
                ? 'O diretório não é um repositório Git.'
                : 'Nenhuma alteração detectada ainda.'}
            </p>
          ) : visibleFiles.length === 0 ? (
            <p className="cdf-empty-state">Todos os arquivos estão ocultos.</p>
          ) : sortMode === 'importance' ? (
            // Modo importância: renderiza com agrupamentos por nível
            <div className="cdf-file-list">
              {(['critical', 'high', 'medium', 'low'] as const).map(level => {
                const levelLabels = {
                  critical: 'Críticos',
                  high: 'Altos',
                  medium: 'Médios',
                  low: 'Baixos'
                }
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
                    changeTypeMap={changeTypeMap}
                    onFileClick={handleFileClick}
                    selectedFile={selectedFile}
                    onCopySingleFileDiff={handleCopySingleFileDiff}
                    copiedFile={copiedFile}
                  />
                )
              })}
            </div>
          ) : (
            // Modo recência: lista plana usando ImportanceGroup sem cabeçalho
            <div className="cdf-file-list">
              <ImportanceGroup
                level="low"
                files={visibleFiles}
                emoji=""
                label=""
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
                changeTypeMap={changeTypeMap}
                onFileClick={handleFileClick}
                selectedFile={selectedFile}
                onCopySingleFileDiff={handleCopySingleFileDiff}
                copiedFile={copiedFile}
              />
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
                <button
                  className="cdf-ignore-popup-btn cdf-ignore-popup-btn-all"
                  onClick={handlePopupIgnoreAll}
                >
                  Ignorar todos os *{ignorePopup.ext}
                </button>
              </div>
            </div>
          )}

          {/* Sanfona de arquivos ignorados (Temporários e Permanentes) */}
          <div className="cdf-sidebar-footer">
            {ignoredFiles.length > 0 && (
              <details
                className="cdf-ignored-accordion"
                open={ignoredAccordionOpen}
                onToggle={e => setIgnoredAccordionOpen((e.target as HTMLDetailsElement).open)}
              >
                <summary className="cdf-ignored-summary">
                  <span className="cdf-ignored-title">🚫 Ignorados nesta sessão ({ignoredFiles.length})</span>
                  <button
                    className="cdf-pill-btn"
                    title="Restaurar todos os arquivos ignorados nesta sessão"
                    onClick={e => {
                      e.stopPropagation()
                      handleRestoreAll()
                    }}
                  >
                    Restaurar Todos
                  </button>
                </summary>
                <ul className="cdf-ignored-list">
                  {ignoredFiles.map(path => {
                    const name = path.split('/').pop() ?? path
                    return (
                      <li key={path} className="cdf-ignored-item">
                        <span className="cdf-ignored-name" title={path}>
                          {name}
                        </span>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button
                            className="cdf-icon-btn small"
                            title="Restaurar este arquivo"
                            onClick={() => handleRestoreFile(path)}
                          >
                            <svg viewBox="0 0 24 24">
                              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                              <path d="M3 3v5h5" />
                            </svg>
                          </button>
                          <button
                            className="cdf-icon-btn small"
                            title="Promover para permanente"
                            onClick={() => handleUpgradeToPersistent(path)}
                          >
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
                  <span className="cdf-ignored-title">
                    🔒 Ignorados no Projeto ({persistentPatterns.length})
                  </span>
                  <button
                    className="cdf-pill-btn"
                    title="Restaurar todos os padrões persistentes"
                    onClick={e => {
                      e.stopPropagation()
                      handleRestoreAllPersistent()
                    }}
                  >
                    Restaurar Todos
                  </button>
                </summary>
                <ul className="cdf-ignored-list">
                  {persistentPatterns.map(pattern => (
                    <li key={pattern} className="cdf-ignored-item">
                      <span className="cdf-ignored-name" title={pattern}>
                        {pattern}
                      </span>
                      <button
                        className="cdf-icon-btn small"
                        title="Restaurar este padrão"
                        onClick={() => handleRestorePersistentPattern(pattern)}
                      >
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

        {/* ── Painel de diff ───────────────────────────────────────────────── */}
        {modifiedFiles.length === 0 ? (
          <main className="cdf-diff-panel empty-state">
            <div className="cdf-empty-hero">
              <svg
                viewBox="0 0 24 24"
                style={{
                  width: '48px',
                  height: '48px',
                  stroke: 'var(--text-secondary)',
                  fill: 'none',
                  strokeWidth: 1.5,
                  margin: '0 auto 16px auto',
                  display: 'block'
                }}
              >
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <h3>Aguardando modificações...</h3>
              <p>
                A pasta ativa está sendo monitorada. Salve alterações no repositório para inspecionar
                os blocos semânticos e realizar a auditoria.
              </p>
            </div>
          </main>
        ) : (
          <main className="cdf-diff-panel">
            {/* Cabeçalho do painel principal */}
            <div className="cdf-panel-header">
              <div className="cdf-panel-header-left">
                <button
                  className={`cdf-sidebar-toggle-btn ${!isSidebarOpen ? 'sidebar-closed' : ''}`}
                  onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                  title={isSidebarOpen ? 'Ocultar barra lateral' : 'Mostrar barra lateral'}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="9" y1="3" x2="9" y2="21" />
                  </svg>
                </button>
              </div>

              <div className="cdf-panel-header-right">
                <details className="cdf-prompt-details">
                  <summary>Instruções do Prompt</summary>
                  <textarea
                    className="cdf-prompt-textarea"
                    value={auditPromptTemplate}
                    onChange={handlePromptChange}
                    rows={6}
                  />
                </details>

                <button className="app-pill-btn" onClick={handleCopy}>
                  {isCopyMarkdown ? 'Copiado!' : 'Copiar'}
                </button>
                <button className="app-pill-btn" onClick={handleExportDownloads} disabled={isExporting}>
                  {isExporting ? 'Exportando...' : 'Exportar'}
                </button>
              </div>
            </div>

            <div
              className={`cdf-diff-code-rendered${!diffMarkdown || diffMarkdown.startsWith('# Nenhum') ? ' empty-state' : ''}`}
            >
              <Markdown>{diffMarkdown}</Markdown>
            </div>
          </main>
        )}
      </div>
    </div>
  )
}