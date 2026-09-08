import React, { useState, useEffect } from 'react'
import type { CodeMapFile } from '../../../../shared/types'
import { CodeSnippetBlock } from './CodeSnippetBlock'
import './CodeMapCodeView.css'

interface CodeMapCodeViewProps {
  file: CodeMapFile | null
  repoPath: string
}

/** Extrai o nome do arquivo a partir do caminho relativo. */
function getFileName(relativePath: string): string {
  return relativePath.split('/').pop() ?? relativePath
}

export const CodeMapCodeView: React.FC<CodeMapCodeViewProps> = ({ file, repoPath }) => {
  const [content, setContent] = useState<{ content: string; truncated: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Carrega o arquivo integral quando a seleção muda — cleanup cancela chamadas obsoletas
  useEffect(() => {
    if (!file) {
      setContent(null)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setContent(null)

    window.codeAwareness
      .getFileContent(repoPath, file.relativePath)
      .then((result) => {
        if (cancelled) return
        if (result.success && result.data) {
          setContent({ content: result.data.content, truncated: result.data.truncated })
        } else {
          setError('Arquivo não encontrado ou ilegível.')
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [file, repoPath])

  if (!file) {
    return <div className="cmcv-empty">Selecione um arquivo para ver o código completo.</div>
  }

  return (
    <div className="cmcv-root">
      {loading && <div className="cmcv-state">Carregando arquivo...</div>}
      {error && <div className="cmcv-state cmcv-state--error">{error}</div>}
      {content && !loading && (
        <CodeSnippetBlock
          code={content.content}
          language={file.language}
          fileName={getFileName(file.relativePath)}
          truncated={content.truncated}
        />
      )}
    </div>
  )
}