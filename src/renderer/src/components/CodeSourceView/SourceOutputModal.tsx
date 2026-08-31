/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar a interface do modal de geração do Code Source com layout em duas colunas (configuração à esquerda e preview à direita).
2. Integrar os hooks useSourceGeneration e useSourceSettings para ciclo de vida de geração, debounce, deduplicação e persistência.
3. Renderizar o preview do documento utilizando o componente virtualizado SourcePreviewVirtualized.
4. Refletir dependências de UI entre opções de estrutura e fornecer ações de cópia e exportação sobre o conteúdo integral.

Mapa de Relacionamentos do Script

1. hooks/useSourceGeneration.ts
   - Tipo: Dependência Direta
   - Relação: Gerencia o ciclo de vida e estado de geração com debounce e deduplicação.
   - Criticidade: Alta

2. hooks/useSourceSettings.ts
   - Tipo: Dependência Direta
   - Relação: Gerencia hidratação, autosave debounced e flush de configurações.
   - Criticidade: Alta

3. SourcePreviewVirtualized.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza o preview virtualizado por linhas com syntax highlighting.
   - Criticidade: Alta

4. window.codeAwareness.saveToDownloads / exportToNotebookLM
   - Tipo: Dependência Inversa
   - Relação: Executa a exportação do documento gerado.
   - Criticidade: Alta

5. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece SourceOutputFormat e SourceProfile.
   - Criticidade: Alta

6. SourceOutputModal.css
   - Tipo: Relação de UI
   - Relação: Estiliza o modal com prefixo som-.
   - Criticidade: Alta

Invariantes do Script

1. O último preview válido permanece visível durante novas gerações até a conclusão da nova requisição.
2. Ações de cópia e exportação utilizam estritamente o conteúdo integral em memória (lastCompletedDocument.content).
3. Opções filhas de estrutura são desabilitadas na UI quando a estrutura pai estiver desligada, preservando seus valores internos no perfil.
4. O fechamento do modal aciona o flush imediato de configurações pendentes via useSourceSettings.
5. A exportação para NotebookLM é desabilitada quando o formato selecionado não for Markdown.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Download, BookOpen, X } from 'lucide-react'
import type { SourceOutputFormat, SourceProfile } from '../../../../shared/types'
import { outputFormatToExtension } from '../../../../shared/utils/format-utils'
import { Button } from '../shared/Button/Button'
import { ToggleSwitch } from '../ToggleSwitch/ToggleSwitch'
import { SourcePreviewVirtualized } from './SourcePreviewVirtualized'
import { useSourceGeneration } from './hooks/useSourceGeneration'
import { useSourceSettings } from './hooks/useSourceSettings'
import './SourceOutputModal.css'

const FORMAT_OPTIONS: { value: SourceOutputFormat; label: string }[] = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'xml', label: 'XML' }
]

interface SourceOutputModalProps {
  isOpen: boolean
  onClose: () => void
  repoPath: string
  selectedFiles: string[]
  onStatusMessage?: (message: string, isError?: boolean) => void
}

