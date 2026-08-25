/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerenciar o ciclo de vida do WatcherService e monitorar alterações de arquivos.
2. Gerenciar seleção de arquivos e sistema de ignore.
3. Renderizar interface de tela única com ViewToolbar + ActionBar + StatusStrip + FileCollectionView.
4. Fornecer ações de visualização de diff (PreviewModal), cópia com prompt e exportação.
5. Ordenar arquivos por recência (mtime), com arquivos deleted no final.

Mapa de Relacionamentos do Script

1. CodeDiffView.css
   - Tipo: Relação de UI
   - Relação: Consome estilos CSS do componente.
   - Criticidade: Alta

2. ViewToolbar.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Renderiza a Camada 1 com SearchBox, contagem e FilterPopover de tags.
   - Criticidade: Alta

3. ActionBar.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Renderiza a Camada 2 com botões de ação à direita.
   - Criticidade: Alta

4. FilterPopover.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Renderiza o dropdown de filtro de tags coloridas.
   - Criticidade: Média

5. StatusStrip.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Exibe faixa de feedback com status do watcher.
   - Criticidade: Média

6. FileCollectionView.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza a coleção de arquivos com seleção e alternância Grid/Dense.
   - Criticidade: Alta

7. PreviewModal.tsx
   - Tipo: Dependência Direta
   - Relação: Exibe diff semântico gerado sob demanda em modal.
   - Criticidade: Alta

8. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Define DiffFileStatus e Tag.
   - Criticidade: Alta

Invariantes do Script

1. A ordenação dos arquivos é sempre por recência (mtime descendente, com arquivos deleted no final).
   Filtros de busca e tags apenas filtram a lista — nunca alteram a ordenação.
   Esta é uma invariante de negócio.
2. Arquivos deleted devem aparecer sempre no final da lista.
3. O diff só é gerado sob demanda, via handleOpenPreview.
4. As tags devem estar sincronizadas com as outras abas via evento global tags-changed.
5. O badge de tipo de alteração só deve ser renderizado quando changeType não for undefined nem 'tracked'.
6. O botão "Visualizar Diff" deve estar desabilitado quando selectedFiles.size === 0.

