/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a aba Code Checkpoints com layout de 2 colunas (Timeline + Detalhes).
2. Gerenciar a listagem de checkpoints do repositório ativo via IPC.
3. Fornecer modal de criação de checkpoint com nome customizável e estratégia de snapshot.
4. Auto-criar checkpoint "🏁 Início" ao abrir a aba pela primeira vez sem checkpoints existentes.
5. Exibir detalhes do checkpoint selecionado (data, contagem de arquivos, estratégia).
6. Renderizar preview do diff semântico no painel direito com ações de copiar e exportar.
7. Fornecer prompt de auditoria customizável com persistência em localStorage.
8. Implementar ações destrutivas (Restaurar, Excluir) com modais de confirmação.
9. Exibir badges de importância arquitetural na lista de arquivos do preview do diff.
10. Fornecer funcionalidade de renomear checkpoint com ícone de caneta nos detalhes.
11. Exibir métricas do checkpoint (arquivos e tokens do diff) calculadas ao selecionar checkpoint.
12. Gerenciar estado de seleção de arquivos para filtrar quais entram no preview do diff.
13. Carregar lista de arquivos alterados via getCheckpointChangedFiles ao selecionar checkpoint.
14. Calcular e exibir contagem de tokens do Semantic Diff gerado.

Mapa de Relacionamentos do Script

1. CodeCheckpointsView.css
   - Tipo: Relação de UI
   - Relação: Consome estilos CSS do componente.
   - Criticidade: Alta

2. ../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Consome CheckpointData, CheckpointSummary e CheckpointDiffFile para tipagem.
   - Criticidade: Alta

3. window.codeAwareness.createCheckpoint
   - Tipo: Dependência Inversa
   - Relação: Invoca API IPC para criar novo checkpoint.
   - Criticidade: Alta

4. window.codeAwareness.listCheckpoints
   - Tipo: Dependência Inversa
   - Relação: Invoca API IPC para listar checkpoints do repositório.
   - Criticidade: Alta

5. window.codeAwareness.generateCheckpointDiff
   - Tipo: Dependência Inversa
   - Relação: Invoca API IPC para gerar diff entre checkpoint e estado atual/outro checkpoint.
   - Criticidade: Alta

6. window.codeAwareness.saveToDownloads
   - Tipo: Dependência Inversa
   - Relação: Invoca API IPC para exportar Markdown para pasta Downloads.
   - Criticidade: Média

7. window.codeAwareness.restoreCheckpoint
   - Tipo: Dependência Inversa
   - Relação: Invoca API IPC para restaurar arquivos do checkpoint.
   - Criticidade: Alta

8. ProjectSwitcher.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza o seletor de projetos no topo da aba.
   - Criticidade: Média

9. ImportanceBadge.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza badge de importância na lista de arquivos.
   - Criticidade: Média

10. ToggleSwitch.tsx
    - Tipo: Dependência Direta
    - Relação: Renderiza ToggleSwitch interativo para filtrar arquivos no preview.
    - Criticidade: Média

11. window.codeAwareness.getCheckpointChangedFiles
    - Tipo: Dependência Inversa
    - Relação: Invoca API IPC para carregar lista de arquivos alterados.
    - Criticidade: Alta

Invariantes do Script

1. A timeline deve exibir checkpoints ordenados por createdAt descendente (mais recente no topo).
2. O checkpoint "🏁 Início" deve ser criado automaticamente apenas se não houver nenhum checkpoint, com proteção contra race condition.
3. O modal de criação deve validar que o nome não esteja vazio antes de submeter.
4. O estado selectedCheckpointId deve ser resetado ao trocar de projeto antes do carregamento.
5. O listener de listagem deve ser re-executado ao trocar de projeto ativo.
6. O botão "Criar Checkpoint" deve estar desabilitado durante o processo de criação.
7. O modal de criação deve fechar ao pressionar ESC.
8. O preview deve ser renderizado usando o componente Markdown (markdown-to-jsx) para paridade visual com as outras abas.
9. O estado previewMarkdown deve ser resetado ao trocar de projeto ou de checkpoint selecionado.
10. O prompt de auditoria deve ser persistido por projeto no localStorage.
11. Modais de confirmação devem ser exibidos antes de ações destrutivas (Restaurar, Excluir).
12. O botão "Restaurar" deve estar desabilitado durante a restauração.
13. O ícone de caneta deve aparecer apenas nos detalhes do checkpoint, não na timeline.
14. O modal de renomear deve validar que o novo nome não esteja vazio.
15. Após renomear com sucesso, a lista de checkpoints deve ser recarregada.
16. Todos os arquivos do snapshot começam com ToggleSwitch ligado (selecionados para preview).
17. O preview do diff só deve ser gerado se houver ao menos um arquivo selecionado.
18. A lista de arquivos deve exibir badges de importância usando o componente ImportanceBadge.
19. A contagem de tokens do diff deve ser calculada ao selecionar checkpoint usando estimativa baseada nos hunks.
20. A contagem de tokens deve ser recalculada quando a seleção de arquivos muda.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import Markdown from 'markdown-to-jsx'
import { CheckpointData, CheckpointSummary, CheckpointDiffFile, FileImportance, ImportanceLevel, ImportanceSource } from '../../../../shared/types'
import { ProjectSwitcher } from '../ProjectSwitcher/ProjectSwitcher'
import { ImportanceBadge } from '../ImportanceBadge/ImportanceBadge'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import './CodeCheckpointsView.css'

const CHANGE_TYPE_LABEL: Record<'modified' | 'added' | 'deleted', string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D'
}

interface CodeCheckpointsViewProps {
  activeProject: { path: string; name: string } | null
  onSelectProject: (project: { path: string; name: string } | null) => void
  onStatusMessage: (message: string, isError?: boolean) => void
}

interface FileListItem {
  path: string
  name: string  // basename do arquivo
  changeType: 'modified' | 'added' | 'deleted'
  importance: ImportanceLevel
  source: ImportanceSource
}

interface CheckpointDetailsProps {
  checkpoint: CheckpointSummary | undefined
  checkpointData: CheckpointData | null  // Dados completos para métricas
  fileList: FileListItem[]               // Lista de arquivos com importância
  totalTokens: number
  diffTokenCount: number                 // Contagem de tokens do diff gerado (0 se não gerado)
  selectedFilePaths: Set<string>         // Arquivos selecionados para preview
  onToggleFile: (path: string) => void   // Handler de toggle
  onPreview: () => void
  onCopy: () => void
  onRestore: () => void
  onDelete: () => void
  onRename: () => void
  isCopying: boolean
  isGeneratingPreview: boolean
  previewError: string
  checkpoints: CheckpointSummary[]
  selectedCheckpointId: string | null
  compareWithCheckpointId: string | null
  onCompareWithChange: (id: string | null) => void
  auditPrompt: string
  onPromptChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
}

