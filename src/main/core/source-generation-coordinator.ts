/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Coordenar sessões de geração do Code Source com auto-cancelamento, garantindo que apenas uma geração ativa por sessionKey exista em qualquer momento.
2. Propagar AbortSignal ao CodeSourceService para cancelamento real do processo Repomix.
3. Descartar resultados de gerações canceladas relançando GenerationCancelledError para o handler IPC.
4. Manter o mapa de sessões limpo após cada geração concluída (sucesso, erro ou cancelamento).

Mapa de Relacionamentos do Script

1. code-source-service.ts
   - Tipo: Dependência Direta
   - Relação: Invoca generateWithProfile com AbortSignal propagado para cada geração.
   - Criticidade: Alta

2. generation-errors.ts
   - Tipo: Dependência Direta
   - Relação: Importa isGenerationCancelledError para identificar cancelamentos e relançar.
   - Criticidade: Alta

3. git-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Instancia e invoca generate para coordenar gerações vindas do handler IPC.
   - Criticidade: Alta

Invariantes do Script

1. Apenas uma geração ativa por sessionKey em qualquer momento.
2. Geração anterior com generationId menor é abortada antes de iniciar nova geração na mesma sessão.
3. GenerationCancelledError é sempre relançado — nunca engolido como resultado de erro genérico.
4. O mapa de sessões é limpo após toda geração (sucesso, erro ou cancelamento).
5. O coordenador não gera generationId — ecoa o id recebido do Renderer.

--- FIM ARQUITETURA DO SCRIPT ---
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