--- FIM ARQUITETURA DO SCRIPT ---
*/
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { DiffFileStatus, Tag } from '../../../../shared/types'
import { ViewToolbar } from '../shared/ViewToolbar/ViewToolbar'
import { ActionBar } from '../shared/ActionBar/ActionBar'
import { FilterPopover } from '../shared/FilterPopover/FilterPopover'
import { StatusStrip } from '../shared/StatusStrip/StatusStrip'
import { FileCollectionView } from '../FileCollection/FileCollectionView'
import { PreviewModal } from '../PreviewModal/PreviewModal'
import { PromptEditorModal } from '../PromptEditorModal/PromptEditorModal'
import type { FileCardFile } from '../FileCollection/types'
import { estimateTokensFromSize } from '../../utils/token-utils'
import { getContrastColor } from '../../utils/color-utils'
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
  const [diffMarkdown, setDiffMarkdown] = useState<string>('')
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false)
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false)

  // Seleção de arquivos
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())

  // Ignorados (arquivos ocultos)
  const [ignoredFiles, setIgnoredFiles] = useState<string[]>([])

  // Token estimates: derivado de modifiedFiles via heurística Math.ceil(size/4)
  // BUGFIX: antes era useState({}) — nunca preenchido, causando tokens sempre zerados
  const tokenEstimates = useMemo(() => {
    const estimates: Record<string, number> = {}
    for (const f of modifiedFiles) {
      estimates[f.relativePath] = estimateTokensFromSize(f.size)
    }
    return estimates
  }, [modifiedFiles])

  // Formata contagem de tokens
  const formatTokenCount = useCallback((count: number): string => {
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
    return count.toString()
  }, [])

  // Filtro de busca
  const [searchQuery, setSearchQuery] = useState('')

  // Tags
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [fileTagsMap, setFileTagsMap] = useState<Record<string, string[]>>({})
  const [filterTagIds, setFilterTagIds] = useState<string[]>([])

  // Prompt de auditoria e ações de cópia/exportação
  const [auditPromptTemplate, setAuditPromptTemplate] = useState('')
  const [isCopyMarkdown, setIsCopyMarkdown] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isPromptModalOpen, setIsPromptModalOpen] = useState(false)

  // Carrega o template de prompt do localStorage
  useEffect(() => {
    const saved = localStorage.getItem('code_diff_prompt_template')
    setAuditPromptTemplate(saved ?? DEFAULT_PROMPT)
    if (!saved) localStorage.setItem('code_diff_prompt_template', DEFAULT_PROMPT)
  }, [])

  // ── Tags ───────────────────────────────────────────────────────────────────
  const loadFileTagsMap = useCallback(async () => {
    if (!activeProject?.path) {
      setFileTagsMap({})
      return
    }
    try {
      const result = await window.codeAwareness.getFileTags(activeProject.path)
      if (result.success && result.data) {
        setFileTagsMap(result.data)
      } else {
        setFileTagsMap({})
      }
    } catch (err) {
      console.error('Erro ao carregar fileTagsMap:', err)
      setFileTagsMap({})
    }
  }, [activeProject?.path])

  const loadTags = useCallback(async () => {
    if (!activeProject?.path) {
      setAllTags([])
      return
    }
    try {
      const result = await window.codeAwareness.getTags(activeProject.path)
      if (result.success && result.data) {
        setAllTags(result.data)
      } else {
        setAllTags([])
      }
    } catch (err) {
      console.error('Erro ao carregar tags:', err)
      setAllTags([])
    }
  }, [activeProject?.path])

  const refreshTagsData = useCallback(async () => {
    await Promise.all([loadTags(), loadFileTagsMap()])
  }, [loadTags, loadFileTagsMap])

  useEffect(() => {
    refreshTagsData()
  }, [refreshTagsData])

  // Escuta evento global de mudança de tags
  useEffect(() => {
    const handleTagsChanged = () => refreshTagsData()
    window.addEventListener('tags-changed', handleTagsChanged)
    return () => window.removeEventListener('tags-changed', handleTagsChanged)
  }, [refreshTagsData])

  // ── Carregamento de ignorados ─────────────────────────────────────────────
  const loadIgnoredFiles = useCallback(async () => {
    if (!activeProject) return
    const settings = await window.codeAwareness.loadSettings()
    setIgnoredFiles(settings.ignoredDiffFiles[activeProject.path] || [])
  }, [activeProject])

  useEffect(() => {
    loadIgnoredFiles()
  }, [loadIgnoredFiles])

  // ── Computados ────────────────────────────────────────────────────────────

  // Etapa 1: lista após ignore (base para contagem do summaryText)
  const ignoredSet = useMemo(() => new Set(ignoredFiles), [ignoredFiles])

  const afterIgnore = useMemo(() => {
    return modifiedFiles.filter(f => !ignoredSet.has(f.relativePath))
  }, [modifiedFiles, ignoredSet])

  // Etapa 2: lista após busca + tags + ordenação por recência
  const visibleFiles = useMemo(() => {
    // Aplica filtro de busca
    const searchFiltered = searchQuery
      ? afterIgnore.filter(f =>
          f.relativePath.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : afterIgnore

    // Aplica filtro de tags
    const tagFiltered = filterTagIds.length === 0
      ? searchFiltered
      : searchFiltered.filter(file => {
          const fileTagIds = fileTagsMap[file.relativePath] || []
          return filterTagIds.some(tagId => fileTagIds.includes(tagId))
        })

    // INVARIANTE: Ordenação por recência — active (não-deleted) primeiro, depois deleted
    const active = tagFiltered.filter(f => f.changeType !== 'deleted')
    const deleted = tagFiltered.filter(f => f.changeType === 'deleted')
    active.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    deleted.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    return [...active, ...deleted]
  }, [afterIgnore, searchQuery, filterTagIds, fileTagsMap])

  // Mapeia visibleFiles para FileCardFile[] com changeType
  const gridFiles = useMemo(() => {
    return visibleFiles.map(f => {
      const file: FileCardFile = {
        relativePath: f.relativePath,
        name: f.name,
        changeType: f.changeType,
        tokenEstimate: tokenEstimates[f.relativePath] || 0
      }
      return file
    })
  }, [visibleFiles, tokenEstimates])

  // ── Contagem para a ViewToolbar ──────────────────────────────────────────
  const summaryText = useMemo(() => {
    if (visibleFiles.length === afterIgnore.length) {
      return `${visibleFiles.length} arquivo${visibleFiles.length !== 1 ? 's' : ''}`
    }
    return `${visibleFiles.length} de ${afterIgnore.length} arquivo${afterIgnore.length !== 1 ? 's' : ''}`
  }, [visibleFiles, afterIgnore])

  // ── Status do watcher para o StatusStrip ─────────────────────────────────
  const watcherStatus = useMemo(() => {
    if (isLoading) return 'loading' as const
    if (isGitRepo === false) return 'not-git' as const
    if (isWatching) return 'watching' as const
    return null
  }, [isLoading, isGitRepo, isWatching])

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

  // ── Geração de diff sob demanda ──────────────────────────────────────────
  const handleOpenPreview = useCallback(async () => {
    if (!activeProject || selectedFiles.size === 0) return
    setIsGeneratingPreview(true)
    try {
      const selectedArray = Array.from(selectedFiles)
      const markdown = await window.codeAwareness.generateSemanticDiff(activeProject.path, selectedArray)
      setDiffMarkdown(markdown)
      setIsPreviewModalOpen(true)
    } catch (error) {
      console.error('Erro ao gerar diff:', error)
      onStatusMessage('Erro ao gerar diff', true)
    } finally {
      setIsGeneratingPreview(false)
    }
  }, [activeProject, selectedFiles, onStatusMessage])

  // ── Handlers de seleção ───────────────────────────────────────────────────
  const handleSelectionChange = useCallback((next: Set<string>) => {
    setSelectedFiles(next)
  }, [])

  const handleOpenTagManager = useCallback(() => {}, [])

  const toggleTag = useCallback((tagId: string) => {
    setFilterTagIds(prev =>
      prev.includes(tagId) ? prev.filter(id => id !== tagId) : [...prev, tagId]
    )
  }, [])

  // ── Handlers de ignore ────────────────────────────────────────────────────
  const ignoreFileTemporary = useCallback(
    async (relativePath: string) => {
      if (!activeProject) return
      setSelectedFiles(prev => {
        const next = new Set(prev)
        next.delete(relativePath)
        return next
      })
      const result = await window.codeAwareness.addIgnoredFile(activeProject.path, relativePath)
      if (result) {
        setIgnoredFiles(result.ignoredDiffFiles[activeProject.path] || [])
        onStatusMessage('Arquivo ocultado!')
      }
    },
    [activeProject, onStatusMessage]
  )

  // ── Handlers de cópia e exportação ───────────────────────────────────────
  const handlePromptSave = useCallback((prompt: string) => {
    setAuditPromptTemplate(prompt)
    localStorage.setItem('code_diff_prompt_template', prompt)
  }, [])

  const handleCopy = useCallback(() => {
    const finalPrompt = `${auditPromptTemplate}\n\n${diffMarkdown}`
    navigator.clipboard.writeText(finalPrompt)
    setIsCopyMarkdown(true)
    onStatusMessage('Prompt com diff copiado!')
    setTimeout(() => setIsCopyMarkdown(false), 2000)
  }, [auditPromptTemplate, diffMarkdown, onStatusMessage])

  const handleExportDownloads = useCallback(async () => {
    if (!activeProject || !diffMarkdown) return
    setIsExporting(true)
    try {
      // Envia o nome-base e o formato; o backend deriva a extensão (fonte única).
      const fileName = `${activeProject.name}-diff`
      const result = await window.codeAwareness.saveToDownloads(diffMarkdown, fileName, 'markdown')
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
  }, [activeProject, diffMarkdown, onStatusMessage])

  // ── Handlers para FileGrid ────────────────────────────────────────────────
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

  // ── Render quando não há projeto ativo ────────────────────────────────────
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
      {/* Camada 1: ViewToolbar com busca + contagem + funil de tags */}
      <ViewToolbar
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="Buscar por nome ou caminho..."
        summary={<span>{summaryText}</span>}
        filterSlot={
          <FilterPopover activeCount={filterTagIds.length}>
            {allTags.map(tag => {
              const isActive = filterTagIds.includes(tag.id)
              return (
                <button
                  key={tag.id}
                  className={`am-item fp-item${isActive ? ' active' : ''}`}
                  onClick={() => toggleTag(tag.id)}
                  role="menuitemcheckbox"
                  aria-checked={isActive}
                  style={isActive ? {
                    backgroundColor: tag.color,
                    borderColor: tag.color,
                    color: getContrastColor(tag.color)
                  } : undefined}
                >
                  {tag.name}
                </button>
              )
            })}
          </FilterPopover>
        }
      />

      {/* Camada 2: ActionBar com botões à direita */}
      <ActionBar
        right={
          <>
            <button
              className="app-pill-btn"
              onClick={() => setIsPromptModalOpen(true)}
            >
              Instruções do Prompt
            </button>
            <button
              className="app-pill-btn"
              onClick={handleOpenPreview}
              disabled={selectedFiles.size === 0 || isGeneratingPreview}
            >
              {isGeneratingPreview ? 'Gerando...' : 'Visualizar Diff'}
            </button>
            <button className="app-pill-btn" onClick={handleCopy}>
              {isCopyMarkdown ? 'Copiado!' : 'Copiar com Prompt'}
            </button>
            <button className="app-pill-btn" onClick={handleExportDownloads} disabled={isExporting}>
              {isExporting ? 'Exportando...' : 'Exportar'}
            </button>
          </>
        }
      />

      {/* Faixa de feedback: StatusStrip com status do watcher */}
      <StatusStrip status={watcherStatus} />

      {/* Grade de Arquivos */}
      <FileCollectionView
        files={gridFiles}
        allTags={allTags}
        fileTagsMap={fileTagsMap}
        selectedFiles={selectedFiles}
        onSelectionChange={handleSelectionChange}
        tokenEstimates={tokenEstimates}
        formatTokenCount={formatTokenCount}
        onHideFile={ignoreFileTemporary}
        onRevealInExplorer={handleRevealInExplorer}
        onCopyPath={handleCopyPath}
        onCopyName={handleCopyName}
        onOpenTagManager={handleOpenTagManager}
        onTagsChanged={refreshTagsData}
        repoPath={activeProject?.path}
      />

      {/* Modais */}
      <PreviewModal
        isOpen={isPreviewModalOpen}
        onClose={() => setIsPreviewModalOpen(false)}
        markdown={diffMarkdown}
        title="Diff Semântico"
        onExportDownloads={handleExportDownloads}
        onStatusMessage={onStatusMessage}
      />
      <PromptEditorModal
        isOpen={isPromptModalOpen}
        onClose={() => setIsPromptModalOpen(false)}
        initialPrompt={auditPromptTemplate}
        onSave={handlePromptSave}
      />
    </div>
  )
}