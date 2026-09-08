/*
-T ---
*/

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Download, X } from 'lucide-react'
import type {
  CompressionProfile,
  ContextEnrichment,
  OutputFormat
} from '../../../../shared/types'
import { DEFAULT_PROFILE, normalizeCompressionProfile } from '../../utils/compression-profile'
import { outputFormatToExtension } from '../../../../shared/utils/format-utils'
import { Button } from '../shared/Button/Button'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import { FormatPreview } from '../shared/FormatPreview/FormatPreview'
import './OutputModal.css'

// Chave do prompt no localStorage — mesmo padrão do PromptEditorModal / CodeCompressionView.
const PROMPT_STORAGE_KEY = 'code_compression_prompt_template'

// Debounce da regeração do preview e do autosave.
const GENERATE_DEBOUNCE_MS = 300
const SAVE_DEBOUNCE_MS = 500

const FORMAT_OPTIONS: { value: OutputFormat; label: string }[] = [
  { value: 'plain', label: 'Plain' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'xml', label: 'XML' },
  { value: 'json', label: 'JSON' }
]

interface OutputModalProps {
  isOpen: boolean
  onClose: () => void
  repoPath: string
  selectedFiles: string[]
  onStatusMessage?: (message: string, isError?: boolean) => void
}

export const OutputModal: React.FC<OutputModalProps> = ({
  isOpen,
  onClose,
  repoPath,
  selectedFiles,
  onStatusMessage
}) => {
  // ─── Estado ──────────────────────────────────────────────────────────────
  const [ready, setReady] = useState(false)
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('plain')
  const [profile, setProfile] = useState<CompressionProfile>(DEFAULT_PROFILE)
  const [enrichment, setEnrichment] = useState<ContextEnrichment | undefined>(undefined)
  const [fileName, setFileName] = useState('code-awareness-compression')
  const [includePrompt, setIncludePrompt] = useState(false)
  const [preview, setPreview] = useState('')
  const [previewFormat, setPreviewFormat] = useState<OutputFormat>('plain')
  const [isGenerating, setIsGenerating] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle')


  // ─── Refs ────────────────────────────────────────────────────────────────
  const genTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const genTokenRef = useRef(0)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipSaveRef = useRef(false)
  const settingsRef = useRef({ outputFormat, profile, enrichment })
  const onStatusMessageRef = useRef(onStatusMessage)

  useEffect(() => {
    onStatusMessageRef.current = onStatusMessage
  }, [onStatusMessage])

  // Mantém as configurações atuais acessíveis nos timers de persistência.
  useEffect(() => {
    settingsRef.current = { outputFormat, profile, enrichment }
  }, [outputFormat, profile, enrichment])

  /**
   * Persiste as configurações atuais (lidas de settingsRef) preservando o restante de AppSettings.
   * Só inclui enrichment quando há conteúdo, mantendo o settings.json limpo.
   */
  const persistConfig = useCallback(() => {
    const { outputFormat: of, profile: p, enrichment: e } = settingsRef.current
    window.codeAwareness
      .loadSettings()
      .then((settings) => {
        window.codeAwareness.saveSettings({
          ...settings,
          compressionSettings: { profile: p, outputFormat: of, ...(e ? { enrichment: e } : {}) }
        })
      })
      .catch(() => { /* falha silenciosa de persistência não deve travar o modal */ })
  }, [])

  // ─── Hidratação ao abrir ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) {
      setReady(false)
      return
    }
    let cancelled = false
    // Pula o save da primeira hidratação (evita gravar valores recém-carregados).
    skipSaveRef.current = true

    ;(async () => {
      try {
        const settings = await window.codeAwareness.loadSettings()
        if (cancelled) return
        const cs = settings.compressionSettings
        setOutputFormat(cs?.outputFormat ?? 'plain')
        setProfile(cs?.profile ? normalizeCompressionProfile(cs.profile) : DEFAULT_PROFILE)
        setEnrichment(cs?.enrichment)
      } catch {
        if (cancelled) return
        setOutputFormat('plain')
        setProfile(DEFAULT_PROFILE)
        setEnrichment(undefined)
      } finally {
        if (!cancelled) setReady(true)
      }
    })()

    return () => { cancelled = true }
  }, [isOpen])

  // ─── Persistência automática (debounced) ─────────────────────────────────
  useEffect(() => {
    if (!isOpen || !ready) return
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      persistConfig()
    }, SAVE_DEBOUNCE_MS)

    return () => {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    }
  }, [isOpen, ready, outputFormat, profile, enrichment, persistConfig])

  // Flush do save pendente no fechamento (ex.: texto livre editado instantes antes).
  useEffect(() => {
    if (isOpen) return
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      persistConfig()
    }
  }, [isOpen, persistConfig])

  // ─── Geração reativa com debounce + stale protection ─────────────────────
  useEffect(() => {
    if (!isOpen || !ready) return
    if (selectedFiles.length === 0) {
      setPreview('')
      setPreviewFormat('plain')
      setIsGenerating(false)
      return
    }
    if (genTimerRef.current) clearTimeout(genTimerRef.current)

    const token = ++genTokenRef.current
    setIsGenerating(true)

    genTimerRef.current = setTimeout(async () => {
      genTimerRef.current = null
      try {
        const result = await window.codeAwareness.generateCompressionMarkdown(repoPath, selectedFiles, {
          profile,
          outputFormat,
          enrichment
        })
        // Stale protection: descarta resultado se um token mais novo já existe.
        // O formato do preview acompanha o conteúdo gerado (D4), capturado no disparo,
        // evitando que o renderer de um formato novo atinja conteúdo do formato antigo.
        if (token === genTokenRef.current) {
          setPreview(result)
          setPreviewFormat(outputFormat)
          setIsGenerating(false)
        }
      } catch (err) {
        if (token === genTokenRef.current) {
          setIsGenerating(false)
          onStatusMessageRef.current?.(
            err instanceof Error ? err.message : 'Falha ao gerar a saída de compressão.',
            true
          )
        }
      }
    }, GENERATE_DEBOUNCE_MS)

    return () => {
      if (genTimerRef.current) { clearTimeout(genTimerRef.current); genTimerRef.current = null }
    }
  }, [isOpen, ready, repoPath, selectedFiles, outputFormat, profile, enrichment])


  // ─── Fechamento (ESC/overlay) ───────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  // ─── Handlers de configuração ────────────────────────────────────────────
  const updateProfile = useCallback((patch: Partial<CompressionProfile>) => {
    setProfile(prev => ({ ...prev, ...patch }))
  }, [])

  const updateEnrichment = useCallback((patch: Partial<ContextEnrichment>) => {
    setEnrichment(prev => ({ ...(prev ?? {}), ...patch }))
  }, [])

  // Constrói o conteúdo final: se includePrompt ativo, prepende o prompt do localStorage.
  const buildFinalContent = useCallback((): string => {
    if (!includePrompt) return preview
    const prompt = localStorage.getItem(PROMPT_STORAGE_KEY) ?? ''
    return prompt ? `${prompt}\n\n${preview}` : preview
  }, [includePrompt, preview])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildFinalContent())
      setCopyStatus('success')
      onStatusMessageRef.current?.('Saída copiada!')
      setTimeout(() => setCopyStatus('idle'), 2000)
    } catch {
      setCopyStatus('error')
      onStatusMessageRef.current?.('Erro ao copiar', true)
      setTimeout(() => setCopyStatus('idle'), 2000)
    }
  }, [buildFinalContent])

  const handleExport = useCallback(async () => {
    // Envia somente o nome-base e o formato; o backend deriva a extensão (fonte única).
    try {
      const result = await window.codeAwareness.saveToDownloads(buildFinalContent(), fileName, outputFormat)
      if (result.success) {
        onStatusMessageRef.current?.('Exportado para Downloads!')
      } else {
        onStatusMessageRef.current?.('Erro ao exportar', true)
      }
    } catch {
      onStatusMessageRef.current?.('Erro ao exportar', true)
    }
  }, [buildFinalContent, fileName, outputFormat])

  if (!isOpen) return null

  const showStructure = outputFormat === 'markdown' || outputFormat === 'xml' || outputFormat === 'json'
  const fileExtension = outputFormatToExtension(outputFormat)
  // Enrichment (Contexto adicional) não se aplica aos formatos XML e JSON (limitação atual do
  // backend na Sprint 6.1). Desabilar preserva o estado dos campos — nunca zerados al alternar.
  const enrichmentDisabled = !ready || outputFormat === 'xml' || outputFormat === 'json'

  return (
    <div className="om-overlay" onClick={onClose}>
      <div className="om-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="om-header">
          <h3>Gerar Saída</h3>
          <button className="om-close" onClick={onClose} aria-label="Fechar">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="om-body">
          {/* ─── Coluna esquerda: Configuração ─────────────────────────── */}
          <div className="om-config">


            {/* Formato */}
            <section className="om-section">
              <h4>Formato</h4>
              <div className="om-format-options">
                {FORMAT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`app-ghost-btn om-format-btn${outputFormat === opt.value ? ' active' : ''}`}
                    onClick={() => setOutputFormat(opt.value)}
                    disabled={!ready}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </section>

            {/* Compressão */}
            <section className="om-section">
              <h4>Compressão</h4>
              <label className="om-toggle"><span>Remover comentários</span><ToggleSwitch checked={profile.removeComments} onChange={(v) => updateProfile({ removeComments: v })} disabled={!ready} /></label>
              <label className="om-toggle"><span>Remover linhas vazias</span><ToggleSwitch checked={profile.removeEmptyLines} onChange={(v) => updateProfile({ removeEmptyLines: v })} disabled={!ready} /></label>
              <label className="om-toggle"><span>Truncar base64</span><ToggleSwitch checked={profile.truncateBase64} onChange={(v) => updateProfile({ truncateBase64: v })} disabled={!ready} /></label>
            </section>

            {/* Estrutura — visível apenas no caminho Direct Output (markdown/xml). */}
            {showStructure && (
              <section className="om-section">
                <h4>Estrutura</h4>
                <label className="om-toggle"><span>Incluir resumo de arquivo</span><ToggleSwitch checked={profile.includeFileSummary} onChange={(v) => updateProfile({ includeFileSummary: v })} disabled={!ready} /></label>
                <label className="om-toggle"><span>Incluir estrutura de diretórios</span><ToggleSwitch checked={profile.includeDirectoryStructure} onChange={(v) => updateProfile({ includeDirectoryStructure: v })} disabled={!ready} /></label>
                <label className="om-toggle"><span>Incluir diretórios vazios</span><ToggleSwitch checked={profile.includeEmptyDirectories} onChange={(v) => updateProfile({ includeEmptyDirectories: v })} disabled={!ready} /></label>
                <label className="om-toggle"><span>Incluir estrutura completa de diretórios</span><ToggleSwitch checked={profile.includeFullDirectoryStructure} onChange={(v) => updateProfile({ includeFullDirectoryStructure: v })} disabled={!ready} /></label>
              </section>
            )}

            {/* Contexto adicional */}
            <section className="om-section">
              <h4>Contexto adicional</h4>
              {(outputFormat === 'xml' || outputFormat === 'json') && (
                <p className="om-limitation-note">
                  Contexto adicional não se aplica aos formatos XML e JSON (limitação atual).
                </p>
              )}
              <label className="om-field">
                <span>Texto do cabeçalho</span>
                <textarea
                  rows={3}
                  value={enrichment?.headerText ?? ''}
                  onChange={(e) => updateEnrichment({ headerText: e.target.value })}
                  disabled={enrichmentDisabled}
                />
              </label>
              <label className="om-field">
                <span>Arquivo de instruções (relativo)</span>
                <input
                  type="text"
                  value={enrichment?.instructionFilePath ?? ''}
                  onChange={(e) => updateEnrichment({ instructionFilePath: e.target.value })}
                  placeholder="docs/instrucoes.md"
                  disabled={enrichmentDisabled}
                />
              </label>
              <label className="om-toggle"><span>Incluir diffs do working tree</span><ToggleSwitch checked={enrichment?.includeDiffs ?? false} onChange={(v) => updateEnrichment({ includeDiffs: v })} disabled={enrichmentDisabled} /></label>
              <label className="om-toggle"><span>Incluir logs do Git</span><ToggleSwitch checked={enrichment?.includeLogs ?? false} onChange={(v) => updateEnrichment({ includeLogs: v })} disabled={enrichmentDisabled} /></label>
              <label className="om-field">
                <span>Nº de commits nos logs</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={enrichment?.includeLogsCount ?? ''}
                  onChange={(e) => updateEnrichment({ includeLogsCount: e.target.value === '' ? undefined : Number(e.target.value) })}
                  disabled={enrichmentDisabled}
                />
              </label>
            </section>


            {/* Instruções para IA */}
            <section className="om-section">
              <h4>Instruções para IA</h4>
              <label className="om-toggle" title="Prepend o prompt de auditoria (salvo no editor de prompt) ao conteúdo gerado.">
                <span>Incluir instruções para análise por IA</span>
                <ToggleSwitch checked={includePrompt} onChange={setIncludePrompt} disabled={!ready} />
              </label>
            </section>

            {/* Nome do arquivo */}
            <section className="om-section">
              <h4>Nome do arquivo</h4>
              <div className="om-filename">
                <input
                  type="text"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value.replace(/[\\/:*?"<>|]/g, ''))}
                  className="om-filename-input"
                  disabled={!ready}
                />
                <span className="om-filename-ext">{fileExtension}</span>
              </div>
            </section>
          </div>

          {/* ─── Coluna direita: Preview ───────────────────────────────── */}
          <div className="om-preview">
            <div className="om-preview-bar">
              <span className="om-preview-title">Preview</span>
              {isGenerating && <span className="om-generating">Gerando saída...</span>}
            </div>
            <div className="om-preview-content">
              {!preview ? (
                <pre>Nenhuna saída gerada ainda.</pre>
              ) : (
                <FormatPreview content={preview} format={previewFormat} />
              )}
            </div>
          </div>
        </div>

        {/* ─── Rodapé ──────────────────────────────────────────────────── */}
        <div className="om-footer">
          <Button
            variant="pill"
            icon={<Copy size={14} strokeWidth={2} />}
            onClick={handleCopy}
            disabled={!ready}
          >
            {copyStatus === 'success' ? 'Copiado!' : copyStatus === 'error' ? 'Erro' : 'Copiar para a área de transferência'}
          </Button>
          <Button
            variant="pill"
            icon={<Download size={14} strokeWidth={2} />}
            onClick={handleExport}
            disabled={!ready}
          >
            Exportar como arquivo
          </Button>
        </div>
      </div>
    </div>
  )
}

