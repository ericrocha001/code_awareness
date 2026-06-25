// Responsabilidades do Script
//
// 1. Renderizar a interface dividida para a aba Code Compression com paridade de design ao CodeDiffView.
// 2. Gerenciar a seleção reativa de arquivos rastreados com sistema completo de Ignore (temporary/persistent).
// 3. Fornecer exportação dinâmica para Obsidian e prompt de auditoria customizável via localStorage.

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Markdown from 'markdown-to-jsx'
import { DiffFileStatus } from '../../../../shared/types'
import { NOISE_FILES, COMMON_IGNORE_EXTENSIONS } from '../../constants/ignore-patterns'
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
}

export const CodeCompressionView: React.FC<CodeCompressionViewProps> = ({ activeProject }) => {
  const [trackedFiles, setTrackedFiles] = useState<DiffFileStatus[]>([])
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [markdown, setMarkdown] = useState<string>('')
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [error, setError] = useState<string>('')
  const [auditPromptTemplate, setAuditPromptTemplate] = useState('')
  const [isCopied, setIsCopied] = useState(false)
  const [isCopyMarkdown, setIsCopyMarkdown] = useState(false)
  const [isExporting, setIsExporting] = useState(false)

  // Ignore system
  const [ignoredFiles, setIgnoredFiles] = useState<string[]>([])
  const [persistentPatterns, setPersistentPatterns] = useState<string[]>([])
  const [ignoredAccordionOpen, setIgnoredAccordionOpen] = useState(false)
  const [ignorePopup, setIgnorePopup] = useState<{ path: string; ext: string } | null>(null)

  const masterCheckboxRef = useRef<HTMLInputElement>(null)
  const ignorePopupRef = useRef<HTMLDivElement>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)

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

  // Lista visível: filtra ignorados e padrões persistentes da lista bruta
  const visibleFiles = useMemo(() => {
    return trackedFiles.filter(f => {
      if (ignoredFiles.includes(f.relativePath)) return false
      if (matchesPersistentPattern(f.relativePath)) return false
      return true
    })
  }, [trackedFiles, ignoredFiles, matchesPersistentPattern])

  // Detecta arquivos de ruído na lista visível
  const hasNoiseFiles = useMemo(() => visibleFiles.some(f => NOISE_FILES.has(f.name)), [visibleFiles])

  // Mantém o estado indeterminate do master checkbox via ref
  useEffect(() => {
    const el = masterCheckboxRef.current
    if (!el) return
    el.indeterminate = selectedFiles.size > 0 && selectedFiles.size < visibleFiles.length
  }, [selectedFiles, visibleFiles.length])

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
    if (result) setIgnoredFiles(result.ignoredDiffFiles[activeProject.path]?.temporary || [])
  }, [activeProject])

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
    if (result) setPersistentPatterns(result.ignoredDiffFiles[activeProject.path]?.persistent || [])
  }, [activeProject, trackedFiles])

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
  }, [activeProject, visibleFiles, loadIgnoredFiles])

  const handleRestoreFile = useCallback(async (relativePath: string) => {
    if (!activeProject) return
    const result = await window.codeAwareness.removeIgnoredFile(activeProject.path, relativePath, 'temporary')
    if (result) setIgnoredFiles(result.ignoredDiffFiles[activeProject.path]?.temporary || [])
    setSelectedFiles(prev => { const next = new Set(prev); next.add(relativePath); return next })
  }, [activeProject])

  const handleRestoreAll = useCallback(async () => {
    if (!activeProject) return
    for (const path of ignoredFiles) {
      await window.codeAwareness.removeIgnoredFile(activeProject.path, path, 'temporary')
    }
    await loadIgnoredFiles()
    setSelectedFiles(prev => { const next = new Set(prev); ignoredFiles.forEach(p => next.add(p)); return next })
  }, [activeProject, ignoredFiles, loadIgnoredFiles])

  const handleRestorePersistentPattern = useCallback(async (pattern: string) => {
    if (!activeProject) return
    const result = await window.codeAwareness.removeIgnoredFile(activeProject.path, pattern, 'persistent')
    if (result) setPersistentPatterns(result.ignoredDiffFiles[activeProject.path]?.persistent || [])
  }, [activeProject])

  const handleRestoreAllPersistent = useCallback(async () => {
    if (!activeProject) return
    for (const pattern of persistentPatterns) {
      await window.codeAwareness.removeIgnoredFile(activeProject.path, pattern, 'persistent')
    }
    await loadIgnoredFiles()
  }, [activeProject, persistentPatterns, loadIgnoredFiles])

  // Promove um arquivo temporário para persistente
  const handleUpgradeToPersistent = useCallback(async (relativePath: string) => {
    if (!activeProject) return
    await window.codeAwareness.removeIgnoredFile(activeProject.path, relativePath, 'temporary')
    await window.codeAwareness.addIgnoredFile(activeProject.path, relativePath, 'persistent')
    await loadIgnoredFiles()
  }, [activeProject, loadIgnoredFiles])

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
              <span>Arquivos Tracked</span>
            </span>
            <span className="cdf-sidebar-header-right">
              {/* Botão Varrer Mesa — visível quando há arquivos de ruído */}
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
              <span className="cdf-count-badge">{trackedFiles.length}</span>
            </span>
          </div>

          {visibleFiles.length === 0 && trackedFiles.length === 0 ? (
            <p className="cdf-empty-state">Nenhum arquivo encontrado.</p>
          ) : visibleFiles.length === 0 ? (
            <p className="cdf-empty-state">Todos os arquivos estão ocultos.</p>
          ) : (
            <ul className="cdf-file-list">
              {visibleFiles.map((file) => (
                <li
                  key={file.relativePath}
                  className="cdf-file-card"
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
                    onClick={() => toggleFileSelection(file.relativePath)}
                  >
                    <span className="cdf-file-name" title={file.relativePath}>{file.name}</span>
                  </span>
                  {/* Botão ocultar — aparece no hover */}
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

          <div className="cdf-diff-code-rendered">
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
                <svg viewBox="0 0 24 24" style={{ width: '48px', height: '48px', stroke: 'var(--text-secondary)', fill: 'none', strokeWidth: 1.5, margin: '0 auto 16px auto', display: 'block' }}>
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
