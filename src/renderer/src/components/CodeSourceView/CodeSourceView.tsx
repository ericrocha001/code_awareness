// Responsabilidades do Script
//
// 1. Renderizar a interface da aba Code Source com paridade de design ao CodeCompressionView.
// 2. Gerenciar a seleção reativa de arquivos com sistema de Ignore, seletor de formato (Markdown/XML) e contagem de tokens.
// 3. Monitorar alterações de arquivos em tempo real via WatcherService com debounce de 300ms.
// 4. Fornecer ações contextuais (Copiar, Salvar XML, Exportar Obsidian).

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Markdown from 'markdown-to-jsx'
import { DiffFileStatus } from '../../../../shared/types'
import { NOISE_FILES, COMMON_IGNORE_EXTENSIONS } from '../../constants/ignore-patterns'
import './CodeSourceView.css'

interface CodeSourceViewProps {
  activeProject: { path: string; name: string } | null
  onStatusMessage: (message: string, isError?: boolean) => void
}

export const CodeSourceView: React.FC<CodeSourceViewProps> = ({ activeProject, onStatusMessage }) => {
  const [trackedFiles, setTrackedFiles] = useState<DiffFileStatus[]>([])
  // Checkboxes iniciam desmarcados por padrão, diferente do CodeCompressionView
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [markdown, setMarkdown] = useState<string>('')
  const [tokenCount, setTokenCount] = useState<number>(0)
  const [format, setFormat] = useState<'markdown' | 'xml'>('markdown')
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [error, setError] = useState<string>('')
  const [isCopied, setIsCopied] = useState(false)
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

  // Lista visível
  const visibleFiles = useMemo(() => {
    return trackedFiles.filter(f => {
      if (ignoredFiles.includes(f.relativePath)) return false
      if (matchesPersistentPattern(f.relativePath)) return false
      return true
    })
  }, [trackedFiles, ignoredFiles, matchesPersistentPattern])

  const hasNoiseFiles = useMemo(() => visibleFiles.some(f => NOISE_FILES.has(f.name)), [visibleFiles])

  // Estado indeterminate do master checkbox
  useEffect(() => {
    const el = masterCheckboxRef.current
    if (!el) return
    el.indeterminate = selectedFiles.size > 0 && selectedFiles.size < visibleFiles.length
  }, [selectedFiles, visibleFiles.length])

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
    }, 300) // 300ms de debounce: tempo suficiente para salvar múltiplos arquivos sem regenerações desnecessárias

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
    setTimeout(() => setIsCopied(false), 2000)
  }

  const handleDownloadXml = async () => {
    if (!activeProject || format !== 'xml') return
    setIsExporting(true)
    try {
      const result = await window.codeAwareness.saveXml(markdown, activeProject.name)
      if (result.success) {
        onStatusMessage('XML salvo com sucesso!')
      } else if (result.error !== 'Cancelled') {
        onStatusMessage('Erro ao salvar XML', true)
      }
    } catch (err) {
      console.error('Falha ao baixar XML:', err)
      onStatusMessage('Erro ao salvar XML', true)
    } finally {
      setIsExporting(false)
    }
  }

  const handleExportObsidian = async () => {
    if (!activeProject || format !== 'markdown') return
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

      const result = await window.codeAwareness.saveToObsidian(markdown, `${activeProject.name}-source`, vaultPath)
      if (!result.success) {
        console.error('Erro na exportação para Obsidian:', result.error)
        onStatusMessage('Erro ao exportar', true)
      } else {
        onStatusMessage('Exportado para o Obsidian com sucesso!')
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
      <div className="cs-topbar">
        <div className="cs-repo-info">
          <span className="cs-repo-name">{activeProject.name}</span>
          <span className="cs-status-badge watching">● Monitorando</span>
        </div>
      </div>

      <div className="cs-split">
        {/* Sidebar com lista de arquivos tracked */}
        <aside className="cs-sidebar">
          <div className="cs-sidebar-header">
            <span className="cs-sidebar-header-left">
              {visibleFiles.length > 0 && (
                <input
                  type="checkbox"
                  ref={masterCheckboxRef}
                  className="cs-master-checkbox"
                  checked={selectedFiles.size === visibleFiles.length && visibleFiles.length > 0}
                  onChange={toggleMasterCheckbox}
                  onClick={(e) => e.stopPropagation()}
                />
              )}
              <span>Arquivos Tracked</span>
            </span>
            <span className="cs-sidebar-header-right">
              {hasNoiseFiles && (
                <button
                  className="cs-icon-btn"
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
              <span className="cs-count-badge">{trackedFiles.length}</span>
            </span>
          </div>

          {visibleFiles.length === 0 && trackedFiles.length === 0 ? (
            <p className="cs-empty-state">Nenhum arquivo encontrado.</p>
          ) : visibleFiles.length === 0 ? (
            <p className="cs-empty-state">Todos os arquivos estão ocultos.</p>
          ) : (
            <ul className="cs-file-list">
              {visibleFiles.map((file) => (
                <li
                  key={file.relativePath}
                  className="cs-file-card"
                >
                  <input
                    type="checkbox"
                    className="cs-file-checkbox"
                    checked={selectedFiles.has(file.relativePath)}
                    onChange={() => toggleFileSelection(file.relativePath)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span
                    className="cs-file-card-body"
                    onClick={() => toggleFileSelection(file.relativePath)}
                  >
                    <span className="cs-file-name" title={file.relativePath}>{file.name}</span>
                  </span>
                  <button
                    className="cs-hide-btn cs-icon-btn small"
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

        {/* Painel principal de renderização */}
        <main className="cs-diff-panel">
          <div className="cs-diff-actions" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label htmlFor="format-select" style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Formato:</label>
              <select
                id="format-select"
                value={format}
                onChange={handleFormatChange}
                className="cs-format-select"
                style={{ padding: '4px 8px', borderRadius: '4px', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              >
                <option value="markdown">Markdown</option>
                <option value="xml">XML</option>
              </select>
            </div>
            
            {/* Contagem de Tokens */}
            <div className="cs-token-panel" style={{ padding: '8px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '16px', alignItems: 'center' }}>
              <strong>Total: {tokenCount > 0 ? tokenCount.toLocaleString('pt-BR') : 'Indisponível'} tokens</strong>
            </div>
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

      {/* Barra de ações inferior */}
      <div className="cs-diff-actions-bottom">
        <button className="app-pill-btn" onClick={handleCopy} disabled={!markdown || isGenerating}>
          {isCopied ? 'Copiado!' : `Copiar ${format.toUpperCase()}`}
        </button>
        {format === 'xml' && (
          <button className="app-pill-btn" onClick={handleDownloadXml} disabled={!markdown || isGenerating || isExporting}>
            {isExporting ? 'Baixando...' : 'Baixar XML'}
          </button>
        )}
        {format === 'markdown' && (
          <button className="app-pill-btn" onClick={handleExportObsidian} disabled={!markdown || isGenerating || isExporting}>
            {isExporting ? 'Exportando...' : 'Exportar para Obsidian'}
          </button>
        )}
      </div>
    </div>
  )
}
