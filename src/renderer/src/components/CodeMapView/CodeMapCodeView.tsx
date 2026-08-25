/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a coluna de código integral do arquivo selecionado na aba Code Map.
2. Carregar o conteúdo completo do arquivo via IPC getFileContent sob demanda.
3. Exibir estados de loading, erro e vazio (sem arquivo selecionado).
4. Delegar a renderização do código com realce ao CodeSnippetBlock.

Mapa de Relacionamentos do Script

1. CodeMapView.tsx
   - Tipo: Dependência Inversa
   - Relação: É instanciado pelo orquestrador com o arquivo selecionado e o caminho do repositório.
   - Criticidade: Alta

2. CodeSnippetBlock.tsx
   - Tipo: Dependência Direta
   - Relação: Renderiza o código com syntax highlighting, botão copiar e aviso de truncamento.
   - Criticidade: Alta

3. window.codeAwareness.getFileContent
   - Tipo: Dependência Inversa
   - Relação: API IPC que fornece o conteúdo integral do arquivo.
   - Criticidade: Alta

4. ../../../../shared/types
   - Tipo: Contrato / Interface
   - Relação: Fornece o tipo CodeMapFile.
   - Criticidade: Alta

5. CodeMapCodeView.css
   - Tipo: Relação de UI
   - Relação: Consome os estilos da coluna de código (prefixo cmcv-).
   - Criticidade: Alta

Invariantes do Script

1. Nunca chamar IPC sem cleanup — toda chamada tem flag de cancelamento no cleanup do useEffect.
2. O componente nunca gerencia estado de outro componente — apenas o próprio conteúdo.
3. Quando data === null na resposta, exibe erro amigável "Arquivo não encontrado ou ilegível.".
4. O useEffect depende de file e repoPath — quando file muda de referência, re-dispara a carga.
5. O componente é puramente apresentacional — não navega, não filtra e não altera seleção.

--- FIM ARQUITETURA DO SCRIPT ---
*/

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