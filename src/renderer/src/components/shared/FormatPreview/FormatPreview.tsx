/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar o preview de conteúdo conforme o OutputFormat (markdown, json, xml, plain) — componente puro de apresentación, sin chrome.
2. Markdown: interpretar via markdown-to-jsx, com tipografía ancorada nas reglas de `.preview-markdown` adaptadas à classe local.
3. JSON: pretty-print (parse + serialização indentada) com highlight Prism; se o parse falhar, exibir o texto cru en modo plain.
4. XML: highlight Prism.
5. Degradação de tamaño: json/xml acima do límite degradan a texto monospaced plain (guarda de performance).

Mapa de Relacionamientos do Script

1. OutputModal.tsx
   - Tipo: Dependência Inversa
   - Relação: Consume este componente para renderizar o preview do documento gerado (markdown/json/xml/plain).
   - Criticidade: Alta

2. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Consume OutputFormat para tipar a entrada.
   - Criticid: Alta

3. prism-react-renderer / markdown-to-jsx / useTheme
   - Tipo: Dependência Direta
   - Relação: Highlight/temas, interpretação Markdown y effectiveTheme.
   - Criticidade: Alta

4. CodeSnippetBlock.tsx (espelho técnico, sin dependncia)
   - Tipo: Relação de espelho
   - Relação: No se importa nada de CodeSnippetBlock; la selección de tema (useTheme → vsDark/vsLight) y la normalización de lenguaj se espelan deliberadamente para mantenerse autosuficiente.
   - Criticidad: Media

5. PreviewModal.css (ancla tipográfica)
   - Tipo: Referencia visual
   - Relação: A tipografia de `.preview-markdown` en PreviewModalCSS se adapta localmente com prefixo próprio deste componente (no importar CSS de otras features).
   - Criticidad: Media

Invariantes del Script

1. Componente puro de presentación — sin cabecera, sin acciones, sin estado de negocio.
2. Nunca importa nada de CodeMapView/PreviewModal (espelho, no dependencia — evita acoplamiento entre features).
3. JSON inválido nunca lança — mostra el texto crudo (preview é instrumento de inspeção).
4. json/xml por encima de MAX_HIGHLIGHT_CHARS degradam a término plain.
5. El tema del highlight siempre se deriva de effectiveTheme — nunca hardcod.
6. Modo pre sempre con quebra de palavra e pre-wrap, como el preview actual.

--- FIM ARQUITETURA DO SCRIPT ---
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