export const SourceOutputModal: React.FC<SourceOutputModalProps> = ({
  isOpen,
  onClose,
  repoPath,
  selectedFiles,
  onStatusMessage
}) => {
  // ─── Hooks de Configuração e Geração ─────────────────────────────────────
  const {
    ready,
    outputFormat,
    setOutputFormat,
    profile,
    setProfile
  } = useSourceSettings({ isOpen })

  const {
    isGenerating,
    lastCompletedDocument,
    error: generationError
  } = useSourceGeneration({
    repoPath,
    selectedFiles,
    format: outputFormat,
    profile,
    sessionKey: repoPath
  })

  // ─── Estado Local ────────────────────────────────────────────────────────
  const [fileName, setFileName] = useState('code-source')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'success' | 'error'>('idle')

  const onStatusMessageRef = useRef(onStatusMessage)
  useEffect(() => {
    onStatusMessageRef.current = onStatusMessage
  }, [onStatusMessage])

  // Emite status de erro se a geração falhar
  useEffect(() => {
    if (generationError) {
      onStatusMessageRef.current?.(generationError, true)
    }
  }, [generationError])

  // ─── Fechamento por tecla ESC ───────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  // ─── Handlers de configuração ────────────────────────────────────────────
  const updateProfile = useCallback((patch: Partial<SourceProfile>) => {
    setProfile({ ...profile, ...patch })
  }, [profile, setProfile])

  // ─── Ações de cópia e exportação ─────────────────────────────────────────
  const handleCopy = useCallback(async () => {
    if (!lastCompletedDocument?.content) return
    try {
      await navigator.clipboard.writeText(lastCompletedDocument.content)
      setCopyStatus('success')
      onStatusMessageRef.current?.('Código fonte copiado!')
      setTimeout(() => setCopyStatus('idle'), 2000)
    } catch {
      setCopyStatus('error')
      onStatusMessageRef.current?.('Erro ao copiar', true)
      setTimeout(() => setCopyStatus('idle'), 2000)
    }
  }, [lastCompletedDocument])

  const handleExport = useCallback(async () => {
    if (!lastCompletedDocument?.content) return
    try {
      const result = await window.codeAwareness.saveToDownloads(
        lastCompletedDocument.content,
        fileName,
        outputFormat
      )
      if (result.success) {
        onStatusMessageRef.current?.('Exportado para Downloads!')
      } else {
        onStatusMessageRef.current?.(result.error || 'Erro ao exportar', true)
      }
    } catch {
      onStatusMessageRef.current?.('Erro ao exportar', true)
    }
  }, [lastCompletedDocument, fileName, outputFormat])

  const handleExportNotebookLM = useCallback(async () => {
    if (!lastCompletedDocument?.content || outputFormat !== 'markdown') return
    try {
      const result = await window.codeAwareness.exportToNotebookLM(
        lastCompletedDocument.content,
        fileName
      )
      if (result.success) {
        const message =
          result.fileCount === 1
            ? 'Exportado para Downloads (.docx)!'
            : `Exportado ${result.fileCount} arquivo(s) .docx para Downloads!`
        onStatusMessageRef.current?.(message)
      } else {
        onStatusMessageRef.current?.(result.error || 'Erro ao exportar para NotebookLM', true)
      }
    } catch {
      onStatusMessageRef.current?.('Erro ao exportar para NotebookLM', true)
    }
  }, [lastCompletedDocument, fileName, outputFormat])

  if (!isOpen) return null

  const fileExtension = outputFormatToExtension(outputFormat)
  const tokenCount = lastCompletedDocument?.tokenCount
  const hasDocument = Boolean(lastCompletedDocument?.content)

  return (
    <div className="som-overlay" onClick={onClose}>
      <div className="som-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="som-header">
          <h3>Gerar Code Source</h3>
          <button className="som-close" onClick={onClose} aria-label="Fechar">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="som-body">
          {/* ─── Coluna esquerda: Configuração ─────────────────────────── */}
          <div className="som-config">
            {/* Formato */}
            <section className="som-section">
              <h4>Formato</h4>
              <div className="som-format-options">
                {FORMAT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`app-ghost-btn som-format-btn${outputFormat === opt.value ? ' active' : ''}`}
                    onClick={() => setOutputFormat(opt.value)}
                    disabled={!ready}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </section>

            {/* Conteúdo */}
            <section className="som-section">
              <h4>Conteúdo</h4>
              <label className="som-toggle">
                <span>Remover comentários</span>
                <ToggleSwitch
                  checked={profile.removeComments}
                  onChange={(v) => updateProfile({ removeComments: v })}
                  disabled={!ready}
                />
              </label>
              <label className="som-toggle">
                <span>Remover linhas vazias</span>
                <ToggleSwitch
                  checked={profile.removeEmptyLines}
                  onChange={(v) => updateProfile({ removeEmptyLines: v })}
                  disabled={!ready}
                />
              </label>
              <label className="som-toggle">
                <span>Truncar base64</span>
                <ToggleSwitch
                  checked={profile.truncateBase64}
                  onChange={(v) => updateProfile({ truncateBase64: v })}
                  disabled={!ready}
                />
              </label>
            </section>

            {/* Apresentação */}
            <section className="som-section">
              <h4>Apresentação</h4>
              <label className="som-toggle">
                <span>Números de linha</span>
                <ToggleSwitch
                  checked={profile.showLineNumbers}
                  onChange={(v) => updateProfile({ showLineNumbers: v })}
                  disabled={!ready}
                />
              </label>
              <label className="som-toggle">
                <span>Estilo analisável</span>
                <ToggleSwitch
                  checked={profile.parsableStyle}
                  onChange={(v) => updateProfile({ parsableStyle: v })}
                  disabled={!ready}
                />
              </label>
            </section>

            {/* Estrutura */}
            <section className="som-section">
              <h4>Estrutura</h4>
              <label className="som-toggle">
                <span>Incluir resumo de arquivo</span>
                <ToggleSwitch
                  checked={profile.includeFileSummary}
                  onChange={(v) => updateProfile({ includeFileSummary: v })}
                  disabled={!ready}
                />
              </label>
              <label className="som-toggle">
                <span>Incluir estrutura de diretórios</span>
                <ToggleSwitch
                  checked={profile.includeDirectoryStructure}
                  onChange={(v) => updateProfile({ includeDirectoryStructure: v })}
                  disabled={!ready}
                />
              </label>
              <label className="som-toggle">
                <span>Incluir diretórios vazios</span>
                <ToggleSwitch
                  checked={profile.includeEmptyDirectories}
                  onChange={(v) => updateProfile({ includeEmptyDirectories: v })}
                  disabled={!ready || !profile.includeDirectoryStructure}
                />
              </label>
              <label className="som-toggle">
                <span>Incluir estrutura completa de diretórios</span>
                <ToggleSwitch
                  checked={profile.includeFullDirectoryStructure}
                  onChange={(v) => updateProfile({ includeFullDirectoryStructure: v })}
                  disabled={!ready || !profile.includeDirectoryStructure}
                />
              </label>
            </section>

            {/* Nome do arquivo */}
            <section className="som-section">
              <h4>Nome do arquivo</h4>
              <div className="som-filename">
                <input
                  type="text"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value.replace(/[\\/:*?"<>|]/g, ''))}
                  className="som-filename-input"
                  disabled={!ready}
                />
                <span className="som-filename-ext">{fileExtension}</span>
              </div>
            </section>
          </div>

          {/* ─── Coluna direita: Preview ───────────────────────────────── */}
          <div className="som-preview">
            <div className="som-preview-bar">
              <span className="som-preview-title">Preview</span>
              {isGenerating && <span className="som-generating">Gerando saída...</span>}
              {!isGenerating && typeof tokenCount === 'number' && tokenCount > 0 && (
                <span className="som-token-count">{tokenCount} tokens</span>
              )}
            </div>
            <div className="som-preview-content">
              {generationError && !hasDocument ? (
                <pre className="som-error">{generationError}</pre>
              ) : hasDocument ? (
                <SourcePreviewVirtualized
                  content={lastCompletedDocument!.content}
                  format={outputFormat}
                />
              ) : isGenerating ? (
                <pre className="som-placeholder">Gerando visualização inicial...</pre>
              ) : (
                <pre>Nenhuma saída gerada ainda.</pre>
              )}
            </div>
          </div>
        </div>

        {/* ─── Rodapé ──────────────────────────────────────────────────── */}
        <div className="som-footer">
          <Button
            variant="pill"
            icon={<Copy size={14} strokeWidth={2} />}
            onClick={handleCopy}
            disabled={!ready || !hasDocument}
          >
            {copyStatus === 'success' ? 'Copiado!' : copyStatus === 'error' ? 'Erro' : 'Copiar para a área de transferência'}
          </Button>
          <Button
            variant="pill"
            icon={<Download size={14} strokeWidth={2} />}
            onClick={handleExport}
            disabled={!ready || !hasDocument}
          >
            Exportar como arquivo
          </Button>
          <Button
            variant="pill"
            icon={<BookOpen size={14} strokeWidth={2} />}
            onClick={handleExportNotebookLM}
            disabled={!ready || !hasDocument || outputFormat !== 'markdown'}
          >
            Exportar para NotebookLM
          </Button>
        </div>
      </div>
    </div>
  )
}
