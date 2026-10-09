import { useEffect, useRef, useState } from 'react'
import type { DashExecutionResult } from '../../../../../shared/types/dash-types'

export function useDashWorkflow(repoPath: string) {
  const [input, setText] = useState('')
  const [result, setResult] = useState<DashExecutionResult | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    generation.current++
    setResult(null)
    setBusy(false)
    return () => {
      generation.current++
    }
  }, [repoPath])
  const setInput = (value: string) => {
    generation.current++
    setText(value)
    setResult(null)
    setBusy(false)
  }
  const reset = () => {
    setInput('')
  }
  const execute = async () => {
    const current = ++generation.current
    setResult(null)
    setBusy(true)
    try {
      const response = await window.codeAwareness.dashExecute(input, repoPath)
      if (current === generation.current) setResult(response)
    } catch (error) {
      if (current === generation.current)
        setResult({
          success: false,
          report: {
            steps: [],
            error: {
              code: 'EXACT_SOURCE_UNAVAILABLE',
              message: error instanceof Error ? error.message : 'Falha ao gerar contexto.'
            }
          }
        })
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }
  return { input, setInput, result, busy, execute, reset }
}