/**
 * Calcula estimativa de tokens de uma string.
 * Usa a heurística: 1 token ≈ 4 caracteres (média para código-fonte).
 */
const calculateTokens = (content: string): number => {
  return Math.ceil(content.length / 4)
}

/**
 * Estima tokens do diff baseado nos arquivos alterados selecionados.
 * Usa os hunks de diff dos changedFiles para calcular sem gerar markdown completo.
 * Função pura: não depende de estado ou props.
 */
function estimateDiffTokens(files: CheckpointDiffFile[], selectedPaths: Set<string>): number {
  let totalChars = 0

  for (const file of files) {
    if (!selectedPaths.has(file.relativePath)) continue

    // Cabeçalho do arquivo no markdown
    totalChars += `## 📄 \`${file.relativePath}\` (${file.changeType})\n\n`.length

    // Para cada hunk, estima o conteúdo
    for (const hunk of file.hunks) {
      totalChars += `### 🔍 Hunk (Linhas ${hunk.oldStart}-${hunk.oldStart + hunk.oldLines})\n\n`.length
      totalChars += '#### 🟥 [Removido]\n```diff\n'.length
      totalChars += hunk.removedLines.join('\n').length + hunk.removedLines.length // +1 por quebra de linha
      totalChars += '```\n\n'.length

      totalChars += '#### 🟩 [Adicionado]\n```diff\n'.length
      totalChars += hunk.addedLines.join('\n').length + hunk.addedLines.length
      totalChars += '```\n\n'.length
    }
  }

  return Math.ceil(totalChars / 4)
}

/**
 * Formata contagem de tokens como "1.2k" para valores >= 1000.
 */
function formatTokens(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  return String(count)
}

/**
 * Componente auxiliar que exibe os detalhes de um checkpoint selecionado.
 * Mostra nome, métricas, lista de arquivos com ToggleSwitches, comparação, botões e prompt.
 */
