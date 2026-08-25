/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar bloco de código estilo ChatGPT com syntax highlighting via prism-react-renderer.
2. Exibir cabeçalho com ícone de código, nome da linguagem/arquivo e botão copiar com feedback.
3. Adaptar o tema do highlighting (vsDark/vsLight) ao tema efetivo da aplicação.
4. Exibir aviso de truncamento quando o conteúdo foi cortado por teto de segurança.
5. Exibir texto puro sem realce quando o arquivo excede o teto de performance.
6. Virtualizar a renderização de linhas no modo realçado via react-window para rolagem fluida em arquivos grandes.

Mapa de Relacionamentos do Script

1. CodeMapDetailPanel.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome este componente para renderizar trechos de elemento no painel.
   - Criticidade: Alta

2. CodeMapCodeView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome este componente para renderizar o arquivo integral na coluna de código.
   - Criticidade: Alta

3. useTheme.ts
   - Tipo: Dependência Direta
   - Relação: Fornece effectiveTheme para escolher o tema do syntax highlighting.
   - Criticidade: Alta

4. prism-react-renderer
   - Tipo: Dependência Direta
   - Relação: Fornece Highlight, themes vsDark/vsLight e token estilizado.
   - Criticidade: Alta

5. react-window
   - Tipo: Dependência Direta
   - Relação: Fornece FixedSizeList para virtualizar linhas no modo realçado.
   - Criticidade: Alta

6. CodeSnippetBlock.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos do bloco (prefixo csb-).
   - Criticidade: Alta

Invariantes do Script

1. O feedback "✓ Copiado" dura exatamente 2 segundos.
2. O tema do highlighting é sempre derivado do effectiveTheme — nunca hardcoded.
3. O aviso de truncamento só aparece quando truncated === true.
4. O componente não faz chamadas IPC — apenas renderiza o conteúdo recebido.
5. O botão copiar usa navigator.clipboard com fallback silencioso.
6. Código acima de MAX_HIGHLIGHT_CHARS nunca passa pelo Highlight do prism (guarda de performance).
7. O cabeçalho (nome + copiar) permanece idêntico no modo puro e no modo realçado.
8. O cabeçalho permanece fora da lista virtualizada — nunca rola junto com as linhas.
9. A virtualização só se aplica ao modo realçado com muitas linhas (acima de VIRTUALIZE_THRESHOLD); trechos pequenos renderizam diretamente.
10. A seleção de texto pode não funcionar em linhas fora da viewport (virtualizadas) — aceitável para arquivos grandes.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Highlight, themes, type Token } from 'prism-react-renderer'
import { FixedSizeList } from 'react-window'
import { useTheme } from '../../hooks/useTheme'
import './CodeSnippetBlock.css'

interface CodeSnippetBlockProps {
  code: string
  language: string
  fileName?: string
  truncated?: boolean
  onCopy?: () => void
}

/** Teto de caracteres para realce de sintaxe — acima disso renderiza texto puro sem travar a UI. */
const MAX_HIGHLIGHT_CHARS = 100000

/** Altura fixa de cada linha virtualizada (font-size 12px × line-height 1.5 = 18px + 1px de folga). */
const LINE_HEIGHT = 19

/** Número mínimo de linhas para ativar a virtualização — abaixo disso renderiza direto (trechos pequenos). */
const VIRTUALIZE_THRESHOLD = 100

/** Linguagens suportadas pelo prism-react-renderer — fallback seguro para 'text'. */
const PRISM_SUPPORTED_LANGUAGES = new Set([
  'javascript', 'typescript', 'jsx', 'tsx', 'json', 'css', 'html',
  'markdown', 'yaml', 'bash', 'python', 'java', 'c', 'cpp',
  'ruby', 'go', 'rust', 'sql', 'xml', 'php', 'swift', 'kotlin'
])

/** Normaliza a linguagem para um valor suportado pelo prism; 'text' é o fallback seguro. */
const normalizeLanguage = (lang: string): string => {
  const normalized = lang.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (PRISM_SUPPORTED_LANGUAGES.has(normalized)) return normalized
  if (normalized === 'typescriptreact') return 'tsx'
  if (normalized === 'javascriptreact') return 'jsx'
  if (normalized === 'shell') return 'bash'
  return 'text'
}

