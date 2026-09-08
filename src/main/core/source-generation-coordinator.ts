/*
-T ---
*/

import { CodeSourceService } from './code-source-service'
import type { GenerateWithProfileInput, GenerateWithProfileResult } from './code-source-service'
import { isGenerationCancelledError } from './generation-errors'

interface ActiveSession {
  generationId: number
  abortController: AbortController
}

export class SourceGenerationCoordinator {
  private readonly service: CodeSourceService
  private readonly sessions = new Map<string, ActiveSession>()

  constructor(service: CodeSourceService) {
    this.service = service
  }

  /**
   * Executa uma geração para o sessionKey informado, abortando a anterior quando existe
   * uma geração ativa com generationId menor. O resultado inclui o generationId original
   * para que o Renderer possa validar e descartar resultados obsoletos.
   *
   * Relança GenerationCancelledError para que o handler IPC o trate — nunca o engole.
   */
  async generate(
    sessionKey: string,
    generationId: number,
    input: Omit<GenerateWithProfileInput, 'signal'>
  ): Promise<GenerateWithProfileResult & { generationId: number }> {
    const existing = this.sessions.get(sessionKey)
    if (existing && existing.generationId < generationId) {
      existing.abortController.abort()
    }

    const abortController = new AbortController()
    this.sessions.set(sessionKey, { generationId, abortController })

    try {
      const result = await this.service.generateWithProfile({
        ...input,
        signal: abortController.signal
      })
      return { ...result, generationId }
    } catch (err) {
      if (isGenerationCancelledError(err)) {
        throw err
      }
      // Erro inesperado (não cancelamento): retornar como falha estruturada.
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg, generationId }
    } finally {
      // Limpa apenas se esta geração ainda for a sessão registrada (evita remover sessão mais nova).
      const current = this.sessions.get(sessionKey)
      if (current?.generationId === generationId) {
        this.sessions.delete(sessionKey)
      }
    }
  }
}
