/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a interface da aba Code Compression com layout ViewToolbar + ActionBar + FileCollectionView.
2. Gerenciar a seleção reativa de arquivos com sistema de Ignore.
3. Delegar a geração, preview, cópia e exportação da saída de compressão ao OutputModal
   e expor uma ActionBar com dois botões: "Instruções do Prompt" e "Gerar Saída".
4. Sincronizar tags e arquivos ignorados com outras abas via eventos globais e IPC.
5. Exibir contador de selecionados no resumo do topo e toggle "Selecionados no topo" na ViewToolbar.
6. O sistema de ignore opera exclusivamente com caminhos exatos de arquivos.

Mapa de Relacionamentos do Script

1. CodeCompressionView.css
   - Tipo: Relação de UI
   - Relação: Consome estilos CSS do componente.
   - Criticidade: Alta

2. ViewToolbar.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Renderiza a Camada 1 com SearchBox, contagem, controlsSlot e FilterPopover de tags.
   - Criticidade: Alta

3. ActionBar.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Renderiza a Camada 2 com botões de ação à direita.
   - Criticidade: Alta

4. FilterPopover.tsx (shared)
   - Tipo: Dependência Direta
   - Relação: Renderiza o dropdown de filtro de tags coloridas.
   - Criticidade: Média

5. FileCollectionView.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza a coleção de arquivos com seleção, alternância Grid/Dense e estimativa de tokens.
   - Criticidade: Alta

6. OutputModal.tsx
   - Tipo: Dependência Direta
   - Relação: Gerencia visualmente a preview, cópia, exportação e a geração reativa da saída de compressão.
   - Criticidade: Alta

7. TagManagerModal.tsx
   - Tipo: Dependência Direta
   - Relação: Gerencia criação, edição e associação de tags.
   - Criticidade: Alta

8. PromptEditorModal.tsx
   - Tipo: Dependência Direta
   - Relação: Edita o prompt de auditoria customizável.
   - Criticidade: Alta

9. ignore-patterns.ts
   - Tipo: Dependência Direta
   - Relação: Fornece padrões de ruído.
   - Criticidade: Média

Invariantes do Script

1. O FileGrid deve ocupar 100% do espaço disponível no painel principal.
2. O total de tokens selecionados deve ser calculado apenas com base nos arquivos checkados.
3. A geração, cópia e exportação do markdown é exclusiva do OutputModal (com debounce e stale protection internos).
4. O prompt de auditoria deve ser persistido no localStorage.
5. Tags e arquivos ignorados devem ser sincronizados com outras abas via eventos globais.
6. O listener de tags-changed deve ser removido quando o componente desmonta.
7. O sistema de ignore opera exclusivamente com caminhos exatos de arquivos.
8. A ViewToolbar substitui a CommandBar — nenhuma referência a command-bar no JSX.
9. O toggle "Selecionados no topo" é estado local (não persiste ao trocar de projeto).
10. A reordenação por seleção é puramente visual e não afeta a geração de markdown.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { DiffFileStatus, Tag } from '../../../../shared/types'
import { FileText, PenLine, ArrowUpNarrowWide } from 'lucide-react'
import { ViewToolbar } from '../shared/ViewToolbar/ViewToolbar'
import { ActionBar } from '../shared/ActionBar/ActionBar'
import { FilterPopover } from '../shared/FilterPopover/FilterPopover'
import { FileCollectionView } from '../FileCollection/FileCollectionView'
import { TagManagerModal } from '../TagManagerModal/TagManagerModal'
import { PromptEditorModal } from '../PromptEditorModal/PromptEditorModal'
import { OutputModal } from './OutputModal'
import type { FileCardFile } from '../FileCollection/types'
import { estimateTokensFromSize } from '../../utils/token-utils'
import { getContrastColor } from '../../utils/color-utils'
import './CodeCompressionView.css'

