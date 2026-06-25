// Responsabilidades do Script
//
// 1. Gerenciar o ciclo de vida do WatcherService (iniciar, parar e escutar eventos de arquivo modificado).
// 2. Renderizar a interface dividida em lista de arquivos alterados e painel de diff semântico em tempo real.
// 3. Gerenciar seleção de arquivos (checkbox) permitindo ao usuário escolher quais entram no diff gerado.
// 4. Gerenciar arquivos ignorados (temporary) com botão de ocultar por hover e sanfona de restauração.
// 5. Botão "🧹 Limpar ruídos" para ignorar lockfiles/config em massa como temporary.
// 6. Popup de ignore inteligente por extensão (temporary vs persistent) ao ocultar arquivos.
// 7. Copiar diff semântico de um único arquivo selecionado para a área de transferência.
////
// Nota: Estados de compressão estrutural e bulk update foram removidos deste componente
// e movidos para uma aba dedicada (CodeCompressionView).

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Markdown from 'markdown-to-jsx'
import { DiffFileStatus } from '../../../../shared/types'
import { NOISE_FILES, COMMON_IGNORE_EXTENSIONS } from '../../constants/ignore-patterns'
import './CodeDiffView.css'

const CHANGE_TYPE_LABEL: Record<DiffFileStatus['changeType'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D'
}

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

