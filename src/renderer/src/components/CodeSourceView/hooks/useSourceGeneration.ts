/*
-T ---
*/

import { useEffect, useRef, useState } from 'react'
import type { GeneratedDocument, SourceOutputFormat, SourceProfile } from '../../../../../shared/types'
import { computeSourceGenerationIdentity } from '../utils/source-generation-identity'

const GENERATE_DEBOUNCE_MS = 300

export interface UseSourceGenerationParams {
  repoPath: string
  selectedFiles: string[]
  format: SourceOutputFormat
  profile: SourceProfile
  sessionKey: string
}

export interface UseSourceGenerationResult {
  isGenerating: boolean
  lastCompletedDocument: GeneratedDocument | null
  currentGenerationId: number
  error: string | null
}

/**
 * Hook que encapsula o ciclo de vida, debounce, deduplicação e controle
 * de geração do Code Source no Renderer.
 */
export function useSourceGeneration({
  repoPath,
  selectedFiles,
  format,
  profile,
  sessionKey
}: UseSourceGenerationParams): UseSourceGenerationResult {
  const [lastCompletedDocument, setLastCompletedDocument] = useState<GeneratedDocument | null>(null)
  const [currentGenerationId, setCurrentGenerationId] = useState(0)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const genIdRef = useRef(0)
  const inFlightIdentityRef = useRef<string | null>(null)
  const lastCompletedIdentityRef = useRef<string | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // 1. Calcular identidade da geração atual
    const currentIdentity = computeSourceGenerationIdentity(repoPath, selectedFiles, format, profile)

    // 2. Se selectedFiles.length === 0, limpar estado pendente e retornar
    if (selectedFiles.length === 0) {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      setIsGenerating(false)
      setError(null)
      return
    }

    // 3. Se identidade === identidade da última geração completada, não disparar IPC
    if (currentIdentity === lastCompletedIdentityRef.current) {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      setIsGenerating(false)
      return
    }

    // 4. Se identidade === inFlightIdentity, não disparar IPC (deduplicação de gerações em voo)
    if (currentIdentity === inFlightIdentityRef.current) {
      return
    }

    // 5. Iniciar debounce de 300ms
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    setIsGenerating(true)

    debounceTimerRef.current = setTimeout(async () => {
      debounceTimerRef.current = null

      const genId = ++genIdRef.current
      setCurrentGenerationId(genId)
      inFlightIdentityRef.current = currentIdentity
      setIsGenerating(true)

      try {
        const result = await window.codeAwareness.generateCodeSourceWithProfile(
          repoPath,
          selectedFiles,
          format,
          profile,
          genId,
          sessionKey
        )

        // Stale protection: descarta resposta caso um disparo mais novo já tenha sido iniciado
        if (genId === genIdRef.current) {
          if (result.success && result.content !== undefined) {
            setLastCompletedDocument({
              content: result.content,
              tokenCount: result.tokenCount ?? 0,
              generationId: genId
            })
            lastCompletedIdentityRef.current = currentIdentity
            setError(null)
          } else {
            if (result.error && result.error !== 'Generation cancelled') {
              setError(result.error)
            }
          }
          inFlightIdentityRef.current = null
          setIsGenerating(false)
        }
      } catch (err: any) {
        if (genId === genIdRef.current) {
          if (err?.message !== 'Generation cancelled') {
            setError(err instanceof Error ? err.message : 'Falha ao gerar o Code Source.')
          }
          inFlightIdentityRef.current = null
          setIsGenerating(false)
        }
      }
    }, GENERATE_DEBOUNCE_MS)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [repoPath, selectedFiles, format, profile, sessionKey])

  return {
    isGenerating,
    lastCompletedDocument,
    currentGenerationId,
    error
  }
}
