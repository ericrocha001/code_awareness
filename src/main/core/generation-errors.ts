/*
-T ---
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
