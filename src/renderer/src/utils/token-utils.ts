/*
-T ---
*/

/**
 * Estima a contagem de tokens de um arquivo com base em seu tamanho em bytes.
 * Heurística: ~4 bytes por token (padrão BPE/GPT).
 */
export function estimateTokensFromSize(sizeBytes: number | undefined | null): number {
  return Math.ceil((sizeBytes ?? 0) / 4)
}
