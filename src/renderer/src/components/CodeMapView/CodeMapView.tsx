import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { CodeMapElement, CodeMapFile, CodeMapRelationship, CodeMapRepository, Tag, IntegrityIssue, IntegrityCheckResult } from '../../../../shared/types'
import { CodeMapTree } from './CodeMapTree'
import { CodeMapAwarenessHeader } from './CodeMapAwarenessHeader'
import { CodeMapOverview } from './CodeMapOverview'
import { CodeMapDetailPanel } from './CodeMapDetailPanel'
import { CodeMapBreadcrumb } from './CodeMapBreadcrumb'
import { CodeMapCodeView } from './CodeMapCodeView'
import { ColumnResizer } from '../shared/ColumnResizer/ColumnResizer'
import { IntegrityCheckModal } from './IntegrityCheckModal'
import { buildFileGraph, getRelatedFileIds } from './fileRelationships'
import { EXTENSION_FILTER_KEY_PREFIX, TAG_FILTER_KEY_PREFIX, NO_EXTENSION_LABEL, extensionLabel } from './constants'
import { getContrastColor } from '../../utils/color-utils'
import { FilterPopover } from '../shared/FilterPopover/FilterPopover'
import { Button } from '../shared/Button/Button'
import { CodeMapHealth, type CodeMapIntegrityState } from './CodeMapHealth'
import { Folder, Network, FileText, RefreshCw, SearchX, FilterX, DatabaseZap, ChevronsDownUp, ChevronsUpDown, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import './CodeMapView.css'
import { normalizeProjectPath } from '../../../../shared/utils/path-utils'

/** Largura mínima em pixels que qualquer coluna pode atingir durante o arraste. */
const MIN_COLUMN_PX = 140

/** Chave base para persistência de larguras de colunas no localStorage. */
const COLUMNS_KEY_PREFIX = 'codeMap:columns:'

/** Chave base para persistência de visibilidade das colunas no localStorage. */
const COLUMNS_HIDDEN_KEY_PREFIX = 'codeMap:columns:hidden:'

const DEFAULT_SPLIT = { tree: 0.24, reading: 0.45 }

interface CodeMapViewProps {
  activeProject: { path: string; name: string } | null
  onSelectProject: (project: { path: string; name: string } | null) => void
  onStatusMessage: (message: string, isError?: boolean) => void
  onOpenTagManager?: () => void
}

export const CodeMapView: React.FC<CodeMapViewProps> = ({
  activeProject,
  onSelectProject,
  onStatusMessage,
  onOpenTagManager
}) => {
  const [files, setFiles] = useState<CodeMapFile[]>([])
  const [elements, setElements] = useState<CodeMapElement[]>([])
  const [relationships, setRelationships] = useState<CodeMapRelationship[]>([])
  const [repository, setRepository] = useState<CodeMapRepository | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [focusedElementId, setFocusedElementId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isIndexing, setIsIndexing] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const [integrityState, setIntegrityState] = useState<CodeMapIntegrityState>('unknown')
  const [healthError, setHealthError] = useState<string | null>(null)
  const [integrityModalState, setIntegrityModalState] = useState<{
    isOpen: boolean
    issues: IntegrityIssue[]
    checkResult: IntegrityCheckResult | null
  }>({ isOpen: false, issues: [], checkResult: null })
  // Colapso dos grupos do modal de integridade, persistido entre aberturas do modal
  const [integrityCollapsedGroups, setIntegrityCollapsedGroups] = useState<Set<string>>(new Set())
  const [modifiedCount, setModifiedCount] = useState(0)
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [persistedExpanded, setPersistedExpanded] = useState<Set<string>>(new Set())
  const [selectedExtensions, setSelectedExtensions] = useState<Set<string>>(new Set())
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [fileTagsMap, setFileTagsMap] = useState<Record<string, string[]>>({})
  const [fileHistory, setFileHistory] = useState<string[]>([])
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Frações das três colunas: tree, reading; code = 1 - tree - reading
  const [columnSplit, setColumnSplit] = useState(DEFAULT_SPLIT)
  // Visibilidade das colunas Explorer e Código (ocultáveis via ActionBar)
  const [isTreeHidden, setIsTreeHidden] = useState(false)
  const [isCodeHidden, setIsCodeHidden] = useState(false)
  // Ref do container de conteúdo para medir largura total durante o arraste
  const contentRef = useRef<HTMLDivElement>(null)
  // Flag para pular a primeira persistência redundante no mount
  const isFirstLoadRef = useRef(true)
  // Guard de corrida para carregamento de dados (cancela respostas obsoletas)
  const activeLoadRef = useRef(0)

  /** Teto da pilha de histórico — descarta o mais antigo quando excedido. */
  const MAX_FILE_HISTORY = 50

  // repository === null OU lastIndexedAt === null indica que o repositório nunca foi indexado
  // (ou a indexação falhou parcialmente, deixando o registro sem timestamp de conclusão)
  const neverIndexed = repository === null || repository.lastIndexedAt === null

  const loadData = useCallback(async (repoPath: string) => {
    const currentLoadId = ++activeLoadRef.current
    setIsLoading(true)
    try {
      await window.codeAwareness.openRepository(repoPath)
      if (activeLoadRef.current !== currentLoadId) return

      const [
        filesResult,
        elementsResult,
        relationshipsResult,
        countResult,
        repositoryResult,
        syncStatusResult
      ] = await Promise.all([
        window.codeAwareness.getFiles(repoPath),
        window.codeAwareness.getElements(repoPath),
        window.codeAwareness.getRelationships(repoPath),
        window.codeAwareness.getModifiedFilesCount(repoPath),
        window.codeAwareness.getRepository(repoPath),
        window.codeAwareness.getSyncStatus(repoPath)
      ])

      if (activeLoadRef.current !== currentLoadId) return

      if (filesResult.success && filesResult.data) {
        setFiles(filesResult.data)
      }
      if (elementsResult.success && elementsResult.data) {
        setElements(elementsResult.data)
      }
      if (relationshipsResult.success && relationshipsResult.data) {
        setRelationships(relationshipsResult.data)
      }
      if (countResult.success && countResult.data !== undefined) {
        setModifiedCount(countResult.data)
      }
      if (repositoryResult.success) {
        setRepository(repositoryResult.data ?? null)
      }
      if (syncStatusResult.success && syncStatusResult.data) {
        setLastSyncAt(syncStatusResult.data.lastSyncAt ?? null)
      }
    } catch (err) {
      if (activeLoadRef.current === currentLoadId) {
        onStatusMessage(`Erro ao carregar Code Map: ${err instanceof Error ? err.message : String(err)}`, true)
      }
    } finally {
      if (activeLoadRef.current === currentLoadId) {
        setIsLoading(false)
      }
    }
  }, [onStatusMessage])

  useEffect(() => {
    // Limpa seleção, histórico e elemento focado na troca de projeto
    setSelectedFileId(null)
    setFocusedElementId(null)
    setFileHistory([])
    setHealthError(null)
    setIntegrityState('unknown')
    setIntegrityModalState({ isOpen: false, issues: [], checkResult: null })
    if (!activeProject) {
      setFiles([])
      setElements([])
      setRelationships([])
      setModifiedCount(0)
      setLastSyncAt(null)
      setRepository(null)
      setIntegrityState('unknown')
      setSearchQuery('')
      return
    }

    loadData(activeProject.path)
  }, [activeProject?.path, loadData])

  // Escuta eventos em tempo real de mudança confirmada e indexação com debounce de 300ms
  useEffect(() => {
    if (!activeProject) return

    let debounceTimer: NodeJS.Timeout | null = null

    const triggerReload = (data: { repoPath: string; relativePath: string }) => {
      // Compara caminhos normalizados (barras invertidas → barras; sem barra final)
      if (normalizeProjectPath(data.repoPath) === normalizeProjectPath(activeProject.path)) {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          loadData(activeProject.path)
        }, 300)
      }
    }

    const unsubConfirmed = window.codeAwareness.onCodeMapFileConfirmed(triggerReload)
    const unsubIndexed = window.codeAwareness.onCodeMapFileIndexed(triggerReload)

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      unsubConfirmed()
      unsubIndexed()
    }
  }, [activeProject, loadData])

  // Carrega larguras de colunas persistidas ao trocar de projeto
  useEffect(() => {
    if (!activeProject) {
      setColumnSplit(DEFAULT_SPLIT)
      isFirstLoadRef.current = true
      return
    }

    const key = `${COLUMNS_KEY_PREFIX}${activeProject.path}`
    const stored = localStorage.getItem(key)
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { tree: number; reading: number }
        if (typeof parsed.tree === 'number' && typeof parsed.reading === 'number') {
          setColumnSplit(parsed)
        } else {
          setColumnSplit(DEFAULT_SPLIT)
        }
      } catch {
        setColumnSplit(DEFAULT_SPLIT)
      }
    } else {
      setColumnSplit(DEFAULT_SPLIT)
    }
  }, [activeProject])

  // Persiste larguras de colunas com debounce de 500ms
  useEffect(() => {
    if (!activeProject) return

    // Pula a primeira persistência após o load inicial
    if (isFirstLoadRef.current) {
      isFirstLoadRef.current = false
      return
    }

    const timeoutId = setTimeout(() => {
      const key = `${COLUMNS_KEY_PREFIX}${activeProject.path}`
      localStorage.setItem(key, JSON.stringify(columnSplit))
    }, 500)

    return () => clearTimeout(timeoutId)
  }, [columnSplit, activeProject])

  // Carrega expansão persistida da árvore ao trocar de projeto
  useEffect(() => {
    if (!activeProject) {
      setPersistedExpanded(new Set())
      return
    }

    const key = `codeMap:tree:expanded:${activeProject.path}`
    const stored = localStorage.getItem(key)
    if (stored) {
      try {
        const expanded = JSON.parse(stored) as string[]
        setPersistedExpanded(new Set(expanded))
      } catch {
        setPersistedExpanded(new Set())
      }
    } else {
      setPersistedExpanded(new Set())
    }
  }, [activeProject])

  // Persiste expansão da árvore com debounce de 500ms
  useEffect(() => {
    if (!activeProject) return

    const timeoutId = setTimeout(() => {
      const key = `codeMap:tree:expanded:${activeProject.path}`
      localStorage.setItem(key, JSON.stringify(Array.from(persistedExpanded)))
    }, 500)

    return () => clearTimeout(timeoutId)
  }, [persistedExpanded, activeProject])

  // Carrega extensões selecionadas do localStorage ao trocar de projeto
  useEffect(() => {
    if (!activeProject) {
      setSelectedExtensions(new Set())
      return
    }

    const key = `${EXTENSION_FILTER_KEY_PREFIX}${activeProject.path}`
    const stored = localStorage.getItem(key)
    if (stored) {
      try {
        const extensions = JSON.parse(stored) as string[]
        setSelectedExtensions(new Set(extensions))
      } catch {
        setSelectedExtensions(new Set())
      }
    } else {
      setSelectedExtensions(new Set())
    }
  }, [activeProject])

  // Persiste extensões selecionadas no localStorage
  useEffect(() => {
    if (!activeProject) return
    const key = `${EXTENSION_FILTER_KEY_PREFIX}${activeProject.path}`
    localStorage.setItem(key, JSON.stringify(Array.from(selectedExtensions)))
  }, [selectedExtensions, activeProject])

  // Carrega allTags e fileTagsMap do projeto via IPC (best-effort)
  const loadTags = useCallback(async (repoPath: string) => {
    try {
      const tagsResult = await window.codeAwareness.getTags(repoPath)
      if (tagsResult.success) setAllTags(tagsResult.data ?? [])
      const fileTagsResult = await window.codeAwareness.getFileTags(repoPath)
      if (fileTagsResult.success && fileTagsResult.data) setFileTagsMap(fileTagsResult.data)
    } catch {
      // Tags são best-effort — falha silenciosa não bloqueia o Code Map
    }
  }, [])

  // Carrega tags ao montar/trocar de projeto e mantém a sincronização via tags-changed
  useEffect(() => {
    if (!activeProject) {
      setAllTags([])
      setFileTagsMap({})
      return
    }
    loadTags(activeProject.path)
    const handleTagsChanged = () => {
      loadTags(activeProject.path)
    }
    window.addEventListener('tags-changed', handleTagsChanged)
    return () => window.removeEventListener('tags-changed', handleTagsChanged)
  }, [activeProject, loadTags])

  // Carrega as tags selecionadas no filtro a partir do localStorage ao trocar de projeto
  useEffect(() => {
    if (!activeProject) {
      setSelectedTags(new Set())
      return
    }
    const key = `${TAG_FILTER_KEY_PREFIX}${activeProject.path}`
    const stored = localStorage.getItem(key)
    if (stored) {
      try {
        const tags = JSON.parse(stored) as string[]
        setSelectedTags(new Set(tags))
      } catch {
        setSelectedTags(new Set())
      }
    } else {
      setSelectedTags(new Set())
    }
  }, [activeProject])

  // Persiste as tags selecionadas no filtro com debounce de 500ms
  useEffect(() => {
    if (!activeProject) return
    const timeoutId = setTimeout(() => {
      const key = `${TAG_FILTER_KEY_PREFIX}${activeProject.path}`
      localStorage.setItem(key, JSON.stringify(Array.from(selectedTags)))
    }, 500)
    return () => clearTimeout(timeoutId)
  }, [selectedTags, activeProject])

  // Carrega visibilidade das colunas persistida ao trocar de projeto
  useEffect(() => {
    if (!activeProject) {
      setIsTreeHidden(false)
      setIsCodeHidden(false)
      return
    }

    const key = `${COLUMNS_HIDDEN_KEY_PREFIX}${activeProject.path}`
    const stored = localStorage.getItem(key)
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { tree: boolean; code: boolean }
        setIsTreeHidden(parsed.tree === true)
        setIsCodeHidden(parsed.code === true)
      } catch {
        setIsTreeHidden(false)
        setIsCodeHidden(false)
      }
    } else {
      setIsTreeHidden(false)
      setIsCodeHidden(false)
    }
  }, [activeProject])

  // Persiste visibilidade das colunas com debounce de 500ms
  useEffect(() => {
    if (!activeProject) return

    const timeoutId = setTimeout(() => {
      const key = `${COLUMNS_HIDDEN_KEY_PREFIX}${activeProject.path}`
      localStorage.setItem(key, JSON.stringify({ tree: isTreeHidden, code: isCodeHidden }))
    }, 500)

    return () => clearTimeout(timeoutId)
  }, [isTreeHidden, isCodeHidden, activeProject])

  // Contagem de elementos por arquivo (fileId → contagem) para o chip da árvore
  const elementCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const element of elements) {
      counts.set(element.fileId, (counts.get(element.fileId) ?? 0) + 1)
    }
    return counts
  }, [elements])

  // Grafo arquivo↔arquivo derivado dos relacionamentos `imports` (módulo puro)
  const fileGraph = useMemo(() => buildFileGraph(relationships, elements, files), [relationships, elements, files])

  // Arquivos relacionados ao arquivo selecionado (importados + importadores)
  const relatedFileIds = useMemo(() => {
    if (!selectedFileId) return undefined
    return getRelatedFileIds(fileGraph, selectedFileId)
  }, [fileGraph, selectedFileId])

  // Mapa fileId → arquivo para lookup O(1) do arquivo selecionado
  const filesById = useMemo(() => {
    const map = new Map<string, CodeMapFile>()
    for (const f of files) {
      map.set(f.id, f)
    }
    return map
  }, [files])

  // Arquivo selecionado (se existir)
  const selectedFile = selectedFileId ? filesById.get(selectedFileId) ?? null : null

  // Elementos do arquivo selecionado
  const selectedFileElements = useMemo(() => {
    if (!selectedFileId) return []
    return elements.filter((e) => e.fileId === selectedFileId)
  }, [elements, selectedFileId])

  // Mapa elementId → elemento para lookup O(1) do elemento focado
  const elementsById = useMemo(() => {
    const map = new Map<string, CodeMapElement>()
    for (const e of elements) {
      map.set(e.id, e)
    }
    return map
  }, [elements])

  // Elemento focado (se existir)
  const focusedElement = useMemo(() => {
    if (!focusedElementId) return null
    return elementsById.get(focusedElementId) ?? null
  }, [elementsById, focusedElementId])

  // Filtragem aditiva por extensão: nenhum filtro = todos; seleção = união
  // BUGFIX: usa a extensão crua (file.extension) como chave — o label amigável
  // "(sem extensão)" é apenas para exibição. Antes, arquivos sem extensão (Dockerfile,
  // Makefile) usavam o label como chave no agrupamento mas a chave crua '' no filtro,
  // fazendo o filtro nunca casar e o arquivo sumir da árvore.
  const filteredByExtensions = useMemo(() => {
    if (selectedExtensions.size === 0) return files
    return files.filter((f) => selectedExtensions.has(f.extension))
  }, [files, selectedExtensions])

  // Filtragem de tags (AND): o arquivo passa se possuir TODAS as tags selecionadas.
  // Sem seleção, não filtra. Age dentro do conjunto filtrado por extensão.
  const filteredByTags = useMemo(() => {
    if (selectedTags.size === 0) return filteredByExtensions
    return filteredByExtensions.filter((f) => {
      const tags = fileTagsMap[f.relativePath] ?? []
      return Array.from(selectedTags).every((tagId) => tags.includes(tagId))
    })
  }, [filteredByExtensions, selectedTags, fileTagsMap])

  // Extensões únicas com contagem para o FilterPopover (chave crua)
  const extensionsWithCount = useMemo(() => {
    const counts = new Map<string, number>()
    for (const file of files) {
      counts.set(file.extension, (counts.get(file.extension) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([ext, count]) => ({ ext, count }))
      .sort((a, b) => b.count - a.count)
  }, [files])

  // Tags únicas em uso com contagem para o funil de filtro (somente tags de arquivos existentes)
  const tagsWithCount = useMemo(() => {
    const counts = new Map<string, number>()
    for (const file of files) {
      const tags = fileTagsMap[file.relativePath] ?? []
      for (const tagId of new Set(tags)) {
        counts.set(tagId, (counts.get(tagId) ?? 0) + 1)
      }
    }
    return allTags
      .map((tag) => ({ tag, count: counts.get(tag.id) ?? 0 }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count || a.tag.name.localeCompare(b.tag.name))
  }, [files, fileTagsMap, allTags])

  // Busca global age dentro do conjunto filtrado por extensões e tags
  const filteredData = useMemo(() => {
    if (!searchQuery.trim()) {
      return {
        files: filteredByTags,
        elements,
        expandedNodes: new Set<string>() // vazio quando sem busca
      }
    }

    const query = searchQuery.toLowerCase()
    const matchedFileIds = new Set<string>()

    // Filtrar arquivos (dentro do conjunto filtrado por extensões e tags)
    const matchedFiles = filteredByTags.filter(f => {
      const matchesName = f.relativePath.toLowerCase().includes(query)
      if (matchesName) {
        matchedFileIds.add(f.id)
      }
      return matchesName
    })

    // Filtrar elementos (apenas de arquivos no conjunto filtrado)
    const filteredFileIds = new Set(filteredByTags.map((f) => f.id))
    const matchedElements = elements.filter(e => {
      if (!filteredFileIds.has(e.fileId)) return false
      const matchesName = e.name.toLowerCase().includes(query)
      if (matchesName) {
        matchedFileIds.add(e.fileId) // Inclui o arquivo pai
      }
      return matchesName
    })

    // Deriva os ids dos diretórios ancestrais de cada arquivo casado, no formato `dir:<caminho>`
    // Lookup por Map (O(1)) — nunca find() linear em listas grandes
    const filesById = new Map<string, CodeMapFile>()
    for (const file of filteredByTags) {
      filesById.set(file.id, file)
    }

    const expandedNodes = new Set<string>()
    for (const fileId of matchedFileIds) {
      const file = filesById.get(fileId)
      if (!file) continue
      const parts = file.relativePath.split('/')
      parts.pop() // remove o nome do arquivo
      let currentPath = ''
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part
        expandedNodes.add(`dir:${currentPath}`)
      }
    }

    return {
      files: matchedFiles,
      elements: matchedElements,
      expandedNodes
    }
  }, [filteredByTags, elements, searchQuery])

  // Contagem de elementos consistente com o conjunto filtrado por extensão.
  // Quando há busca ativa, usa os elementos casados; senão soma os elementos
  // dos arquivos filtrados — evita exibir o total do repositório num escopo parcial.
  const filteredElementCount = useMemo(() => {
    if (searchQuery.trim()) return filteredData.elements.length
    let total = 0
    for (const f of filteredByTags) {
      total += elementCounts.get(f.id) ?? 0
    }
    return total
  }, [searchQuery, filteredData.elements, filteredByTags, elementCounts])

  // Contagens para o resumo da ViewToolbar
  const searchSummary = useMemo(() => {
    if (!searchQuery.trim()) return null

    const fileCount = filteredData.files.length
    const elementCount = filteredData.elements.length

    if (fileCount === 0 && elementCount === 0) {
      return 'Nenhum resultado'
    }

    const parts = []
    if (fileCount > 0) parts.push(`${fileCount} arquivo${fileCount > 1 ? 's' : ''}`)
    if (elementCount > 0) parts.push(`${elementCount} elemento${elementCount > 1 ? 's' : ''}`)

    return parts.join(' • ')
  }, [filteredData, searchQuery])

  // Atualiza o estado de expansão persistido da árvore
  const handleTreeToggle = useCallback((nodeId: string) => {
    setPersistedExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }, [])

  // Foca o input de busca global (atalho "/")
  const handleSearchFocus = useCallback(() => {
    searchInputRef.current?.focus()
  }, [])

  // Navegação central: empilha o atual no histórico (teto 50) e seleciona o novo
  const navigateToFile = useCallback((fileId: string) => {
    setSelectedFileId((current) => {
      if (current === fileId) return current

      // Empilha o arquivo atual no histórico (se existir)
      if (current) {
        setFileHistory((prev) => {
          const next = [...prev, current]
          // Teto: descarta o mais antigo se exceder o limite
          if (next.length > MAX_FILE_HISTORY) next.shift()
          return next
        })
      }

      // Limpa o elemento focado ao mudar de arquivo
      setFocusedElementId(null)

      return fileId
    })
  }, [])

  // Navega para outro arquivo pelo grafo (chips de dependência do painel)
  const handleNavigateToFile = useCallback(
    (fileId: string) => navigateToFile(fileId),
    [navigateToFile]
  )

  // Volta pelo histórico: desempilha até encontrar um arquivo que ainda existe
  const handleBack = useCallback(() => {
    setFileHistory((prev) => {
      const remaining = [...prev]
      let targetId: string | null = null
      while (remaining.length > 0) {
        const candidate = remaining.pop()!
        if (filesById.has(candidate)) {
          targetId = candidate
          break
        }
      }
      if (targetId) {
        setSelectedFileId(targetId)
        setFocusedElementId(null)
      }
      return remaining
    })
  }, [filesById])

  // Foca/limpa o elemento no painel
  const handleFocusElement = useCallback((elementId: string | null) => {
    setFocusedElementId(elementId)
  }, [])

  // Alterna uma extensão no filtro aditivo
  const handleToggleExtension = useCallback((ext: string) => {
    setSelectedExtensions((prev) => {
      const next = new Set(prev)
      if (next.has(ext)) {
        next.delete(ext)
      } else {
        next.add(ext)
      }
      return next
    })
  }, [])

  // Limpa todos os filtros de extensão
  const handleClearExtensions = useCallback(() => {
    setSelectedExtensions(new Set())
  }, [])

  // Limpa a busca
  const handleClearSearch = useCallback(() => {
    setSearchQuery('')
  }, [])

  // Alterna uma tag no filtro aditivo (OR)
  const handleToggleTagFilter = useCallback((tagId: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev)
      if (next.has(tagId)) {
        next.delete(tagId)
      } else {
        next.add(tagId)
      }
      return next
    })
  }, [])

  // Limpa todas as tags selecionadas no filtro
  const handleClearTags = useCallback(() => {
    setSelectedTags(new Set())
  }, [])

  // Todos os ids de diretórios do conjunto filtrado (para "Expandir tudo")
  const allDirectoryIds = useMemo(() => {
    const ids = new Set<string>()
    for (const file of filteredByTags) {
      const parts = file.relativePath.split('/')
      parts.pop() // remove o nome do arquivo
      let currentPath = ''
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part
        ids.add(`dir:${currentPath}`)
      }
    }
    return ids
  }, [filteredByTags])

  // Botão inteligente: colapsa quando há algo expandido; expande quando tudo está colapsado
  const handleToggleExpandAll = useCallback(() => {
    setPersistedExpanded((prev) => (prev.size > 0 ? new Set() : new Set(allDirectoryIds)))
  }, [allDirectoryIds])

  // Alterna a visibilidade da coluna Explorer
  const handleToggleTreeVisibility = useCallback(() => {
    setIsTreeHidden((prev) => !prev)
  }, [])

  // Alterna a visibilidade da coluna Código
  const handleToggleCodeVisibility = useCallback(() => {
    setIsCodeHidden((prev) => !prev)
  }, [])

  // Largura visível do painel de Detalhes: soma as frações das colunas ocultas à sua própria.
  // As frações salvas nunca são modificadas — o ocultar só deriva larguras em tempo de render.
  const visibleReadingBasis = useMemo(() => {
    let basis = columnSplit.reading
    if (isTreeHidden) basis += columnSplit.tree
    if (isCodeHidden) basis += 1 - columnSplit.tree - columnSplit.reading
    return basis
  }, [columnSplit, isTreeHidden, isCodeHidden])

  /**
   * Alça 1 — arraste entre Explorer e Detalhes.
   * Muda a fração do Explorer; redistribui o resto entre Detalhes e Código
   * na proporção atual (preserva o 50/50 se existir).
   */
  const handleDragTree = useCallback((deltaPx: number) => {
    const totalWidth = contentRef.current?.offsetWidth
    if (!totalWidth || totalWidth === 0) return

    const deltaFrac = deltaPx / totalWidth

    setColumnSplit((prev) => {
      const minFrac = MIN_COLUMN_PX / totalWidth
      const maxTree = 1 - 2 * minFrac
      const newTree = Math.max(minFrac, Math.min(maxTree, prev.tree + deltaFrac))

      // Redistribui o espaço restante entre reading e code, preservando a proporção atual
      const remaining = 1 - newTree
      const codeFrac = 1 - prev.tree - prev.reading
      const totalReadingCode = prev.reading + codeFrac
      const readingRatio = totalReadingCode > 0 ? prev.reading / totalReadingCode : 0.5
      
      const newReading = Math.max(minFrac, Math.min(remaining - minFrac, remaining * readingRatio))

      return { tree: newTree, reading: newReading }
    })
  }, [])

  /**
   * Alça 2 — arraste entre Detalhes e Código.
   * Transfere fração entre as duas colunas; tree permanece inalterada.
   */
  const handleDragReading = useCallback((deltaPx: number) => {
    const totalWidth = contentRef.current?.offsetWidth
    if (!totalWidth || totalWidth === 0) return

    const deltaFrac = deltaPx / totalWidth

    setColumnSplit((prev) => {
      const minFrac = MIN_COLUMN_PX / totalWidth
      const maxReading = 1 - prev.tree - minFrac
      const newReading = Math.max(minFrac, Math.min(maxReading, prev.reading + deltaFrac))
      return { ...prev, reading: newReading }
    })
  }, [])

  const handleVerifyIntegrity = async () => {
    if (!activeProject || isVerifying) return

    setIsVerifying(true)
    setHealthError(null)
    try {
      onStatusMessage('Verificando integridade do Code Map...', false)

      const result1 = await window.codeAwareness.verifyIntegrity(activeProject.path, {
        autoRepair: false
      })

      if (!result1.success) {
        const errorMsg = result1.error?.includes('ENOENT')
          ? 'Arquivo não encontrado durante verificação'
          : result1.error?.includes('permission')
            ? 'Sem permissão para ler arquivos do repositório'
            : `Erro na verificação: ${result1.error}`
        setHealthError(errorMsg)
        onStatusMessage(errorMsg, true)
        return
      }

      const data = result1.data
      if (!data || data.status === 'unknown' || (data.status !== 'healthy' && !data.details?.length)) {
        const message = 'Não foi possível determinar a integridade do CodeMap.'
        setHealthError(message)
        onStatusMessage(message, true)
        return
      }

      if (data.status === 'healthy') {
        setIntegrityState('healthy')
        setIntegrityModalState({ isOpen: false, issues: [], checkResult: null })
        onStatusMessage('CodeMap íntegro — Nenhuma inconsistência encontrada.', false)
        return
      }

      const issues = data.details
      setIntegrityState('issue')
      setIntegrityModalState({
        isOpen: true,
        issues,
        checkResult: data
      })

      onStatusMessage(
        `⚠️ ${issues.length} inconsistência(s) encontrada(s). Clique em "Ver detalhes" para revisar e corrigir.`,
        false
      )
    } catch (err) {
      const message = `Erro ao verificar integridade: ${err instanceof Error ? err.message : String(err)}`
      setHealthError(message)
      onStatusMessage(message, true)
    } finally {
      setIsVerifying(false)
    }
  }

  // BUGFIX: índice inexistente deixava o botão apagado. A indexação completa só roda no
  // primeiro uso; sincronização (`synchronizeModified`) é para o dia a dia. Não combinar os fluxos.
  const handleIndex = async () => {
    if (!activeProject || isIndexing) return

    setIsIndexing(true)
    setHealthError(null)
    try {
      const result = await window.codeAwareness.indexRepository(activeProject.path)
      if (result.success && result.data) {
        setIntegrityState('unknown')
        setIntegrityModalState({ isOpen: false, issues: [], checkResult: null })
        onStatusMessage(
          `${result.data.filesIndexed} arquivo(s) indexado(s) • ${result.data.elementsExtracted} elemento(s) extraído(s)`
        )
        // Recarrega dados após indexação (popula árvore e o registro do repositório)
        await loadData(activeProject.path)
      } else {
        const message = `Erro ao reconstruir índice: ${result.error ?? 'resposta inválida'}`
        setHealthError(message)
        onStatusMessage(message, true)
      }
    } catch (err) {
      const message = `Erro ao reconstruir índice: ${err instanceof Error ? err.message : String(err)}`
      setHealthError(message)
      onStatusMessage(message, true)
    } finally {
      setIsIndexing(false)
    }
  }

  if (!activeProject) {
    return (
      <div className="cmv-container">
        <div className="cmv-empty">
          <p>Selecione um projeto para visualizar o Code Map</p>
        </div>
      </div>
    )
  }

  return (
    <div className="cmv-container">
      <CodeMapAwarenessHeader
        repositoryName={repository?.name ?? activeProject.name}
        fileCount={files.length}
        elementCount={elements.length}
        modifiedCount={modifiedCount}
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchRef={searchInputRef}
        summary={searchQuery.trim() ? searchSummary ?? '' : `${filteredByTags.length} arquivos · ${filteredElementCount} elementos na visualização`}
        controls={
          <>
            <Button
              variant="ghost"
              icon={isTreeHidden ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              onClick={handleToggleTreeVisibility}
              aria-label={isTreeHidden ? 'Exibir Explorer' : 'Ocultar Explorer'}
              title={isTreeHidden ? 'Exibir Explorer' : 'Ocultar Explorer'}
            />
            <Button
              variant="ghost"
              icon={isCodeHidden ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
              onClick={handleToggleCodeVisibility}
              aria-label={isCodeHidden ? 'Exibir Código' : 'Ocultar Código'}
              title={isCodeHidden ? 'Exibir Código' : 'Ocultar Código'}
            />
          </>
        }
        health={
          neverIndexed ? (
            <Button
              variant="pill"
              icon={<RefreshCw size={16}
      />}
              onClick={handleIndex}
              disabled={isIndexing}
            >
              {isIndexing ? 'Indexando...' : 'Index CodeMap'}
            </Button>
          ) : (
            <CodeMapHealth
              key={activeProject.path}
              state={isVerifying || isIndexing ? 'updating' : healthError || integrityState === 'issue' ? 'issue' : modifiedCount > 0 ? 'pending' : 'healthy'}
              indexedAt={repository?.lastIndexedAt ?? null}
              lastSyncAt={lastSyncAt}
              modifiedCount={modifiedCount}
              integrityState={integrityState}
              integrityIssueCount={integrityModalState.issues.length}
              isVerifying={isVerifying}
              operationError={healthError}
              isRebuilding={isIndexing}
              onVerifyIntegrity={handleVerifyIntegrity}
              onShowIntegrityIssues={() => setIntegrityModalState((previous) => ({ ...previous, isOpen: true }))}
              onRebuild={handleIndex}
            />
          )
        }
      />

      {isLoading ? (
        <div className="cmv-loading">
          <p>Carregando estrutura do repositório...</p>
        </div>
      ) : (
        <div className="cmv-content" ref={contentRef}>
          {/* ── Cartão Explorer (ocultável) ──────────────────────── */}
          {!isTreeHidden && (
          <div
            className="cmv-tree-zone"
            style={{ flexBasis: `${columnSplit.tree * 100}%` }}
          >
            <header className="cmv-pane-header"><Folder size={20} aria-hidden="true" /><h2>Repository</h2><span>{filteredData.files.length} arquivos</span></header>
            <div className="cmv-explorer-bar">
              <Button
                variant="ghost"
                icon={persistedExpanded.size > 0 ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
                onClick={handleToggleExpandAll}
                aria-label={persistedExpanded.size > 0 ? 'Colapsar tudo' : 'Expandir tudo'}
                title={persistedExpanded.size > 0 ? 'Colapsar tudo' : 'Expandir tudo'}
              />
              <FilterPopover activeCount={selectedExtensions.size} closeOnSelect={false} label="Extensões">
                <div className="cmv-filter-list">
                  {extensionsWithCount.map(({ ext, count }) => (
                    <button
                      key={ext || NO_EXTENSION_LABEL}
                      className={`am-item fp-item${selectedExtensions.has(ext) ? ' active' : ''}`}
                      onClick={() => handleToggleExtension(ext)}
                    >
                      <span className="cmv-filter-ext">{extensionLabel(ext)}</span>
                      <span className="cmv-filter-count">{count}</span>
                    </button>
                  ))}
                  {selectedExtensions.size > 0 && (
                    <div className="cmv-filter-footer">
                      <button className="cmv-filter-clear" onClick={handleClearExtensions}>
                        Limpar tudo
                      </button>
                    </div>
                  )}
                </div>
              </FilterPopover>
              <FilterPopover activeCount={selectedTags.size} closeOnSelect={false} label="Tags">
                <div className="cmv-filter-list">
                  {tagsWithCount.map(({ tag, count }) => {
                    const isActive = selectedTags.has(tag.id)
                    return (
                      <button
                        key={tag.id}
                        className={`am-item fp-item${isActive ? ' active' : ''}`}
                        onClick={() => handleToggleTagFilter(tag.id)}
                        style={isActive ? { backgroundColor: tag.color, borderColor: tag.color, color: getContrastColor(tag.color) } : undefined}
                      >
                        <span className="cmv-filter-tag-dot" style={{ backgroundColor: tag.color }} />
                        <span className="cmv-filter-ext cmv-filter-tag-name">{tag.name}</span>
                        <span className="cmv-filter-count">{count}</span>
                      </button>
                    )
                  })}
                  {selectedTags.size > 0 && (
                    <div className="cmv-filter-footer">
                      <button className="cmv-filter-clear" onClick={handleClearTags}>
                        Limpar tudo
                      </button>
                    </div>
                  )}
                </div>
              </FilterPopover>
            </div>
            <div className="cmv-tree-scroll">
              {neverIndexed ? (
                <div className="cmv-empty-state">
                  <DatabaseZap size={32} className="cmv-empty-state-icon" />
                  <p className="cmv-empty-state-message">Este repositório ainda não foi indexado.</p>
                  <button
                    className="cmv-empty-state-action"
                    onClick={handleIndex}
                    disabled={isIndexing}
                  >
                    {isIndexing ? 'Indexando...' : 'Indexar Repositório'}
                  </button>
                </div>
              ) : filteredData.files.length === 0 && filteredData.elements.length === 0 ? (
                <div className="cmv-empty-state">
                  {selectedExtensions.size > 0 ? (
                    <>
                      <FilterX size={32} className="cmv-empty-state-icon" />
                      <p className="cmv-empty-state-message">
                        Nenhum arquivo encontrado para as extensões selecionadas.
                      </p>
                      <button className="cmv-empty-state-action" onClick={handleClearExtensions}>
                        Limpar filtros
                      </button>
                    </>
                  ) : selectedTags.size > 0 ? (
                    <>
                      <FilterX size={32} className="cmv-empty-state-icon" />
                      <p className="cmv-empty-state-message">
                        Nenhum arquivo encontrado para as tags selecionadas.
                      </p>
                      <button className="cmv-empty-state-action" onClick={handleClearTags}>
                        Limpar filtros
                      </button>
                    </>
                  ) : searchQuery.trim() ? (
                    <>
                      <SearchX size={32} className="cmv-empty-state-icon" />
                      <p className="cmv-empty-state-message">Nenhum resultado para a busca.</p>
                      <button className="cmv-empty-state-action" onClick={handleClearSearch}>
                        Limpar busca
                      </button>
                    </>
                  ) : (
                    <CodeMapTree
                      files={filteredData.files}
                      selectedFileId={selectedFileId}
                      onSelectFile={(file) => navigateToFile(file.id)}
                      expandedNodesOverride={filteredData.expandedNodes}
                      relatedFileIds={relatedFileIds}
                      elementCounts={elementCounts}
                      onSearchFocus={handleSearchFocus}
                      persistedExpanded={persistedExpanded}
                      onToggle={handleTreeToggle}
                    />
                  )}
                </div>
              ) : (
                <CodeMapTree
                  files={filteredData.files}
                  selectedFileId={selectedFileId}
                  onSelectFile={(file) => navigateToFile(file.id)}
                  expandedNodesOverride={filteredData.expandedNodes}
                  relatedFileIds={relatedFileIds}
                  elementCounts={elementCounts}
                  onSearchFocus={handleSearchFocus}
                  persistedExpanded={persistedExpanded}
                  onToggle={handleTreeToggle}
                />
              )}
            </div>
          </div>
          )}

          {/* ── Alça 1: Explorer | Detalhes (visível quando Explorer está visível) ── */}
          {!isTreeHidden && <ColumnResizer onDrag={handleDragTree} />}

          {/* ── Cartão Detalhes (absorve o espaço das colunas ocultas) ── */}
          <div
            className="cmv-reading-zone"
            style={{ flexBasis: `${visibleReadingBasis * 100}%` }}
          >
            <header className="cmv-pane-header cmv-pane-header--awareness"><Network size={23} aria-hidden="true" /><div><h2>Structural Awareness</h2><p>Estrutura, elementos e relacionamentos do repositório.</p></div></header>
            {selectedFile ? (
              <>
                <CodeMapBreadcrumb file={selectedFile} focusedElement={focusedElement} />
                <div className="cmv-reading-scroll">
                  <CodeMapDetailPanel
                    file={selectedFile}
                    fileGraph={fileGraph}
                    files={files}
                    elements={selectedFileElements}
                    elementsById={elementsById}
                    relationships={relationships}
                    repoPath={activeProject.path}
                    focusedElementId={focusedElementId}
                    canGoBack={fileHistory.length > 0}
                    onBack={handleBack}
                    onFocusElement={handleFocusElement}
                    onNavigateToFile={handleNavigateToFile}
                    onStatusMessage={onStatusMessage}
                    allTags={allTags}
                    fileTagsMap={fileTagsMap}
                    onTagsChanged={() => { if (activeProject.path) loadTags(activeProject.path) }}
                    onOpenTagManager={onOpenTagManager}
                  />
                </div>
              </>
            ) : (
              <div className="cmv-reading-scroll">
                <CodeMapOverview
                  repository={repository}
                  repositoryName={activeProject.name}
                  fileCount={files.length}
                  elementCount={elements.length}
                  modifiedCount={modifiedCount}
                  neverIndexed={neverIndexed}
                  lastSyncAt={lastSyncAt}
                />
              </div>
            )}
          </div>

          {/* ── Alça 2: Detalhes | Código (visível quando Código está visível) ── */}
          {!isCodeHidden && <ColumnResizer onDrag={handleDragReading} />}

          {/* ── Cartão Código (ocultável) ────────────────────────── */}
          {!isCodeHidden && (
          <div className="cmv-code-zone">
            <header className="cmv-pane-header"><FileText size={19} aria-hidden="true" /><h2>Source</h2>{selectedFile && <span title={selectedFile.relativePath}>{selectedFile.relativePath.split('/').pop()}</span>}</header>
            <div className="cmv-code-scroll">
              <CodeMapCodeView file={selectedFile} repoPath={activeProject.path} />
            </div>
          </div>
          )}
        </div>
      )}
      <IntegrityCheckModal
        isOpen={integrityModalState.isOpen}
        onClose={() => setIntegrityModalState(prev => ({ ...prev, isOpen: false }))}
        issues={integrityModalState.issues}
        repoPath={activeProject?.path || ''}
        collapsedGroups={integrityCollapsedGroups}
        onCollapsedGroupsChange={setIntegrityCollapsedGroups}
        onStatusMessage={onStatusMessage}
        checkResult={integrityModalState.checkResult ?? undefined}
        onRepairComplete={(repairResult) => {
          setIntegrityModalState({ isOpen: false, issues: [], checkResult: null })
          setIntegrityState('unknown')
          const fixed = repairResult?.issuesFixed ?? 0
          onStatusMessage(`✓ Reparação concluída — ${fixed} problema(s) corrigido(s)`, false)
          void loadData(activeProject.path)
        }}
      />
    </div>
  )
}
