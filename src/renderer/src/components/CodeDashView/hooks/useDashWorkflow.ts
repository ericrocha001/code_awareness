import { useCallback, useState } from 'react'
import type { DashResolutionReport } from '../../../../shared/types/dash-types'
import type { DashSettings } from '../../../../shared/types'

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
  tokenCount: number | null
  error: string | null
  pasteAndResolve: () => Promise<void>
  generate: (settings?: DashSettings) => Promise<void>
  reset: () => void
}

export function useDashWorkflow(repoPath: string): UseDashWorkflowReturn {
  const [state, setState] = useState<DashWorkflowState>('idle')
  const [input, setInput] = useState<string>('')
  const [resolutionReport, setResolutionReport] = useState<DashResolutionReport | null>(null)
  const [xml, setXml] = useState<string | null>(null)
  const [tokenCount, setTokenCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pasteAndResolve = useCallback(async () => {
    if (!input || input.trim().length === 0) {
      setState('error')
      setError('Cole uma solicitação Code Dash válida.')
      return
    }

    setState('parsing')
    setError(null)
    setTokenCount(null)

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

  const generate = useCallback(async (settings?: DashSettings) => {
    if (state !== 'resolved') {
      return
    }

    setState('generating')
    setError(null)

    try {
      const response = await window.codeAwareness.dashGenerate(input, repoPath, settings)

      if (response.success && response.data?.xml) {
        setXml(response.data.xml)
        setTokenCount(response.data.tokenCount ?? null)
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
    setTokenCount(null)
    setError(null)
  }, [])

  return {
    state,
    input,
    setInput,
    resolutionReport,
    xml,
    tokenCount,
    error,
    pasteAndResolve,
    generate,
    reset
  }
}
