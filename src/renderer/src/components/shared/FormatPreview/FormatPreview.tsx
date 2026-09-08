/*
-T ---
*/

import React from 'react'
import Markdown from 'markdown-to-jsx'
import { Highlight, themes } from 'prism-react-renderer'
import type { OutputFormat } from '../../../../shared/types'
import { useTheme } from '../../../hooks/useTheme'
import './FormatPreview.css'

interface FormatPreviewProps {
  content: string
  format: OutputFormat
}

/* Guarda de performance (json/xml): highlight de documentos muito grandes é custoso.
   Por encima deste umbral (ordem de centenas de mil de caracteres) degradam a plain. */
const MAX_HIGHLIGHT_CHARS = 200000

/** Pretty-print JSON (parse + indentado). Retorna null si inválido — o render exibe o cru. */
const prettyPrintJson = (content: string): string | null => {
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return null
  }
}

/**
 * Normaliza a linguagem para prism. `json` e `markup` são as gramáticas canonicas do
 * prism-react-renderer; XML usa `markup` (nome canônico da gramática XML no Prism).
 * 'text' é o fallback seguro para disguises no bundle.
 */
const normalizeLanguage = (lang: string): string => {
  const normalized = lang.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalized === 'json') return 'json'
  // A gramática XML do Prism é `markup`; mapear também `markup` explícito por robustez.
  if (normalized === 'xml' || normalized === 'markup') return 'markup'
  return 'text'
}

/** Bloque highlight compartida por json/xml via prism, con tema del app (espelho del CodeSnippetBlock). */
const CodeBlock: React.FC<{ code: string; language: string }> = ({ code, language }) => {
  const { effectiveTheme } = useTheme()
  const theme = effectiveTheme === 'dark' ? themes.vsDark : themes.vsLight
  return (
    <div className="fp-code">
      <Highlight theme={theme} code={code} language={normalizeLanguage(language)}>
        {({ tokens, getLineProps, getTokenProps }) =>
          tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line })}>
              {line.map((token, key) => (
                <span key={key} {...getTokenProps({ token })} />
              ))}
            </div>
          ))
        }
      </Highlight>
    </div>
  )
}

export const FormatPreview: React.FC<FormatPreviewProps> = ({ content, format }) => {
  if (format === 'markdown') {
    return (
      <div className="fp-markdown">
        <Markdown>{content}</Markdown>
      </div>
    )
  }

  if (format === 'json') {
    // JSON inválido ou muy grande degrada a plain; JSON válido se prett-iffica e realça.
    const pretty = prettyPrintJson(content)
    if (pretty === null || content.length > MAX_HIGHLIGHT_CHARS) {
      return <pre className="fp-plain">{content}</pre>
    }
    return <CodeBlock code={pretty} language="json" />
  }

  if (format === 'xml') {
    // XML grande degrada a plain (guarda de tamaño).
    if (content.length > MAX_HIGHLIGHT_CHARS) {
      return <pre className="fp-plain">{content}</pre>
    }
    return <CodeBlock code={content} language="xml" />
  }

  // plain (y fallback)
  return <pre className="fp-plain">{content}</pre>
}