// Tipos para API de ignore simplificada
type IgnoredResult = { ignoredDiffFiles: Record<string, string[]> } | null

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
  onSelectProject: (project: { path: string; name: string } | null) => void
  onStatusMessage: (message: string, isError?: boolean) => void
}

export const CodeCompressionView: React.FC<CodeCompressionViewProps> = ({ 
  activeProject, 
  onSelectProject, 
  onStatusMessage 
}) => {
  const [trackedFiles, setTrackedFiles] = useState<DiffFileStatus[]>([])
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [isOutputModalOpen, setIsOutputModalOpen] = useState(false)
  const [auditPromptTemplate, setAuditPromptTemplate] = useState('')
  const [selectedOnTop, setSelectedOnTop] = useState(false)

  // Reseta o toggle ao trocar de projeto
  useEffect(() => {
    setSelectedOnTop(false)
  }, [activeProject?.path])

  const tokenEstimates = useMemo(() => {
    const estimates: Record<string, number> = {};
    for (const f of trackedFiles) {
      estimates[f.relativePath] = estimateTokensFromSize(f.size);
    }
    return estimates;
  }, [trackedFiles]);

   // Ignore system (apenas caminhos exatos de arquivos)
   const [ignoredFiles, setIgnoredFiles] = useState<string[]>([])

  // Modais
  const [isTagManagerOpen, setIsTagManagerOpen] = useState(false)
  const [isPromptModalOpen, setIsPromptModalOpen] = useState(false)

  // Tags
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [fileTagsMap, setFileTagsMap] = useState<Record<string, string[]>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [filterTagIds, setFilterTagIds] = useState<string[]>([])

  // Formata contagem de tokens para exibição amigável (ex: 1234 → "1.2k")
  const formatTokenCount = useCallback((count: number): string => {
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}k`
    }
    return count.toString()
  }, [])

  // Carrega os arquivos ignorados das settings para o repositório atual
  const loadIgnoredFiles = useCallback(async () => {
    if (!activeProject) return
    const settings = await window.codeAwareness.loadSettings()
    setIgnoredFiles(settings.ignoredDiffFiles[activeProject.path] || [])
  }, [activeProject])

  // Carrega fileTagsMap do projeto ativo
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

  // Carrega os tracked files e reseta seleção ao trocar de projeto
  useEffect(() => {
    let isMounted = true
    const fetchFiles = async () => {
      if (!activeProject) {
        if (isMounted) { setTrackedFiles([]); setSelectedFiles(new Set()) }
        return
      }
      try {
        const files = await window.codeAwareness.getAllFiles(activeProject.path)
        if (isMounted) { setTrackedFiles(files); setSelectedFiles(new Set()) }
      } catch (err) {
        console.error('Falha ao carregar tracked files:', err)
      }
    }
    fetchFiles()
    loadIgnoredFiles()
    return () => { isMounted = false }
  }, [activeProject, loadIgnoredFiles])

  // Carrega fileTagsMap ao montar ou trocar de projeto
  useEffect(() => {
    loadFileTagsMap()
  }, [loadFileTagsMap])

  // Recarrega arquivos e ignores quando o modal de ignore global sinalizar atualização
  useEffect(() => {
    if (!activeProject) return
    const handleUpdate = async () => {
      await Promise.all([
        window.codeAwareness.reconcileIgnoredFiles(activeProject.path, (await window.codeAwareness.getAllFiles(activeProject.path)).map(f => f.relativePath)),
        loadIgnoredFiles(),
      ])
      const files = await window.codeAwareness.getAllFiles(activeProject.path)
      setTrackedFiles(files)
    }
    window.addEventListener('ignored-files-updated', handleUpdate)
    return () => window.removeEventListener('ignored-files-updated', handleUpdate)
  }, [activeProject, loadIgnoredFiles])

  // Carrega o template do prompt do localStorage
  useEffect(() => {
    const saved = localStorage.getItem('code_compression_prompt_template')
    setAuditPromptTemplate(saved ?? DEFAULT_COMPRESSION_PROMPT)
    if (!saved) {
      localStorage.setItem('code_compression_prompt_template', DEFAULT_COMPRESSION_PROMPT)
    }
  }, [])



  // Lista visível: filtra arquivos ignorados e ordena alfabeticamente por caminho
  const ignoredSet = useMemo(() => new Set(ignoredFiles), [ignoredFiles])

  const visibleFiles = useMemo(() => {
    return trackedFiles
      .filter(f => !ignoredSet.has(f.relativePath))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  }, [trackedFiles, ignoredSet])

  // Ignora arquivo e remove da seleção
  const ignoreFileTemporary = useCallback(async (relativePath: string) => {
    if (!activeProject) return
    setSelectedFiles(prev => { const next = new Set(prev); next.delete(relativePath); return next })
    const result = await window.codeAwareness.addIgnoredFile(activeProject.path, relativePath) as IgnoredResult
    if (result) {
      loadIgnoredFiles()
      onStatusMessage('Arquivo ocultado!')
    }
  }, [activeProject, onStatusMessage, loadIgnoredFiles])

  // Handlers para FileCard
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

  // ─── Tags ────────────────────────────────────────────────────────────────

  // Carrega tags do projeto ativo
  const loadTags = useCallback(async () => {
    if (!activeProject?.path) {
      setAllTags([])
      return
    }
    try {
      const response = await window.codeAwareness.getTags(activeProject.path)
      if (response.success && response.data) {
        setAllTags(response.data)
      } else {
        setAllTags([])
      }
    } catch (err) {
      console.error('Erro ao carregar tags:', err)
      setAllTags([])
    }
  }, [activeProject?.path])

  // Recarrega ambos os estados de tags após mudanças no TagManagerModal
  const refreshTagsData = useCallback(async () => {
    await loadTags()
    await loadFileTagsMap()
  }, [loadTags, loadFileTagsMap])

  // Escuta evento global de mudança de tags
  useEffect(() => {
    const handleTagsChanged = async () => {
      await refreshTagsData()
    }
    window.addEventListener('tags-changed', handleTagsChanged)
    return () => window.removeEventListener('tags-changed', handleTagsChanged)
  }, [refreshTagsData])

  useEffect(() => {
    loadTags()
  }, [loadTags])

  // ─── Filtros ─────────────────────────────────────────────────────────────

  const toggleTag = useCallback((tagId: string) => {
    setFilterTagIds(prev =>
      prev.includes(tagId) ? prev.filter(id => id !== tagId) : [...prev, tagId]
    )
  }, [])

  const handleSelectionChange = useCallback((next: Set<string>) => {
    setSelectedFiles(next)
  }, [])

  // Filtro por nome/caminho e tags
  const filteredFiles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()

    return visibleFiles.filter((file) => {
      const matchesQuery =
        !q ||
        file.name.toLowerCase().includes(q) ||
        file.relativePath.toLowerCase().includes(q)

      const matchesTags =
        filterTagIds.length === 0 ||
        filterTagIds.some((tagId) => {
          const fileTagIds = fileTagsMap[file.relativePath] || []
          return fileTagIds.includes(tagId)
        })

      return matchesQuery && matchesTags
    })
  }, [visibleFiles, searchQuery, filterTagIds, fileTagsMap])

  // Memo 1 — mapeamento (só recalcula quando arquivos ou estimativas mudam)
  const mappedFiles: FileCardFile[] = useMemo(() => {
    return filteredFiles.map((f) => ({
      ...f,
      tokenEstimate: tokenEstimates[f.relativePath] || 0,
    }))
  }, [filteredFiles, tokenEstimates])

  // Memo 2 — reordenação por seleção (só recalcula quando seleção ou toggle muda)
  const fileCardFiles: FileCardFile[] = useMemo(() => {
    if (selectedOnTop) {
      const selected: FileCardFile[] = []
      const notSelected: FileCardFile[] = []
      for (const f of mappedFiles) {
        if (selectedFiles.has(f.relativePath)) {
          selected.push(f)
        } else {
          notSelected.push(f)
        }
      }
      return [...selected, ...notSelected]
    }
    return mappedFiles
  }, [mappedFiles, selectedOnTop, selectedFiles])

  // ─── Contagem para a ViewToolbar ────────────────────────────────────────
  const summaryText = useMemo(() => {
    const base = filteredFiles.length === visibleFiles.length
      ? `${visibleFiles.length} arquivo${visibleFiles.length !== 1 ? 's' : ''}`
      : `${filteredFiles.length} de ${visibleFiles.length} arquivo${visibleFiles.length !== 1 ? 's' : ''}`
    if (selectedFiles.size > 0) {
      return `✓ ${selectedFiles.size} selecionado${selectedFiles.size !== 1 ? 's' : ''} · ${base}`
    }
    return base
  }, [visibleFiles, filteredFiles, selectedFiles])

  // ─── Prompt Editor Modal ─────────────────────────────────────────────────

  // Handler para salvar o prompt via modal (delegate para o pai persistir no localStorage)
  const handlePromptSave = useCallback((newPrompt: string) => {
    setAuditPromptTemplate(newPrompt)
    localStorage.setItem('code_compression_prompt_template', newPrompt)
  }, [])
// ─── Output Modal ───────────────────────────────────────────────────────
  // Convierte el Set de selección a un array estable (useMemo preserva la referencia)
  // para que el OutputModal no regenere el preview en re-renders sin relación.
  const outputModalFiles = useMemo(() => Array.from(selectedFiles), [selectedFiles])

  const handleOpenOutputModal = useCallback(() => setIsOutputModalOpen(true), [])
  const handleCloseOutputModal = useCallback(() => setIsOutputModalOpen(false), [])
  const handleOpenTagManager = useCallback(() => setIsTagManagerOpen(true), [])

  if (!activeProject) {
    return (
      <div className="cc-dropzone-wrapper">
        <div className="empty-selection-banner" style={{ border: 'none', background: 'transparent' }}>
          <h3>Nenhum projeto selecionado</h3>
          <p>Volte para a aba <strong>Projetos</strong> e ative um repositório para comprimir arquivos.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="cc-container">
      {/* Camada 1: ViewToolbar com busca + contagem + toggle + funil de tags */}
      <ViewToolbar
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="Buscar por nome ou caminho..."
        summary={<span>{summaryText}</span>}
        controlsSlot={
          <button
            className={`app-pill-btn cc-sort-toggle${selectedOnTop ? ' active' : ''}`}
            onClick={() => setSelectedOnTop(prev => !prev)}
            title="Selecionados no topo"
            aria-pressed={selectedOnTop}
          >
            <ArrowUpNarrowWide size={14} strokeWidth={2} />
            Selecionados no topo
          </button>
        }
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
            <button className="app-ghost-btn" onClick={() => setIsPromptModalOpen(true)}>
              <PenLine size={14} strokeWidth={2} />
              Instruções do Prompt
            </button>

            <button className="app-pill-btn" onClick={handleOpenOutputModal}>
              <FileText size={14} strokeWidth={2} />
              Gerar Saída
            </button>
          </>
        }
      />

      <FileCollectionView
        files={fileCardFiles}
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

      <OutputModal
        isOpen={isOutputModalOpen}
        onClose={handleCloseOutputModal}
        repoPath={activeProject.path}
        selectedFiles={outputModalFiles}
        onStatusMessage={onStatusMessage}
      />

      <PromptEditorModal
        isOpen={isPromptModalOpen}
        onClose={() => setIsPromptModalOpen(false)}
        initialPrompt={auditPromptTemplate}
        onSave={handlePromptSave}
      />

      {isTagManagerOpen && activeProject && (
        <TagManagerModal
          repoPath={activeProject.path}
          onClose={() => setIsTagManagerOpen(false)}
          onTagsChanged={refreshTagsData}
        />
      )}
    </div>
  )
}