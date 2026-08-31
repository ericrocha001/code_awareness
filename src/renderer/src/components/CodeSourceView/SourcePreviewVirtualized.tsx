/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Apresentar o preview do documento gerado (Markdown ou XML) utilizando virtualização por linhas com FixedSizeList.
2. Aplicar syntax highlighting com prism-react-renderer materializando no DOM apenas a faixa de linhas visíveis.
3. Proteger a performance degradando automaticamente para texto puro virtualizado quando o documento exceder o teto de caracteres.
4. Manter o conteúdo integral preservado e inalterado na memória para operações de cópia e exportação.

Mapa de Relacionamentos do Script

1. utils/source-document-lines.ts
   - Tipo: Dependência Direta
   - Relação: Consome splitDocumentLines para segmentação normalizada de linhas.
   - Criticidade: Alta

2. hooks/useTheme.ts
   - Tipo: Dependência Direta
   - Relação: Fornece effectiveTheme para seleção do tema claro/escuro de syntax highlighting.
   - Criticidade: Alta

3. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece o tipo SourceOutputFormat.
   - Criticidade: Alta

4. prism-react-renderer
   - Tipo: Dependência Direta
   - Relação: Fornece Highlight e temas vsDark/vsLight para realce de sintaxe.
   - Criticidade: Alta

5. react-window
   - Tipo: Dependência Direta
   - Relação: Fornece FixedSizeList para virtualização de linhas com altura fixa.
   - Criticidade: Alta

6. SourcePreviewVirtualized.css
   - Tipo: Relação de UI
   - Relação: Estiliza o container e as linhas virtualizadas com prefixo spv-.
   - Criticidade: Alta

Invariantes do Script

1. Apenas as linhas contidas na viewport do contêiner (com overscan fixo) são instanciadas no DOM.
2. A altura de cada linha virtualizada (.spv-line) é estritamente 19px (LINE_HEIGHT).
3. Documentos cujo tamanho exceda MAX_HIGHLIGHT_CHARS nunca são processados pelo parser do Prism (fallback imediato para texto puro virtualizado).
4. O tema do realce acompanha reativamente effectiveTheme.
5. O componente não modifica nem trunca o documento original.

--- FIM ARQUITETURA DO SCRIPT ---
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
