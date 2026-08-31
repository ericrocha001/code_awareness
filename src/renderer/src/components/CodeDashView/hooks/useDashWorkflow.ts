/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar a máquina de estados do fluxo Code Dash (idle, parsing, resolved, generating, done, error).
2. Gerenciar a comunicação com os canais IPC dashParseAndResolve e dashGenerate sem efeitos colaterais automáticos.

Mapa de Relacionamentos do Script

1. ../../../../shared/types/dash-types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome DashResolutionReport e DashExecutionResult para tipagem de estado.
   - Criticidade: Alta

2. ../CodeDashView.tsx
   - Tipo: Dependência Inversa
   - Relação: Provê o estado e ações para o container principal da UI.
   - Criticidade: Alta

Invariantes do Script

1. A geração via generate() só pode ser disparada no estado 'resolved'.
2. Transições de erro devem preservar ou limpar dados conforme a fase em que ocorrem.
3. Não executar chamadas IPC automáticas em useEffect.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { useCallback, useState } from 'react'
import type { DashResolutionReport } from '../../../../shared/types/dash-types'

export type DashWorkflowState =
  | 'idle'
  | 'parsing'
  | 'resolved'
  | 'generating'
  | 'done'
  | 'error'

export interface UseDashWorkflowReturn {
  state: DashWorkflowState
  input: string
  setInput: (input: string) => void
  resolutionReport: DashResolutionReport | null
  xml: string | null
  error: string | null
  pasteAndResolve: () => Promise<void>
  generate: () => Promise<void>
  reset: () => void
}

export function useDashWorkflow(repoPath: string): UseDashWorkflowReturn {
  const [state, setState] = useState<DashWorkflowState>('idle')
  const [input, setInput] = useState<string>('')
  const [resolutionReport, setResolutionReport] = useState<DashResolutionReport | null>(null)
  const [xml, setXml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pasteAndResolve = useCallback(async () => {
    if (!input || input.trim().length === 0) {
      setState('error')
      setError('Cole uma solicitação Code Dash válida.')
      return
    }

    setState('parsing')
    setError(null)

    try {
      const response = await window.codeAwareness.dashParseAndResolve(input, repoPath)

      if (response.success && response.data) {
        setResolutionReport(response.data as DashResolutionReport)
        setState('resolved')
      } else {
        setState('error')
        setError(response.error || 'Falha ao analisar a solicitação.')
      }
    } catch (err) {
      setState('error')
      setError(
        err instanceof Error ? err.message : 'Erro inesperado ao analisar a solicitação.'
      )
    }
  }, [input, repoPath])

  const generate = useCallback(async () => {
    if (state !== 'resolved') {
      return
    }

    setState('generating')
    setError(null)

    try {
      const response = await window.codeAwareness.dashGenerate(input, repoPath)

      if (response.success && response.data?.xml) {
        setXml(response.data.xml)
        setState('done')
      } else {
        setState('error')
        setError(response.error || 'Falha ao gerar o contexto XML.')
      }
    } catch (err) {
      setState('error')
      setError(
        err instanceof Error ? err.message : 'Erro inesperado ao gerar contexto XML.'
      )
    }
  }, [state, input, repoPath])

  const reset = useCallback(() => {
    setState('idle')
    setInput('')
    setResolutionReport(null)
    setXml(null)
    setError(null)
  }, [])

  return {
    state,
    input,
    setInput,
    resolutionReport,
    xml,
    error,
    pasteAndResolve,
    generate,
    reset
  }
}