export const CodeDiffView: React.FC<{ activeProject: { path: string; name: string } | null; onStatusMessage: (message: string, isError?: boolean) => void }> = ({ activeProject, onStatusMessage }) => {
  const [isWatching, setIsWatching] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null)
  const [modifiedFiles, setModifiedFiles] = useState<DiffFileStatus[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diffMarkdown, setDiffMarkdown] = useState<string>('')
  const [auditPromptTemplate, setAuditPromptTemplate] = useState('')
  const [isCopied, setIsCopied] = useState(false)
  const [isCopyMarkdown, setIsCopyMarkdown] = useState(false)
  const [isExporting, setIsExporting] = useState(false)

  // Estado de seleção de arquivos: Set com os paths de todos marcados por padrão
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())

  // Lista de arquivos ignorados (temporary) carregada das settings
  const [ignoredFiles, setIgnoredFiles] = useState<string[]>([])

  // Lista de padrões persistentes (ex: "*.css") carregada das settings
  const [persistentPatterns, setPersistentPatterns] = useState<string[]>([])

  // Estado da sanfona de ignorados
  const [ignoredAccordionOpen, setIgnoredAccordionOpen] = useState(false)

  // Estado do popup de ignore inteligente: { path, ext } | null
  const [ignorePopup, setIgnorePopup] = useState<{ path: string; ext: string } | null>(null)

  // Estado para armazenar o path do arquivo copiado recentemente para feedback de 1.5s
  const [copiedFile, setCopiedFile] = useState<string | null>(null)

  // Estados de compressão e bulk update foram removidos (movidos para nova aba)



  // Ref para o popup (detectar clique fora)
  const ignorePopupRef = useRef<HTMLDivElement>(null)

  // Ref para o master checkbox
  const masterCheckboxRef = useRef<HTMLInputElement>(null)

  // Ref para o timer do debounce
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Ref que rastreia quais caminhos já estavam em visibleFiles na última renderização.
  // Usado pelo Efeito 1 para distinguir arquivos GENUINAMENTE novos de arquivos que
  // o usuário apenas desmarcou — impedindo que desmarcações sejam revertidas automaticamente.
  const prevVisiblePathsRef = useRef<Set<string>>(new Set())

  // Ref de versionamento de request
  const requestIdRef = useRef(0)

  // Carrega a lista de ignorados (temporary + persistent) das settings para o repositório atual
  const loadIgnoredFiles = useCallback(async () => {
    if (!activeProject) return
    const settings = await window.codeAwareness.loadSettings()
    const repoIgnores = settings.ignoredDiffFiles[activeProject.path]
    setIgnoredFiles(repoIgnores?.temporary || [])
    setPersistentPatterns(repoIgnores?.persistent || [])
  }, [activeProject])

  // Inicializa o template do localStorage ou default
  useEffect(() => {
    const saved = localStorage.getItem('code_diff_prompt_template')
    if (saved) {
      setAuditPromptTemplate(saved)
    } else {
      setAuditPromptTemplate(DEFAULT_PROMPT)
      localStorage.setItem('code_diff_prompt_template', DEFAULT_PROMPT)
    }
  }, [])

  // Carrega ignorados ao montar ou trocar de projeto
  useEffect(() => {
    loadIgnoredFiles()
  }, [loadIgnoredFiles])

  // Fecha popup ao clicar fora
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

  // Verifica se um arquivo "casa" com algum padrão persistente (ex: "*.css" casa com "styles.css")
  const matchesPersistentPattern = useCallback((relativePath: string): boolean => {
    for (const pattern of persistentPatterns) {
      if (pattern.startsWith('*.')) {
        const ext = pattern.slice(1)
        if (relativePath.endsWith(ext)) return true
      }
      if (pattern === relativePath) return true
    }
    return false
  }, [persistentPatterns])

  // Filtra arquivos ignorados e persistentes da lista exibida
  const visibleFiles = useMemo(() => {
    return modifiedFiles.filter(f => {
      if (ignoredFiles.includes(f.relativePath)) return false
      if (matchesPersistentPattern(f.relativePath)) return false
      return true
    })
  }, [modifiedFiles, ignoredFiles, matchesPersistentPattern])

  // Detecta se há arquivos de ruído visíveis
  const hasNoiseFiles = useMemo(() => {
    return visibleFiles.some(f => NOISE_FILES.has(f.name))
  }, [visibleFiles])

  // Efeito 1: Sincroniza a seleção usando apenas visibleFiles como fonte da verdade
  useEffect(() => {
    const currentPaths = new Set(visibleFiles.map(f => f.relativePath))

    setSelectedFiles(prev => {
      const next = new Set<string>()

      // 1. Mantém os que já estavam ativos e ainda estão visíveis
      for (const path of prev) {
        if (currentPaths.has(path)) next.add(path)
      }

      // Arquivos iniciam estritamente desmarcados. O usuário marca individualmente.
      return next
    })
  }, [visibleFiles])


  // Atualiza apenas o indeterminate visual do master checkbox (checked é controlado pelo React)
  useEffect(() => {
    const el = masterCheckboxRef.current
    if (!el) return
    const selected = selectedFiles.size
    const total = visibleFiles.length
    el.indeterminate = selected > 0 && selected < total
  }, [selectedFiles, visibleFiles.length])

  // Efeito reativo com debounce de 200ms
  useEffect(() => {
    if (!activeProject) return

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    if (selectedFiles.size === 0) {
      const name = modifiedFiles.length > 0 ? `\`${activeProject.name}\`` : ''
      setDiffMarkdown(`# Nenhum arquivo selecionado\n\n${name ? `*Nenhuma alteração de ${name} será incluída.*` : ''}`)
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

  // Alterna o master checkbox
  const toggleMasterCheckbox = useCallback(() => {
    setSelectedFiles(prev => {
      const allSelected = prev.size === visibleFiles.length
      if (allSelected) {
        return new Set()
      } else {
        return new Set(visibleFiles.map(f => f.relativePath))
      }
    })
  }, [visibleFiles])

  // Alterna o checkbox de um arquivo específico
  const toggleFileSelection = useCallback((relativePath: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev)
      if (next.has(relativePath)) {
        next.delete(relativePath)
      } else {
        next.add(relativePath)
      }
      return next
    })
  }, [])

  // Ignora um arquivo como temporary
  const ignoreFileTemporary = useCallback(async (relativePath: string) => {
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
  }, [activeProject, onStatusMessage])

  // Ignora um padrão de extensão como persistent
  const ignoreExtensionPersistent = useCallback(async (ext: string) => {
    if (!activeProject) return
    const pattern = `*${ext}` // ex: ".css" -> "*.css"

    // Filtra selectedFiles para remover todos os arquivos que casam com esta extensão
    setSelectedFiles(prev => {
      const next = new Set(prev)
      for (const path of modifiedFiles) {
        if (path.relativePath.endsWith(ext) && !ignoredFiles.includes(path.relativePath)) {
          next.delete(path.relativePath)
        }
      }
      return next
    })

    // Persiste como persistent
    const result = await window.codeAwareness.addIgnoredFile(activeProject.path, pattern, 'persistent')
    if (result) {
      const repoIgnores = result.ignoredDiffFiles[activeProject.path]
      setPersistentPatterns(repoIgnores?.persistent || [])
      onStatusMessage(`Padrão ${pattern} ignorado permanentemente!`)
    }
  }, [activeProject, modifiedFiles, ignoredFiles, onStatusMessage])

  // Handler do botão de ocultar: abre popup se extensão comum, senão faz temporary direto
  const handleHideClick = useCallback((relativePath: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const ext = relativePath.slice(relativePath.lastIndexOf('.'))
    if (COMMON_IGNORE_EXTENSIONS.has(ext)) {
      // Abre popup de escolha
      setIgnorePopup({ path: relativePath, ext })
    } else {
      // Oculta direto como temporary
      ignoreFileTemporary(relativePath)
    }
  }, [ignoreFileTemporary])

  // Handler do popup: ignorar apenas este (temporary)
  // Nota: o toast já é disparado dentro de ignoreFileTemporary
  const handlePopupIgnoreThis = useCallback(() => {
    if (!ignorePopup) return
    ignoreFileTemporary(ignorePopup.path)
    setIgnorePopup(null)
  }, [ignorePopup, ignoreFileTemporary])

  // Handler do popup: ignorar todos os *.ext (persistent)
  const handlePopupIgnoreAll = useCallback(() => {
    if (!ignorePopup) return
    ignoreExtensionPersistent(ignorePopup.ext)
    setIgnorePopup(null)
  }, [ignorePopup, ignoreExtensionPersistent])

  // "Varrer Mesa": ignora todos os arquivos de ruído como temporary em sequência
  const handleSweepNoise = useCallback(async () => {
    if (!activeProject) return
    const noiseToIgnore = visibleFiles.filter(f => NOISE_FILES.has(f.name))

    // Ignora cada um como temporary
    for (const file of noiseToIgnore) {
      await window.codeAwareness.addIgnoredFile(activeProject.path, file.relativePath, 'temporary')
    }

    // Remove todos da seleção
    setSelectedFiles(prev => {
      const next = new Set(prev)
      for (const file of noiseToIgnore) {
        next.delete(file.relativePath)
      }
      return next
    })

    // Recarrega ignorados
    await loadIgnoredFiles()
    onStatusMessage(`${noiseToIgnore.length} arquivo(s) de ruído ignorado(s)!`)
  }, [activeProject, visibleFiles, loadIgnoredFiles, onStatusMessage])

  // Restaura um arquivo ignorado
  const handleRestoreFile = useCallback(async (relativePath: string) => {
    if (!activeProject) return
    const result = await window.codeAwareness.removeIgnoredFile(activeProject.path, relativePath, 'temporary')
    if (result) {
      const repoIgnores = result.ignoredDiffFiles[activeProject.path]
      setIgnoredFiles(repoIgnores?.temporary || [])
      onStatusMessage('Arquivo restaurado!')
    }
    setSelectedFiles(prev => {
      const next = new Set(prev)
      next.add(relativePath)
      return next
    })
  }, [activeProject, onStatusMessage])

  // Restaura todos os arquivos ignorados
  const handleRestoreAll = useCallback(async () => {
    if (!activeProject) return
    const count = ignoredFiles.length
    for (const path of ignoredFiles) {
      await window.codeAwareness.removeIgnoredFile(activeProject.path, path, 'temporary')
    }
    await loadIgnoredFiles()
    setSelectedFiles(prev => {
      const next = new Set(prev)
      for (const path of ignoredFiles) {
        next.add(path)
      }
      return next
    })
    onStatusMessage(`${count} arquivo(s) restaurado(s)!`)
  }, [activeProject, ignoredFiles, loadIgnoredFiles, onStatusMessage])

  // Restaura um padrão persistente
  const handleRestorePersistentPattern = useCallback(async (pattern: string) => {
    if (!activeProject) return
    const result = await window.codeAwareness.removeIgnoredFile(activeProject.path, pattern, 'persistent')
    if (result) {
      const repoIgnores = result.ignoredDiffFiles[activeProject.path]
      setPersistentPatterns(repoIgnores?.persistent || [])
      onStatusMessage('Padrão restaurado!')
    }
  }, [activeProject, onStatusMessage])

  // Restaura todos os padrões persistentes
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

  // Copia o diff semântico de um único arquivo
  const handleCopySingleFileDiff = useCallback(async (relativePath: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!activeProject) return

    // Gera o diff completo para o único arquivo (usa o cache se disponível)
    let markdown = await window.codeAwareness.generateSemanticDiff(activeProject.path, [relativePath])

    // Encontra o início do bloco deste arquivo pelo heading H2 exato
    // O backend gera: ## 📄 `relativePath` (tipo)
    const fileHeaderPattern = new RegExp(`^## 📄 \`${relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``, 'm')
    const match = markdown.match(fileHeaderPattern)

    if (match && match.index !== undefined) {
      const afterMatch = markdown.substring(match.index)
      // Encontra o próximo ## (próximo arquivo), se existir
      const nextFileMatch = afterMatch.match(/\n## 📄 /)
      markdown = nextFileMatch?.index !== undefined
        ? afterMatch.substring(0, nextFileMatch.index).trim()
        : afterMatch.trim()
    }

    await navigator.clipboard.writeText(markdown)
    setCopiedFile(relativePath)
    setTimeout(() => {
      setCopiedFile(null)
    }, 1500)
  }, [activeProject])







  // Gerencia o watcher
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
          // generateSemanticDiff removido: o pipeline reativo (debounce effect) é
          // o único produtor de diffMarkdown. Múltiplos escritores causavam inconsistências.
        ])

        if (!isMounted) return

        // Reconcilia os ignores usando a lista recém-obtida para este projeto.
        // Feito aqui (e não num useEffect) para garantir que os dados são do projeto atual,
        // evitando race condition ao trocar de projeto.
        const currentPaths = files.map(f => f.relativePath)
        await window.codeAwareness.reconcileIgnoredFiles(activeProject.path, currentPaths)
        if (!isMounted) return
        await loadIgnoredFiles()
        if (!isMounted) return

        // Apenas atualiza a lista de arquivos. O diff será gerado pelo debounce effect
        // assim que o Efeito 1 sincronizar selectedFiles com os novos visibleFiles.
        setModifiedFiles(files)
        setIsWatching(true)
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }

    bootstrapProject()

    const unsubscribe = window.codeAwareness.onFileChanged(async () => {
      if (!activeProject || !isMounted) return

      // Apenas busca a lista de arquivos — sem gerar diff aqui.
      // O diff será recalculado pelo pipeline reativo (debounce effect) após
      // setModifiedFiles atualizar visibleFiles e Efeito 1 atualizar selectedFiles.
      const files = await window.codeAwareness.getModifiedFiles(activeProject.path)
      if (!isMounted) return

      // Reconcilia os ignores com a lista atual do evento
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

  const handleCopyPrompt = () => {
    const finalPrompt = `${auditPromptTemplate}\n\n${diffMarkdown}`
    navigator.clipboard.writeText(finalPrompt)
    setIsCopied(true)
    setTimeout(() => setIsCopied(false), 2000)
  }

  const handleCopyMarkdown = () => {
    navigator.clipboard.writeText(diffMarkdown)
    setIsCopyMarkdown(true)
    setTimeout(() => setIsCopyMarkdown(false), 2000)
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

  const handleExportObsidian = async () => {
    // Guard clause: não exporta se não houver projeto ou markdown de diff vazio
    if (!activeProject || !diffMarkdown) return
    setIsExporting(true)
    try {
      // Obtém as configurações atuais do app
      const settings = await window.codeAwareness.loadSettings()
      let vaultPath = settings.obsidianVaultPath

      // Se não houver vault configurado, solicita que o usuário selecione uma pasta
      if (!vaultPath) {
        const selectedPath = await window.codeAwareness.selectVaultFolder()
        if (!selectedPath) return
        vaultPath = selectedPath
        await window.codeAwareness.saveSettings({ ...settings, obsidianVaultPath: vaultPath })
      }

      const name = activeProject.name + "-diff"
      await window.codeAwareness.saveToObsidian(diffMarkdown, name, vaultPath)
    } catch (err) {
      console.error("Falha ao exportar:", err)
    } finally {
      setIsExporting(false)
    }
  }

  if (!activeProject) {
    return (
      <div className="cdf-dropzone-wrapper">
        <div className="empty-selection-banner" style={{ border: 'none', background: 'transparent' }}>
          <h3>Nenhum projeto selecionado</h3>
          <p>Volte para a aba <strong>Projetos</strong> e ative um repositório para inspecionar e monitorar alterações de código.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="cdf-container">
      <div className="cdf-topbar">
        <div className="cdf-repo-info">
          <span className="cdf-repo-name">{activeProject.name}</span>
          {isLoading && <span className="cdf-status-badge loading">carregando...</span>}
          {!isLoading && isWatching && <span className="cdf-status-badge watching">● Monitorando</span>}
          {!isLoading && isGitRepo === false && (
            <span className="cdf-status-badge error">Não é um repositório Git</span>
          )}
        </div>
      </div>

      <div className="cdf-split">
        <aside className="cdf-sidebar">
          <div className="cdf-sidebar-header">
            <span className="cdf-sidebar-header-left">
              {visibleFiles.length > 0 && (
                <input
                  type="checkbox"
                  ref={masterCheckboxRef}
                  className="cdf-master-checkbox"
                  checked={selectedFiles.size === visibleFiles.length && visibleFiles.length > 0}
                  onChange={toggleMasterCheckbox}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
              <span>Arquivos alterados</span>
            </span>
            <span className="cdf-sidebar-header-right">
              {/* Botão "Limpar ruídos" — aparece se houver noise files visíveis */}
              {hasNoiseFiles && (
                <button
                  className="cdf-icon-btn"
                  title="Varrer Mesa (Limpar ruídos)"
                  onClick={handleSweepNoise}
                >
                  <svg viewBox="0 0 24 24">
                    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z" />
                    <path d="m5 3 1 2.5L8.5 6 6 7 5 9.5 4 7 1.5 6 4 5Z" />
                    <path d="m19 17 1 2.5 2.5.5-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1Z" />
                  </svg>
                </button>
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
          ) : (
            <ul className="cdf-file-list">
              {visibleFiles.map((file) => (
                <li
                  key={file.relativePath}
                  className={`cdf-file-card ${selectedFile === file.relativePath ? 'selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    className="cdf-file-checkbox"
                    checked={selectedFiles.has(file.relativePath)}
                    onChange={() => toggleFileSelection(file.relativePath)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span
                    className="cdf-file-card-body"
                    onClick={() => handleFileClick(file.relativePath)}
                  >
                    <span className={`cdf-type-badge ${file.changeType}`}>
                      {CHANGE_TYPE_LABEL[file.changeType]}
                    </span>
                    <span className="cdf-file-name" title={file.relativePath}>
                      {file.name}
                    </span>
                  </span>
                  {/* Botão de copiar diff unitário (aparece no hover) */}
                  <button
                    className="cdf-copy-btn cdf-icon-btn small"
                    title="Copiar diff deste arquivo"
                    onClick={(e) => handleCopySingleFileDiff(file.relativePath, e)}
                  >
                    {copiedFile === file.relativePath ? (
                      <svg viewBox="0 0 24 24" style={{ stroke: '#4ade80', fill: 'none', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" style={{ stroke: 'currentColor', fill: 'none', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                      </svg>
                    )}
                  </button>
                  {/* Botão de ocultar (aparece no hover) */}
                  <button
                    className="cdf-hide-btn cdf-icon-btn small"
                    title="Ocultar este arquivo"
                    onClick={(e) => handleHideClick(file.relativePath, e)}
                  >
                    <svg viewBox="0 0 24 24">
                      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                      <path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                      <line x1="2" x2="22" y1="2" y2="22" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
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

          {/* Sanfona de arquivos ignorados no rodapé (Temporários vs Permanentes) */}
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
                    title="Restaurar todos os arquivos ignorados nesta sessão"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRestoreAll()
                    }}
                  >
                    Restaurar Todos
                  </button>
                </summary>
                <ul className="cdf-ignored-list">
                  {ignoredFiles.map((path) => {
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
                  <span className="cdf-ignored-title">🔒 Ignorados no Projeto ({persistentPatterns.length})</span>
                  <button
                    className="cdf-pill-btn"
                    title="Restaurar todos os padrões persistentes"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRestoreAllPersistent()
                    }}
                  >
                    Restaurar Todos
                  </button>
                </summary>
                <ul className="cdf-ignored-list">
                  {persistentPatterns.map((pattern) => (
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

        {modifiedFiles.length === 0 ? (
          <main className="cdf-diff-panel empty-state">
            <div className="cdf-empty-hero">
              <svg viewBox="0 0 24 24" style={{ width: '48px', height: '48px', stroke: 'var(--text-secondary)', fill: 'none', strokeWidth: 1.5, margin: '0 auto 16px auto', display: 'block' }}>
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <h3>Aguardando modificações...</h3>
              <p>A pasta ativa está sendo monitorada. Salve alterações no repositório para inspecionar os blocos semânticos e realizar a auditoria.</p>
            </div>
          </main>
        ) : (
          <main className="cdf-diff-panel">
            <div className="cdf-diff-actions">
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

            <div className={`cdf-diff-code-rendered${!diffMarkdown || diffMarkdown.startsWith('# Nenhum') ? ' empty-state' : ''}`}>
              <Markdown>{diffMarkdown}</Markdown>
            </div>
          </main>
        )}
      </div>

      <div className="cdf-diff-actions-bottom">
        <button className="app-pill-btn" onClick={handleCopyPrompt}>
          {isCopied ? 'Copiado!' : 'Copiar Prompt de Auditoria'}
        </button>
        <button className="app-pill-btn" onClick={handleCopyMarkdown}>
          {isCopyMarkdown ? 'Markdown Copiado!' : 'Copiar Markdown de Diff'}
        </button>
        <button
          className="app-pill-btn"
          onClick={handleExportObsidian}
          disabled={isExporting}
        >
          {isExporting ? 'Exportando...' : 'Exportar para Obsidian'}
        </button>
      </div>
    </div>
  )
}