/*
-T ---
*/

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Highlight, themes, type Token } from 'prism-react-renderer'
import { FixedSizeList } from 'react-window'
import type { SourceOutputFormat } from '../../../../shared/types'
import { useTheme } from '../../hooks/useTheme'
import { splitDocumentLines } from '../../utils/source-document-lines'
import './SourcePreviewVirtualized.css'

export interface SourcePreviewVirtualizedProps {
  content: string
  format: SourceOutputFormat
  className?: string
}

/** Teto de caracteres para realce de sintaxe — documentos maiores usam texto puro virtualizado. */
export const MAX_HIGHLIGHT_CHARS = 100000

/** Altura fixa de cada linha virtualizada (compatível com CodeSnippetBlock). */
export const LINE_HEIGHT = 19

/**
 * Componente de preview virtualizado por linhas para apresentação de documentos
 * do Code Source com syntax highlighting e baixo consumo de DOM.
 */
export const SourcePreviewVirtualized: React.FC<SourcePreviewVirtualizedProps> = ({
  content,
  format,
  className = ''
}) => {
  const { effectiveTheme } = useTheme()
  const [containerHeight, setContainerHeight] = useState(400)
  const observerRef = useRef<ResizeObserver | null>(null)

  const measureRef = useCallback((el: HTMLElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null

    if (!el) return
    const updateHeight = () => {
      const h = el.clientHeight
      if (h > 0) setContainerHeight(h)
    }
    updateHeight()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateHeight)
      observer.observe(el)
      observerRef.current = observer
    }
  }, [])

  useEffect(() => {
    return () => observerRef.current?.disconnect()
  }, [])

  const lines = useMemo(() => splitDocumentLines(content), [content])
  const isPlainMode = content.length > MAX_HIGHLIGHT_CHARS
  const language = format === 'xml' ? 'markup' : 'markdown'
  const theme = effectiveTheme === 'dark' ? themes.vsDark : themes.vsLight

  if (!content) {
    return (
      <div className={`spv-root ${className}`.trim()}>
        <pre className="spv-empty">Nenhuma saída gerada ainda.</pre>
      </div>
    )
  }

  if (isPlainMode) {
    const PlainRow = ({ index, style: rowStyle }: { index: number; style: React.CSSProperties }) => {
      const lineText = lines[index] ?? ''
      return (
        <div style={rowStyle} className="spv-line">
          <span className="spv-line-num">{index + 1}</span>
          <span className="spv-line-content">{lineText || '\u00A0'}</span>
        </div>
      )
    }

    return (
      <div className={`spv-root ${className}`.trim()}>
        <div className="spv-virtual-container spv-virtual-container--plain" ref={measureRef}>
          <FixedSizeList
            height={containerHeight}
            width="100%"
            itemCount={lines.length}
            itemSize={LINE_HEIGHT}
            overscanCount={10}
          >
            {PlainRow}
          </FixedSizeList>
        </div>
        <div className="spv-plain-notice">
          Documento muito grande para realce de sintaxe — exibindo texto puro.
        </div>
      </div>
    )
  }

  return (
    <div className={`spv-root ${className}`.trim()}>
      <Highlight theme={theme} code={content} language={language}>
        {({ style, tokens, getLineProps, getTokenProps }) => {
          const Row = ({ index, style: rowStyle }: { index: number; style: React.CSSProperties }) => {
            const line = tokens[index]
            if (!line) return null
            const lineProps = getLineProps({ line })
            return (
              <div style={rowStyle} className={`spv-line ${lineProps.className ?? ''}`}>
                <span className="spv-line-num">{index + 1}</span>
                <span className="spv-line-content">
                  {line.length === 0 ? (
                    '\u00A0'
                  ) : (
                    line.map((token: Token, key: number) => (
                      <span key={key} {...getTokenProps({ token })} />
                    ))
                  )}
                </span>
              </div>
            )
          }

          return (
            <div className="spv-virtual-container" style={style} ref={measureRef}>
              <FixedSizeList
                height={containerHeight}
                width="100%"
                itemCount={tokens.length}
                itemSize={LINE_HEIGHT}
                overscanCount={10}
              >
                {Row}
              </FixedSizeList>
            </div>
          )
        }}
      </Highlight>
    </div>
  )
}
