import React, { useMemo, useRef, useState } from 'react'
import { Prism } from 'prism-react-renderer'

type SyntaxToken = ReturnType<typeof Prism.tokenize>[number]
function syntax(token: SyntaxToken, key: number): React.ReactNode {
  if (typeof token === 'string') return token
  const content = token.content
  return (
    <span className={`dash-token-${token.type}`} key={key}>
      {Array.isArray(content)
        ? content.map(syntax)
        : typeof content === 'string'
          ? content
          : syntax(content, 0)}
    </span>
  )
}

interface DashCodeSurfaceProps {
  value: string
  onChange?: (value: string) => void
  disabled?: boolean
}

export function DashCodeSurface({ value, onChange, disabled }: DashCodeSurfaceProps) {
  const overlay = useRef<HTMLPreElement>(null)
  const gutter = useRef<HTMLPreElement>(null)
  const [composing, setComposing] = useState(false)
  const lines = useMemo(() => value.split('\n').length, [value])
  const highlighted = value.length <= 100_000 && lines <= 1_000 && !composing
  const editable = !!onChange
  const code = useMemo(
    () => {
      if (highlighted) return Prism.tokenize(value, Prism.languages.json).map(syntax)
      if (editable) return value
      return value.split(/(\r\n|\n|\r)/).flatMap<React.ReactNode>((line, lineIndex) =>
        /^[\r\n]+$/.test(line)
          ? [line]
          : (line.match(/.{1,128}/gu) ?? []).map((chunk, chunkIndex) => (
              <span className="dash-plain-chunk" key={`${lineIndex}:${chunkIndex}`}>
                {chunk}
              </span>
            ))
      )
    },
    [value, highlighted, editable]
  )
  const numbers = highlighted ? Array.from({ length: lines }, (_, i) => i + 1).join('\n') : null
  return (
    <div
      className={`dash-code-surface ${onChange ? 'dash-code-editor' : 'dash-code-output'} ${highlighted ? 'dash-code-highlighted' : 'dash-code-plain'}`}
    >
      {numbers && (
        <pre className="dash-line-numbers" aria-hidden="true" ref={gutter}>
          {numbers}
        </pre>
      )}
      {onChange ? (
        <>
          {highlighted && (
            <pre className="dash-code-overlay" ref={overlay} aria-hidden="true">
              {code}
              {value.endsWith('\n') ? '\n' : ''}
            </pre>
          )}
          <textarea
            aria-label="Solicitação Code Dash"
            className="dash-textarea"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            placeholder="Cole aqui sua solicitação code-dash/v2…"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onScroll={(e) => {
              if (overlay.current) {
                overlay.current.scrollTop = e.currentTarget.scrollTop
                overlay.current.scrollLeft = e.currentTarget.scrollLeft
              }
              if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop
            }}
          />
        </>
      ) : (
        <pre
          className="dash-context-preview"
          aria-label="Context Packet"
          tabIndex={0}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop
          }}
        >
          {code}
        </pre>
      )}
    </div>
  )
}