const CheckpointDetails: React.FC<CheckpointDetailsProps> = ({
  checkpoint,
  checkpointData,
  fileList,
  totalTokens,
  diffTokenCount,
  selectedFilePaths,
  onToggleFile,
  onPreview,
  onCopy,
  onRestore,
  onDelete,
  onRename,
  isCopying,
  isGeneratingPreview,
  previewError,
  checkpoints,
  selectedCheckpointId,
  compareWithCheckpointId,
  onCompareWithChange,
  auditPrompt,
  onPromptChange
}) => {
  if (!checkpoint) {
    return <div className="cc-empty-details">Checkpoint não encontrado.</div>
  }

  // Filtra checkpoints mais antigos que o selecionado
  const selectedDate = new Date(
    checkpoints.find(cp => cp.id === selectedCheckpointId)?.createdAt || 0
  )
  const olderCheckpoints = checkpoints.filter(c => {
    const currentDate = new Date(c.createdAt)
    return currentDate < selectedDate
  })

  return (
    <div className="cc-details-content">
      {/* Cabeçalho com nome e badge de arquivos */}
      <div className="cc-details-header">
        <div className="cc-details-title-row">
          <h2>{checkpoint.name}</h2>
          <button
            className="cc-rename-btn"
            onClick={onRename}
            title="Renomear checkpoint"
          >
            ✏️
          </button>
        </div>
        <span className="cc-details-badge">
          {checkpoint.fileCount} arquivo{checkpoint.fileCount !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Data de criação */}
      <div className="cc-details-info">
        <div className="cc-details-row">
          <span className="cc-details-label">Criado em:</span>
          <span className="cc-details-value">
            {new Date(checkpoint.createdAt).toLocaleString('pt-BR')}
          </span>
        </div>
      </div>

      {/* Métricas do checkpoint: arquivos e tokens do diff */}
      <div className="cc-stats-section">
        <div className="cc-stat">
          <span className="cc-stat-label">Arquivos</span>
          <span className="cc-stat-value">{checkpoint.fileCount}</span>
        </div>
        <div className="cc-stat cc-stat-highlight">
          <span className="cc-stat-label">Tokens</span>
          <span className="cc-stat-value">≈ {formatTokens(diffTokenCount)}</span>
        </div>
      </div>

      {/* Dropdown de comparação */}
      <div className="cc-compare-section">
        <label className="cc-compare-label">Comparar com:</label>
        <select
          className="cc-compare-select"
          value={compareWithCheckpointId || ''}
          onChange={(e) => onCompareWithChange(e.target.value || null)}
        >
          <option value="">Estado Atual do Disco</option>
          {olderCheckpoints.map(cp => (
            <option key={cp.id} value={cp.id}>
              {cp.name} ({new Date(cp.createdAt).toLocaleString('pt-BR')})
            </option>
          ))}
        </select>
      </div>

      {/* Botões de ação — reposicionados logo após o dropdown */}
      <div className="cc-actions-row">
        <button
          className="app-pill-btn"
          onClick={onPreview}
          disabled={isGeneratingPreview || selectedFilePaths.size === 0}
          title={selectedFilePaths.size === 0 ? 'Selecione ao menos um arquivo para gerar o preview' : ''}
        >
          {isGeneratingPreview ? '⏳ Gerando...' : '👁️ Preview'}
        </button>
        <button
          className="app-pill-btn"
          onClick={onCopy}
          disabled={isCopying}
        >
          {isCopying ? '⏳ Copiando...' : '📋 Copiar Diff'}
        </button>
        <button
          className="app-pill-btn cc-restore-btn"
          onClick={onRestore}
          title="Restaurar arquivos para o estado deste checkpoint"
        >
          🔄 Restaurar
        </button>
        <button
          className="app-pill-btn cc-delete-btn"
          onClick={onDelete}
          title="Excluir este checkpoint permanentemente"
        >
          🗑️ Excluir
        </button>
      </div>

      {/* Prompt de auditoria */}
      <div className="cc-prompt-section">
        <label className="cc-prompt-label">Prompt de Auditoria (opcional):</label>
        <textarea
          className="cc-prompt-textarea"
          value={auditPrompt}
          onChange={onPromptChange}
          rows={6}
          placeholder="Digite o prompt que será copiado junto com o diff..."
        />
      </div>

      {/* Mensagem de erro do preview */}
      {previewError && (
        <div className="cc-preview-error">
          <span>❌</span>
          <span>{previewError}</span>
        </div>
      )}

      {/* Lista de arquivos alterados com badges A/M/D e ToggleSwitches */}
      <div className="cc-files-section">
        <h3>📁 Arquivos Alterados ({fileList.length})</h3>
        {fileList.length === 0 ? (
          <p className="cc-files-empty">Nenhuma alteração detectada neste checkpoint.</p>
        ) : (
          <ul className="cc-file-list">
            {fileList.map(file => (
              <li key={file.path} className="cc-file-item">
                <ToggleSwitch
                  checked={selectedFilePaths.has(file.path)}
                  onChange={() => onToggleFile(file.path)}
                />
                <span className={`cc-type-badge ${file.changeType}`}>
                  {CHANGE_TYPE_LABEL[file.changeType]}
                </span>
                <span className="cc-file-name" title={file.path}>
                  {file.name}
                </span>
                <ImportanceBadge
                  level={file.importance}
                  source={file.source}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * Componente principal da aba Code Checkpoints.
 * Gerencia timeline, seleção, criação, preview, restauração e exclusão.
 */
export const CodeCheckpointsView: React.FC<CodeCheckpointsViewProps> = ({
  activeProject,
  onSelectProject,
  onStatusMessage
}) => {
  // Lista de checkpoints carregada do backend
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([])

  // ID do checkpoint selecionado na timeline
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null)

  // Dados completos do checkpoint selecionado (para métricas)
  const [checkpointData, setCheckpointData] = useState<CheckpointData | null>(null)

  // Estado de loading inicial
  const [isLoading, setIsLoading] = useState(false)

  // Controle do modal de criação
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)

  // Campos do modal
  const [newCheckpointName, setNewCheckpointName] = useState('')
  const [newCheckpointStrategy, setNewCheckpointStrategy] = useState<'all' | 'critical-high'>('all')

  // Estado de criação em andamento
  const [isCreating, setIsCreating] = useState(false)

  // Markdown do preview gerado
  const [previewMarkdown, setPreviewMarkdown] = useState<string>('')

  // Contagem de tokens do diff gerado (calculada após gerar preview)
  const [diffTokenCount, setDiffTokenCount] = useState<number>(0)

  // Estado de loading durante geração do preview
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false)

  // Estado de erro do preview
  const [previewError, setPreviewError] = useState<string>('')

  // Feedback de cópia
  const [isCopied, setIsCopied] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isCopying, setIsCopying] = useState(false)

  // Dropdown de comparação
  const [compareWithCheckpointId, setCompareWithCheckpointId] = useState<string | null>(null)

  // Prompt de auditoria customizável (persistido por projeto)
  const [auditPrompt, setAuditPrompt] = useState<string>('')

  // Modal de confirmação de restauração
  const [isRestoreModalOpen, setIsRestoreModalOpen] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)

  // Modal de confirmação de exclusão
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  // Modal de renomear checkpoint (usa nome separado para não conflitar com o modal de criação)
  const [isRenameModalOpen, setIsRenameModalOpen] = useState(false)
  const [renameCheckpointName, setRenameCheckpointName] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)

  // Controle de quais arquivos entram no preview do diff
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(new Set())

  // Lista de arquivos alterados entre checkpoint e disco (ou entre checkpoints)
  const [changedFiles, setChangedFiles] = useState<CheckpointDiffFile[]>([])

  // Ref para controlar execução concorrente da criação do checkpoint inicial
  const isCreatingInitialRef = useRef(false)

  // Cache de classificação de importância (repoPath -> relativePath -> FileImportance)
  const importanceCacheRef = useRef<Map<string, Map<string, FileImportance>>>(new Map())

  /**
   * Carrega o arquivo completo de importância do repositório para cache.
   */
  const loadImportanceCache = useCallback(async (repoPath: string, repoName: string, filePaths: string[]) => {
    try {
      const result = await window.codeAwareness.classifyImportance(
        repoPath,
        repoName,
        filePaths.map(p => ({ relativePath: p }))
      )
      if (result.success && result.data) {
        const fileMap = new Map(Object.entries(result.data))
        importanceCacheRef.current.set(repoPath, fileMap)
        return fileMap
      }
    } catch {
      // Fallback: ignora erro de classificação
    }
    return new Map<string, FileImportance>()
  }, [])

  /**
   * Obtém a importância de um arquivo do cache, ou retorna low como fallback.
   */
  const getFileImportance = useCallback((repoPath: string, relativePath: string): { level: ImportanceLevel; source: ImportanceSource } => {
    const repoCache = importanceCacheRef.current.get(repoPath)
    if (repoCache) {
      const fileImportance = repoCache.get(relativePath)
      if (fileImportance) {
        return { level: fileImportance.level, source: fileImportance.source }
      }
    }
    return { level: 'low', source: 'heuristic' }
  }, [])

  /**
   * Carrega os dados completos do checkpoint e calcula métricas.
   */
  const loadCheckpointData = useCallback(async (repoPath: string, checkpointId: string) => {
    try {
      const result = await window.codeAwareness.loadCheckpoint(repoPath, checkpointId)
      if (result.success && result.data) {
        setCheckpointData(result.data)
      }
    } catch {
      setCheckpointData(null)
    }
  }, [])

  /**
   * Carrega a lista de arquivos alterados entre o checkpoint selecionado e o estado atual do disco.
   * Usa a API getCheckpointChangedFiles do backend.
   */
  const loadChangedFiles = useCallback(async (repoPath: string, checkpointId: string, compareWithId?: string) => {
    try {
      const result = await window.codeAwareness.getCheckpointChangedFiles(
        repoPath,
        checkpointId,
        compareWithId || undefined
      )
      if (result.success && result.data) {
        console.log('[CodeCheckpointsView] Changed files carregados:', result.data.length, 'arquivos')
        setChangedFiles(result.data)
      } else {
        console.warn('[CodeCheckpointsView] Falha ao carregar changed files:', result.error)
        setChangedFiles([])
      }
    } catch (error) {
      console.error('[CodeCheckpointsView] Erro ao carregar changed files:', error)
      setChangedFiles([])
    }
  }, [])

  /**
   * Calcula métricas a partir dos changedFiles: tokens e lista de arquivos.
   * Usa changedFiles (arquivos alterados) ao invés de todos os arquivos do snapshot.
   */
  const calculateMetrics = useCallback((data: CheckpointData | null) => {
    if (!data || changedFiles.length === 0) {
      return { totalTokens: 0, fileList: [] as FileListItem[] }
    }

    let totalTokens = 0
    const fileList: FileListItem[] = []

    const repoPath = activeProject?.path || ''

    for (const file of changedFiles) {
      // Estima tokens baseado no conteúdo (se disponível) ou fallback
      const content = file.changeType === 'deleted' ? file.oldContent : file.newContent
      const tokenEstimate = content ? Math.ceil(content.length / 4) : 100

      totalTokens += tokenEstimate

      // Obtém importância do cache ou fallback
      const importance = getFileImportance(repoPath, file.relativePath)

      fileList.push({
        path: file.relativePath,
        name: file.relativePath.split('/').pop() ?? file.relativePath,
        changeType: file.changeType,
        importance: importance.level,
        source: importance.source
      })
    }

    return { totalTokens, fileList }
  }, [activeProject, getFileImportance, changedFiles])

  /**
   * Carrega dados completos do checkpoint e arquivos alterados quando a seleção muda.
   */
  useEffect(() => {
    if (!activeProject || !selectedCheckpointId) {
      setCheckpointData(null)
      setChangedFiles([])
      return
    }

    loadCheckpointData(activeProject.path, selectedCheckpointId)
    loadChangedFiles(activeProject.path, selectedCheckpointId, compareWithCheckpointId || undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCheckpointId, compareWithCheckpointId])

  /**
   * Após carregar o checkpointData, extrai os paths dos changed files, carrega o cache de importância,
   * inicializa a seleção de arquivos com todos ligados e calcula tokens do diff.
   */
  useEffect(() => {
    if (!activeProject || !checkpointData || !selectedCheckpointId) return

    // Extrai paths dos changed files para carregar importância
    const filePaths = changedFiles.map(f => f.relativePath)

    // Carrega cache de importância se ainda não foi carregado para este repositório
    if (!importanceCacheRef.current.has(activeProject.path) && filePaths.length > 0) {
      loadImportanceCache(activeProject.path, activeProject.name, filePaths)
    }

    // Todos os changed files começam selecionados por padrão
    const newSelectedPaths = new Set(filePaths)
    setSelectedFilePaths(newSelectedPaths)

    // Estima tokens do diff imediatamente
    const estimatedTokens = estimateDiffTokens(changedFiles, newSelectedPaths)
    setDiffTokenCount(estimatedTokens)
  }, [checkpointData, activeProject, selectedCheckpointId, changedFiles, loadImportanceCache, estimateDiffTokens])

  /**
   * Recalcula tokens quando a seleção de arquivos muda.
   */
  useEffect(() => {
    if (!changedFiles.length) return

    // Recalcula tokens quando a seleção de arquivos muda
    const estimatedTokens = estimateDiffTokens(changedFiles, selectedFilePaths)
    setDiffTokenCount(estimatedTokens)
  }, [changedFiles, selectedFilePaths, estimateDiffTokens])

  /**
   * Limpa o cache de importância ao trocar de projeto e recarrega.
   */
  useEffect(() => {
    if (!activeProject) return
    // Remove o cache antigo; será recarregado via efeito acima quando checkpointData chegar
    importanceCacheRef.current.delete(activeProject.path)
  }, [activeProject])

  // Calcula métricas derivadas com useMemo para evitar chamadas múltiplas
  const metrics = React.useMemo(() => {
    if (!checkpointData) return null
    return calculateMetrics(checkpointData)
  }, [checkpointData, calculateMetrics])

  const totalTokens = metrics?.totalTokens ?? 0
  const fileList: FileListItem[] = metrics?.fileList ?? []

  /**
   * Alterna a seleção de um arquivo para o preview do diff.
   */
  const handleToggleFile = useCallback((path: string) => {
    setSelectedFilePaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  /**
   * Renomeia o checkpoint selecionado.
   */
  const handleRenameCheckpoint = useCallback(async () => {
    if (!activeProject || !selectedCheckpointId || !renameCheckpointName.trim()) return

    setIsRenaming(true)
    try {
      const result = await window.codeAwareness.renameCheckpoint(
        activeProject.path,
        selectedCheckpointId,
        renameCheckpointName.trim()
      )

      if (result.success) {
        onStatusMessage('Checkpoint renomeado com sucesso!')

        // Recarrega a lista de checkpoints
        const reloadResult = await window.codeAwareness.listCheckpoints(activeProject.path)
        if (reloadResult.success && reloadResult.data) {
          setCheckpoints(reloadResult.data)
        }

        setIsRenameModalOpen(false)
        setRenameCheckpointName('')
      } else {
        onStatusMessage(result.error || 'Erro ao renomear checkpoint', true)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao renomear checkpoint', true)
    } finally {
      setIsRenaming(false)
    }
  }, [activeProject, selectedCheckpointId, renameCheckpointName, onStatusMessage])

  /**
   * Abre o modal de renomear com o nome atual preenchido.
   */
  const handleOpenRenameModal = useCallback(() => {
    if (!selectedCheckpointId) return

    const checkpoint = checkpoints.find(c => c.id === selectedCheckpointId)
    if (checkpoint) {
      setRenameCheckpointName(checkpoint.name)
      setIsRenameModalOpen(true)
    }
  }, [selectedCheckpointId, checkpoints])

  /**
   * Filtra o markdown do diff para manter apenas as seções de arquivos selecionados.
   * Cada arquivo no diff começa com "## 📄 `caminho/do/arquivo`".
   */
  const filterMarkdownBySelection = useCallback((markdown: string): string => {
    // Divide o markdown em seções por "## 📄"
    const sections = markdown.split(/\n(?=## 📄)/)
    if (sections.length <= 1) return markdown // Sem seções de arquivo, retorna inteiro

    // A primeira seção (cabeçalho) sempre fica
    const [header, ...fileSections] = sections

    const filtered = fileSections.filter(section => {
      // Extrai o path do arquivo do cabeçalho "## 📄 `path`"
      const match = section.match(/## 📄 `(.+?)`/)
      if (!match) return true
      const path = match[1]
      return selectedFilePaths.has(path)
    })

    return [header, ...filtered].join('\n')
  }, [selectedFilePaths])

  /**
   * Gera o preview do diff entre o checkpoint selecionado e o estado atual (ou outro checkpoint).
   * Respeita a seleção de arquivos — apenas arquivos com toggle ligado entram no diff.
   */
  const handlePreview = useCallback(async () => {
    if (!activeProject || !selectedCheckpointId) return

    // Proteção contra gerar preview com zero arquivos selecionados
    if (selectedFilePaths.size === 0) {
      setPreviewError('Selecione ao menos um arquivo para gerar o preview.')
      onStatusMessage('Selecione ao menos um arquivo para gerar o preview', true)
      return
    }

    setIsGeneratingPreview(true)
    setPreviewError('')
    setPreviewMarkdown('')

    try {
      const result = await window.codeAwareness.generateCheckpointDiff(
        activeProject.path,
        selectedCheckpointId,
        compareWithCheckpointId || undefined
      )

      if (result.success && result.data) {
        // Filtra o markdown para manter apenas seções de arquivos selecionados
        const filtered = filterMarkdownBySelection(result.data)
        setPreviewMarkdown(filtered)

        // Calcula e armazena a contagem de tokens do diff filtrado
        const tokenCount = calculateTokens(filtered)
        setDiffTokenCount(tokenCount)
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
  }, [activeProject, selectedCheckpointId, compareWithCheckpointId, filterMarkdownBySelection, onStatusMessage])

  /**
   * Exporta o Markdown do diff para a pasta Downloads sem passar pela tela de preview.
   * Gera o diff e já salva — fluxo direto, sem navegar para o preview.
   */
  const handleGenerateAndExport = useCallback(async () => {
    if (!activeProject || !selectedCheckpointId) return

    // Proteção contra exportar com zero arquivos selecionados
    if (selectedFilePaths.size === 0) {
      onStatusMessage('Selecione ao menos um arquivo para exportar o diff', true)
      return
    }

    setIsExporting(true)
    try {
      const result = await window.codeAwareness.generateCheckpointDiff(
        activeProject.path,
        selectedCheckpointId,
        compareWithCheckpointId || undefined
      )

      if (result.success && result.data) {
        // Filtra o markdown para manter apenas seções de arquivos selecionados
        const filtered = filterMarkdownBySelection(result.data)

        const fileName = `${activeProject.name}-checkpoint-diff`
        const saveResult = await window.codeAwareness.saveToDownloads(filtered, fileName)
        if (saveResult.success) {
          onStatusMessage('Diff exportado para Downloads!')
        } else {
          onStatusMessage(saveResult.error || 'Erro ao exportar diff', true)
        }
      } else {
        onStatusMessage(result.error || 'Erro ao gerar diff para exportar', true)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao exportar diff', true)
    } finally {
      setIsExporting(false)
    }
  }, [activeProject, selectedCheckpointId, compareWithCheckpointId, filterMarkdownBySelection, onStatusMessage])

  /**
   * Gera o diff e copia diretamente para a área de transferência.
   * Não passa pela tela de preview — fluxo direto.
   */
  const handleGenerateAndCopy = useCallback(async () => {
    if (!activeProject || !selectedCheckpointId) return

    // Proteção contra copiar com zero arquivos selecionados
    if (selectedFilePaths.size === 0) {
      onStatusMessage('Selecione ao menos um arquivo para copiar o diff', true)
      return
    }

    setIsCopying(true)
    try {
      const result = await window.codeAwareness.generateCheckpointDiff(
        activeProject.path,
        selectedCheckpointId,
        compareWithCheckpointId || undefined
      )

      if (result.success && result.data) {
        // Filtra o markdown para manter apenas seções de arquivos selecionados
        const filtered = filterMarkdownBySelection(result.data)

        // Adiciona o prompt de auditoria se houver
        const finalContent = auditPrompt
          ? `${auditPrompt}\n\n${filtered}`
          : filtered

        await navigator.clipboard.writeText(finalContent)
        onStatusMessage('✓ Diff copiado para a área de transferência!')
      } else {
        onStatusMessage(result.error || 'Erro ao gerar diff para copiar', true)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao copiar diff', true)
    } finally {
      setIsCopying(false)
    }
  }, [activeProject, selectedCheckpointId, compareWithCheckpointId, selectedFilePaths, filterMarkdownBySelection, auditPrompt, onStatusMessage])

  /**
   * Exporta o Markdown do preview para a pasta Downloads do sistema.
   */
  const handleExportDiff = useCallback(async () => {
    if (!activeProject || !previewMarkdown) return

    setIsExporting(true)
    try {
      const fileName = `${activeProject.name}-checkpoint-diff`
      const result = await window.codeAwareness.saveToDownloads(previewMarkdown, fileName)
      if (result.success) {
        onStatusMessage('Diff exportado para Downloads!')
      } else {
        onStatusMessage(result.error || 'Erro ao exportar diff', true)
      }
    } catch (error) {
      onStatusMessage('Erro ao exportar diff', true)
    } finally {
      setIsExporting(false)
    }
  }, [activeProject, previewMarkdown, onStatusMessage])

  /**
   * Copia o prompt + Markdown do preview para a área de transferência.
   */
  const handleCopyDiff = useCallback(async () => {
    if (!previewMarkdown) return

    try {
      const finalContent = auditPrompt
        ? `${auditPrompt}\n\n${previewMarkdown}`
        : previewMarkdown

      await navigator.clipboard.writeText(finalContent)
      setIsCopied(true)
      onStatusMessage('Prompt + Diff copiados para a área de transferência!')
      setTimeout(() => setIsCopied(false), 2000)
    } catch (error) {
      onStatusMessage('Erro ao copiar diff', true)
    }
  }, [previewMarkdown, auditPrompt, onStatusMessage])

  /**
   * Volta do preview para os detalhes do checkpoint.
   */
  const handleBackToDetails = useCallback(() => {
    setPreviewMarkdown('')
    setPreviewError('')
    // Não resetar diffTokenCount - manter visível na área de métricas
  }, [])

  /**
   * Persiste o prompt de auditoria no localStorage ao ser alterado.
   */
  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newPrompt = e.target.value
    setAuditPrompt(newPrompt)
    if (activeProject) {
      localStorage.setItem(`code_checkpoints_audit_prompt_${activeProject.path}`, newPrompt)
    }
  }

  /**
   * Restaura os arquivos do checkpoint selecionado.
   * Após restaurar, reseta o preview pois os arquivos no disco mudaram.
   */
  const handleRestoreCheckpoint = useCallback(async () => {
    if (!activeProject || !selectedCheckpointId) return

    setIsRestoring(true)
    try {
      const result = await window.codeAwareness.restoreCheckpoint(
        activeProject.path,
        selectedCheckpointId
      )

      if (result.success && result.data) {
        const { restored, failed, errors } = result.data

        if (failed === 0) {
          onStatusMessage(`✓ ${restored} arquivo(s) restaurado(s) com sucesso!`)
        } else {
          onStatusMessage(`⚠️ ${restored} restaurado(s), ${failed} falha(s)`, true)
          console.error('[CodeCheckpointsView] Erros na restauração:', errors)
        }

        // Reseta o preview pois os arquivos no disco mudaram
        setPreviewMarkdown('')
        setPreviewError('')

        setIsRestoreModalOpen(false)
      } else {
        onStatusMessage(result.error || 'Erro ao restaurar checkpoint', true)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao restaurar checkpoint', true)
    } finally {
      setIsRestoring(false)
    }
  }, [activeProject, selectedCheckpointId, onStatusMessage])

  /**
   * Exclui o checkpoint selecionado e recarrega a lista.
   */
  const handleDeleteCheckpoint = useCallback(async () => {
    if (!activeProject || !selectedCheckpointId) return

    setIsDeleting(true)
    try {
      const result = await window.codeAwareness.deleteCheckpoint(
        activeProject.path,
        selectedCheckpointId
      )

      if (result.success) {
        onStatusMessage('✓ Checkpoint excluído com sucesso!')

        // Reseta o preview se estava visível (checkpoint não existe mais)
        setPreviewMarkdown('')
        setPreviewError('')
        setCheckpointData(null)

        // Recarrega a lista de checkpoints
        const reloadResult = await window.codeAwareness.listCheckpoints(activeProject.path)
        if (reloadResult.success && reloadResult.data) {
          setCheckpoints(reloadResult.data)

          // Seleciona o primeiro checkpoint disponível, ou reseta se vazio
          if (reloadResult.data.length > 0) {
            setSelectedCheckpointId(reloadResult.data[0].id)
          } else {
            setSelectedCheckpointId(null)
          }
        }

        setIsDeleteModalOpen(false)
      } else {
        onStatusMessage(result.error || 'Erro ao excluir checkpoint', true)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao excluir checkpoint', true)
    } finally {
      setIsDeleting(false)
    }
  }, [activeProject, selectedCheckpointId, onStatusMessage])

  /**
   * Cria automaticamente o checkpoint "🏁 Início" quando não há checkpoints.
   */
  const createInitialCheckpoint = useCallback(async (repoPath: string) => {
    if (isCreatingInitialRef.current) return
    isCreatingInitialRef.current = true

    try {
      const result = await window.codeAwareness.createCheckpoint(
        repoPath,
        '🏁 Início',
        'all'
      )

      if (result.success && result.data) {
        const reloadResult = await window.codeAwareness.listCheckpoints(repoPath)
        if (reloadResult.success && reloadResult.data) {
          setCheckpoints(reloadResult.data)
          setSelectedCheckpointId(result.data.id)
        }
        onStatusMessage('Checkpoint "🏁 Início" criado automaticamente!')
      } else if (result.error?.includes('Já existe')) {
        const reloadResult = await window.codeAwareness.listCheckpoints(repoPath)
        if (reloadResult.success && reloadResult.data) {
          setCheckpoints(reloadResult.data)
          const inicio = reloadResult.data.find(c => c.name === '🏁 Início')
          if (inicio) {
            setSelectedCheckpointId(inicio.id)
            onStatusMessage('Checkpoint "🏁 Início" já existia e foi selecionado.')
          }
        }
      } else {
        onStatusMessage(result.error || 'Erro ao criar checkpoint inicial', true)
      }
    } catch (error) {
      console.error('Erro ao criar checkpoint inicial:', error)
    } finally {
      isCreatingInitialRef.current = false
    }
  }, [onStatusMessage])

  /**
   * Carrega prompt de auditoria do localStorage ao trocar de projeto.
   */
  useEffect(() => {
    if (!activeProject) {
      setAuditPrompt('')
      return
    }

    const savedPrompt = localStorage.getItem(`code_checkpoints_audit_prompt_${activeProject.path}`)
    if (savedPrompt) {
      setAuditPrompt(savedPrompt)
    } else {
      const defaultPrompt = `Analise as alterações de código abaixo como um Engenheiro de Software Staff extremamente rigoroso.

Seu papel é auditar o trabalho realizado pelo agente de implementação e validar se a tarefa foi cumprida de forma íntegra, segura e profissional.

Instruções da sua auditoria:
1. Avalie se os requisitos foram completamente atendidos.
2. Identifique bugs ocultos, problemas de lógica ou quebras de arquitetura.
3. Forneça um veredito direto: "APROVADO" ou "REPROVADO COM AJUSTES".

Abaixo está o diff semântico das alterações:
--------------------------------------------------`

      setAuditPrompt(defaultPrompt)
      localStorage.setItem(`code_checkpoints_audit_prompt_${activeProject.path}`, defaultPrompt)
    }
  }, [activeProject])

  /**
   * Efeito principal: carrega checkpoints ao montar ou trocar de projeto.
   */
  useEffect(() => {
    let isMounted = true

    const loadCheckpoints = async () => {
      if (!activeProject) {
        if (isMounted) {
          setCheckpoints([])
          setSelectedCheckpointId(null)
          setCheckpointData(null)
          setPreviewMarkdown('')
          setPreviewError('')
          setCompareWithCheckpointId(null)
        }
        return
      }

      setSelectedCheckpointId(null)
      setCheckpointData(null)
      setPreviewMarkdown('')
      setPreviewError('')
      setCompareWithCheckpointId(null)

      setIsLoading(true)
      try {
        const result = await window.codeAwareness.listCheckpoints(activeProject.path)

        if (!isMounted) return

        if (result.success && result.data) {
          setCheckpoints(result.data)

          if (result.data.length === 0) {
            await createInitialCheckpoint(activeProject.path)
          } else {
            setSelectedCheckpointId(result.data[0].id)
          }
        }
      } catch (error) {
        console.error('Erro ao carregar checkpoints:', error)
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    loadCheckpoints()

    return () => {
      isMounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject])

  /**
   * Reseta preview e dados do checkpoint ao trocar de seleção.
   */
  useEffect(() => {
    setPreviewMarkdown('')
    setPreviewError('')
    setDiffTokenCount(0)
    setCompareWithCheckpointId(null)
  }, [selectedCheckpointId])

  /**
   * Inicializa a detecção de commits ao abrir a aba com um projeto ativo.
   */
  useEffect(() => {
    if (!activeProject) return

    const initializeDetection = async () => {
      try {
        await window.codeAwareness.initializeCommitDetection(activeProject.path)
      } catch (error) {
        console.error('[CodeCheckpointsView] Erro ao inicializar detecção de commits:', error)
      }
    }

    initializeDetection()
  }, [activeProject])

  /**
   * Escuta eventos de commit detectado e recarrega a lista de checkpoints automaticamente.
   */
  useEffect(() => {
    if (!activeProject) return

    const handleCommitDetected = (_event: any, data: { repoPath: string; deletedCount: number; newCheckpointId: string }) => {
      // Verifica se o evento é para o projeto ativo
      if (data.repoPath !== activeProject.path) return

      // Recarrega a lista de checkpoints
      const reloadCheckpoints = async () => {
        try {
          const result = await window.codeAwareness.listCheckpoints(activeProject.path)
          if (result.success && result.data) {
            setCheckpoints(result.data)

            // Seleciona o novo checkpoint "🏁 Início"
            setSelectedCheckpointId(data.newCheckpointId)

            // Reseta o preview
            setPreviewMarkdown('')
            setPreviewError('')
            setCompareWithCheckpointId(null)

            // Mostra notificação
            onStatusMessage(`✓ Commit detectado! ${data.deletedCount} checkpoint(s) limpo(s), novo "🏁 Início" criado.`)
          }
        } catch (error) {
          console.error('[CodeCheckpointsView] Erro ao recarregar checkpoints após commit:', error)
        }
      }

      reloadCheckpoints()
    }

    // Registra o listener
    window.codeAwareness.onCommitDetected(handleCommitDetected)

    // Remove o listener ao desmontar ou trocar de projeto
    return () => {
      window.codeAwareness.removeCommitDetectedListener()
    }
  }, [activeProject, onStatusMessage])

  /**
   * Fecha modal ao pressionar ESC.
   */
  useEffect(() => {
    if (!isCreateModalOpen) return

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isCreating) {
        setIsCreateModalOpen(false)
      }
    }

    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('keydown', handleEsc)
    }
  }, [isCreateModalOpen, isCreating])

  /**
   * Handler do botão "Criar Checkpoint".
   */
  const handleCreateCheckpoint = async () => {
    if (!activeProject || !newCheckpointName.trim()) return

    if (newCheckpointStrategy !== 'all' && newCheckpointStrategy !== 'critical-high') {
      onStatusMessage('Estratégia inválida', true)
      return
    }

    setIsCreating(true)
    try {
      const result = await window.codeAwareness.createCheckpoint(
        activeProject.path,
        newCheckpointName.trim(),
        newCheckpointStrategy
      )

      if (result.success && result.data) {
        const reloadResult = await window.codeAwareness.listCheckpoints(activeProject.path)
        if (reloadResult.success && reloadResult.data) {
          setCheckpoints(reloadResult.data)
          const exists = reloadResult.data.find(c => c.id === result.data!.id)
          if (exists) {
            setSelectedCheckpointId(result.data.id)
          } else {
            setSelectedCheckpointId(reloadResult.data[0]?.id || null)
          }
        }

        onStatusMessage(`Checkpoint "${newCheckpointName}" criado com sucesso!`)

        setIsCreateModalOpen(false)
        setNewCheckpointName('')
        setNewCheckpointStrategy('all')
      } else {
        onStatusMessage(result.error || 'Erro ao criar checkpoint', true)
      }
    } catch (error: any) {
      onStatusMessage(error.message || 'Erro ao criar checkpoint', true)
    } finally {
      setIsCreating(false)
    }
  }

  // Estado sem projeto ativo
  if (!activeProject) {
    return (
      <div className="cc-dropzone-wrapper">
        <div className="empty-selection-banner" style={{ border: 'none', background: 'transparent' }}>
          <h3>Nenhum projeto selecionado</h3>
          <p>Volte para a aba <strong>Projetos</strong> e ative um repositório para gerenciar checkpoints.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="cc-container">
      <div className="cc-topbar">
        <div className="cc-repo-info">
          <ProjectSwitcher activeProject={activeProject} onSelectProject={onSelectProject} />
          {isLoading && <span className="cc-status-badge loading">carregando...</span>}
          {!isLoading && checkpoints.length > 0 && (
            <span className="cc-status-badge watching">
              {checkpoints.length} checkpoint{checkpoints.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      <div className="cc-layout-wrapper">
        <aside className="cc-sidebar">
          <div className="cc-sidebar-header">
            <span>Timeline de Checkpoints</span>
            <button
              className="cc-create-btn"
              onClick={() => setIsCreateModalOpen(true)}
              disabled={isCreating}
            >
              📸 Criar Checkpoint
            </button>
          </div>

          {checkpoints.length === 0 ? (
            <div className="cc-empty-timeline">
              <p>Nenhum checkpoint encontrado.</p>
              <p>Clique em "Criar Checkpoint" para começar.</p>
            </div>
          ) : (
            <div className="cc-timeline">
              {checkpoints.map((checkpoint, index) => (
                <div
                  key={checkpoint.id}
                  className={`cc-timeline-node ${selectedCheckpointId === checkpoint.id ? 'selected' : ''}`}
                  onClick={() => setSelectedCheckpointId(checkpoint.id)}
                >
                  <div className="cc-timeline-marker">
                    {checkpoint.name === '🏁 Início' ? '🏁' : '📸'}
                  </div>
                  <div className="cc-timeline-content">
                    <div className="cc-timeline-name">{checkpoint.name}</div>
                    <div className="cc-timeline-meta">
                      <span className="cc-timeline-date">
                        {new Date(checkpoint.createdAt).toLocaleString('pt-BR')}
                      </span>
                      <span className="cc-timeline-count">
                        {checkpoint.fileCount} arquivo{checkpoint.fileCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                  {index < checkpoints.length - 1 && <div className="cc-timeline-line" />}
                </div>
              ))}
            </div>
          )}
        </aside>

        <main className="cc-details-panel">
          {previewMarkdown ? (
            <div className="cc-preview-container">
              <div className="cc-preview-header">
                <button
                  className="cc-preview-back-btn"
                  onClick={handleBackToDetails}
                  title="Voltar aos detalhes"
                >
                  ← Voltar
                </button>
                <div className="cc-preview-token-count">
                  <span className="cc-preview-token-label">📊 Tokens do Diff:</span>
                  <span className="cc-preview-token-value">≈ {formatTokens(diffTokenCount)}</span>
                </div>
                <div className="cc-preview-actions">
                  <button
                    className="app-pill-btn"
                    onClick={handleCopyDiff}
                    disabled={!previewMarkdown}
                  >
                    {isCopied ? '✓ Copiado!' : '📋 Copiar Diffs'}
                  </button>
                  <button
                    className="app-pill-btn"
                    onClick={handleExportDiff}
                    disabled={isExporting || !previewMarkdown}
                  >
                    {isExporting ? 'Exportando...' : '💾 Exportar'}
                  </button>
                </div>
              </div>

              <div className="cc-preview-content">
                {/*
                  RESPONSABILIDADE DOS BADGES DE IMPORTÂNCIA:
                  O backend (checkpoint-service.ts buildFileSection) injeta os emojis
                  (🔴🟠🟡⚪) diretamente no Markdown diff via cabeçalho ## de cada arquivo.
                  Já o componente React <ImportanceBadge> abaixo na lista de arquivos
                  renderiza badges interativos com dropdown para override manual.
                  Ambos coexistem: um no preview do diff (passivo), outro na lista (interativo).
                */}
                <Markdown>{previewMarkdown}</Markdown>
              </div>
            </div>
          ) : selectedCheckpointId ? (
            <CheckpointDetails
              checkpoint={checkpoints.find(c => c.id === selectedCheckpointId)}
              checkpointData={checkpointData}
              fileList={fileList}
              totalTokens={totalTokens}
              diffTokenCount={diffTokenCount}
              selectedFilePaths={selectedFilePaths}
              onToggleFile={handleToggleFile}
              onPreview={handlePreview}
              onCopy={handleGenerateAndCopy}
              onRestore={() => setIsRestoreModalOpen(true)}
              onDelete={() => setIsDeleteModalOpen(true)}
              onRename={handleOpenRenameModal}
              isCopying={isCopying}
              isGeneratingPreview={isGeneratingPreview}
              previewError={previewError}
              checkpoints={checkpoints}
              selectedCheckpointId={selectedCheckpointId}
              compareWithCheckpointId={compareWithCheckpointId}
              onCompareWithChange={setCompareWithCheckpointId}
              auditPrompt={auditPrompt}
              onPromptChange={handlePromptChange}
            />
          ) : (
            <div className="cc-empty-details">
              <svg viewBox="0 0 24 24" style={{ width: '48px', height: '48px', stroke: 'var(--text-secondary)', fill: 'none', strokeWidth: 1.5 }}>
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <h3>Selecione um checkpoint</h3>
              <p>Clique em um checkpoint na timeline para ver os detalhes.</p>
            </div>
          )}
        </main>
      </div>

      {/* Modal de Criação */}
      {isCreateModalOpen && (
        <div className="cc-modal-overlay" onClick={() => !isCreating && setIsCreateModalOpen(false)}>
          <div className="cc-modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>📸 Criar Novo Checkpoint</h3>

            <div className="cc-modal-field">
              <label>Nome do Checkpoint</label>
              <input
                type="text"
                value={newCheckpointName}
                onChange={(e) => setNewCheckpointName(e.target.value)}
                placeholder="Ex: Sprint 1, Antes do refactor..."
                disabled={isCreating}
                autoFocus
              />
            </div>

            <div className="cc-modal-field">
              <label>Estratégia de Snapshot</label>
              <select
                value={newCheckpointStrategy}
                onChange={(e) => setNewCheckpointStrategy(e.target.value as 'all' | 'critical-high')}
                disabled={isCreating}
              >
                <option value="all">Todos os Arquivos</option>
                <option value="critical-high">Apenas Critical + High</option>
              </select>
              <span className="cc-modal-hint">
                {newCheckpointStrategy === 'all'
                  ? 'Captura todos os arquivos tracked do repositório.'
                  : 'Captura apenas arquivos classificados como críticos ou altos pelo sistema de importância.'}
              </span>
            </div>

            <div className="cc-modal-actions">
              <button
                className="cc-modal-cancel"
                onClick={() => setIsCreateModalOpen(false)}
                disabled={isCreating}
              >
                Cancelar
              </button>
              <button
                className="cc-modal-confirm"
                onClick={handleCreateCheckpoint}
                disabled={isCreating || !newCheckpointName.trim()}
              >
                {isCreating ? 'Criando...' : 'Criar Checkpoint'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Renomear */}
      {isRenameModalOpen && (
        <div className="cc-modal-overlay" onClick={() => !isRenaming && setIsRenameModalOpen(false)}>
          <div className="cc-modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>✏️ Renomear Checkpoint</h3>

            <div className="cc-modal-field">
              <label>Novo Nome</label>
              <input
                type="text"
                value={renameCheckpointName}
                onChange={(e) => setRenameCheckpointName(e.target.value)}
                placeholder="Digite o novo nome..."
                disabled={isRenaming}
                autoFocus
              />
            </div>

            <div className="cc-modal-actions">
              <button
                className="cc-modal-cancel"
                onClick={() => setIsRenameModalOpen(false)}
                disabled={isRenaming}
              >
                Cancelar
              </button>
              <button
                className="cc-modal-confirm"
                onClick={handleRenameCheckpoint}
                disabled={isRenaming || !renameCheckpointName.trim()}
              >
                {isRenaming ? 'Renomeando...' : 'Renomear'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Restauração */}
      {isRestoreModalOpen && (
        <div className="cc-modal-overlay" onClick={() => !isRestoring && setIsRestoreModalOpen(false)}>
          <div className="cc-modal-content cc-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>🔄 Restaurar Checkpoint</h3>
            <p>
              Tem certeza que deseja restaurar os arquivos para o estado do checkpoint <strong>"{checkpoints.find(c => c.id === selectedCheckpointId)?.name}"</strong>?
            </p>
            <p className="cc-modal-warning">
              ⚠️ Esta ação irá sobrescrever os arquivos atuais no disco. Certifique-se de ter um backup ou commit recente antes de continuar.
            </p>
            <div className="cc-modal-actions">
              <button
                className="cc-modal-cancel"
                onClick={() => setIsRestoreModalOpen(false)}
                disabled={isRestoring}
              >
                Cancelar
              </button>
              <button
                className="cc-modal-confirm cc-restore-confirm"
                onClick={handleRestoreCheckpoint}
                disabled={isRestoring}
              >
                {isRestoring ? 'Restaurando...' : 'Confirmar Restauração'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Exclusão */}
      {isDeleteModalOpen && (
        <div className="cc-modal-overlay" onClick={() => !isDeleting && setIsDeleteModalOpen(false)}>
          <div className="cc-modal-content cc-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>🗑️ Excluir Checkpoint</h3>
            <p>
              Tem certeza que deseja excluir permanentemente o checkpoint <strong>"{checkpoints.find(c => c.id === selectedCheckpointId)?.name}"</strong>?
            </p>
            <p className="cc-modal-warning">
              ⚠️ Esta ação não pode ser desfeita. O checkpoint será removido permanentemente.
            </p>
            <div className="cc-modal-actions">
              <button
                className="cc-modal-cancel"
                onClick={() => setIsDeleteModalOpen(false)}
                disabled={isDeleting}
              >
                Cancelar
              </button>
              <button
                className="cc-modal-confirm cc-delete-confirm"
                onClick={handleDeleteCheckpoint}
                disabled={isDeleting}
              >
                {isDeleting ? 'Excluindo...' : 'Confirmar Exclusão'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}