export const CodeSnippetBlock: React.FC<CodeSnippetBlockProps> = ({
  code,
  language,
  fileName,
  truncated = false,
  onCopy
}) => {
  const { effectiveTheme } = useTheme()
  const [copied, setCopied] = useState(false)
  // Altura disponível para a lista virtualizada — medida da área do código (abaixo do cabeçalho)
  const [codeAreaHeight, setCodeAreaHeight] = useState(300)
  const measureElement = useRef<HTMLElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)

  // Callback ref: recria o ResizeObserver sempre que o elemento medido muda
  // (alternância entre <pre> do modo direto e <div> do modo virtualizado).
  // Sem isso, o observer antigo continua observando um elemento desconectado.
  const measureRef = useCallback((el: HTMLElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    measureElement.current = el

    if (!el) return
    const updateHeight = () => {
      const height = el.clientHeight
      if (height > 0) setCodeAreaHeight(height)
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(el)
    observerRef.current = observer
  }, [])

  // Cleanup do timer de feedback — evita setState em componente desmontado
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  // Desconecta o observer no unmount
  useEffect(() => {
    return () => observerRef.current?.disconnect()
  }, [])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      onCopy?.()
    } catch {
      // Clipboard indisponível — silencioso
    }
  }, [code, onCopy])

  const theme = effectiveTheme === 'dark' ? themes.vsDark : themes.vsLight
  const label = fileName ?? language
  const isPlainMode = code.length > MAX_HIGHLIGHT_CHARS
  const lineCount = code.split('\n').length
  const shouldVirtualize = !isPlainMode && lineCount > VIRTUALIZE_THRESHOLD

  return (
    <div className={`csb-root${shouldVirtualize ? ' csb-root--virtualized' : ''}`}>
      <div className="csb-header">
        <span className="csb-header-icon">
          <i className="codicon codicon-code" />
        </span>
        <span className="csb-header-label">{label}</span>
        <button className="csb-copy-btn" onClick={handleCopy}>
          {copied ? '✓ Copiado' : 'Copiar'}
        </button>
      </div>
      {isPlainMode ? (
        <pre className="csb-pre csb-pre--plain">{code}</pre>
      ) : (
        <Highlight theme={theme} code={code} language={normalizeLanguage(language)}>
          {({ style, tokens, getLineProps, getTokenProps }) => {
            if (!shouldVirtualize) {
              // Trechos pequenos: renderiza direto (sem virtualização) — mais simples e permite seleção de texto
              return (
                <pre className="csb-pre" style={style} ref={measureRef}>
                  {tokens.map((line, i) => (
                    <div key={i} {...getLineProps({ line })}>
                      <span className="csb-line-num">{i + 1}</span>
                      {line.map((token, key) => (
                        <span key={key} {...getTokenProps({ token })} />
                      ))}
                    </div>
                  ))}
                </pre>
              )
            }

            // Arquivos grandes: virtualiza as linhas para reduzir o DOM de milhares para ~50 nós
            const lineData = tokens.map((line, i) => ({
              line,
              lineNumber: i + 1,
              getLineProps: () => getLineProps({ line }),
              getTokenProps: (token: Token) => getTokenProps({ token })
            }))

            const Row = ({ index, style: rowStyle, data }: { index: number; style: React.CSSProperties; data: typeof lineData }) => {
              const item = data[index]
              const lineProps = item.getLineProps()
              return (
                <div style={rowStyle} className={`csb-line ${lineProps.className ?? ''}`}>
                  <span className="csb-line-num">{item.lineNumber}</span>
                  <span className="csb-line-content">
                    {item.line.map((token, key) => (
                      <span key={key} {...item.getTokenProps(token)} />
                    ))}
                  </span>
                </div>
              )
            }

            return (
              <div className="csb-virtual-container" style={style} ref={measureRef}>
                <FixedSizeList
                  height={codeAreaHeight}
                  width="100%"
                  itemCount={lineData.length}
                  itemSize={LINE_HEIGHT}
                  itemData={lineData}
                  overscanCount={10}
                >
                  {Row}
                </FixedSizeList>
              </div>
            )
          }}
        </Highlight>
      )}
      {isPlainMode && (
        <div className="csb-plain-notice">
          Arquivo muito grande para realce de sintaxe — exibindo texto puro.
        </div>
      )}
      {truncated && (
        <div className="csb-truncated">
          Conteúdo truncado (limite de segurança de 2 MB)
        </div>
      )}
    </div>
  )
}