/*
-T ---
*/

/**
 * Estima a contagem de tokens de um texto usando a heurística de 4 caracteres por token.
 * Compatível com modelos de linguagem populares (GPT, Gemini, etc.) para texto em inglês/código.
 * Para entrada vazia ou inválida, retorna 0.
 */
export function estimateTokenCount(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / 4)
}
