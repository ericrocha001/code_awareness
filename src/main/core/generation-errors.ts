/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir o erro tipado GenerationCancelledError para representar o cancelamento intencional de uma geração de código.
2. Fornecer a função utilitária isGenerationCancelledError para verificação segura e tipada de erros de cancelamento.

Mapa de Relacionamentos do Script

1. repomix-process-runner.ts
   - Tipo: Dependência Inversa
   - Relação: Lança GenerationCancelledError quando o AbortSignal é acionado.
   - Criticidade: Alta

2. code-source-service.ts
   - Tipo: Dependência Inversa
   - Relação: Preserva GenerationCancelledError para permitir que coordenadores identifiquem cancelamento.
   - Criticidade: Alta

Invariantes do Script

1. GenerationCancelledError sempre possui name 'GenerationCancelledError'.
2. isGenerationCancelledError é uma função pura, segura e nunca lança exceção para qualquer tipo de entrada.
3. Erros de cancelamento são semanticamente distintos de erros de timeout ou falhas de execução.

--- FIM ARQUITETURA DO SCRIPT ---
*/

/**
 * Erro lançado quando uma geração é abortada/cancelada via AbortSignal.
 */
export class GenerationCancelledError extends Error {
  constructor(message = 'Geração cancelada.') {
    super(message)
    this.name = 'GenerationCancelledError'
    // Restaura a cadeia de protótipos correta em ambientes TypeScript/ES5
    Object.setPrototypeOf(this, GenerationCancelledError.prototype)
  }
}

/**
 * Verifica de forma segura se um valor recebido é um GenerationCancelledError.
 */
export function isGenerationCancelledError(error: unknown): error is GenerationCancelledError {
  if (!error || typeof error !== 'object') {
    return false
  }
  if (error instanceof GenerationCancelledError) {
    return true
  }
  return (error as { name?: string }).name === 'GenerationCancelledError'
}
