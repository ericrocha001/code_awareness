/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Estimar a contagem de tokens de um arquivo a partir de seu tamanho em bytes.

Mapa de Relacionamentos do Script

1. CodeSourceView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome estimateTokensFromSize para calcular tokenEstimates via useMemo.
   - Criticidade: Alta

2. CodeCompressionView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome estimateTokensFromSize para calcular tokenEstimates via useMemo.
   - Criticidade: Alta

3. CodeDiffView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome estimateTokensFromSize para calcular tokenEstimates via useMemo.
   - Criticidade: Alta

Invariantes do Script

1. O resultado nunca pode ser negativo.
2. A heurística é sempre Math.ceil(bytes / 4), refletindo ~4 bytes por token médio.
3. Um size ausente ou inválido deve ser tratado como 0 sem lançar exceção.

--- FIM ARQUITETURA DO SCRIPT ---
*/

/**
 * Estima a contagem de tokens de um arquivo com base em seu tamanho em bytes.
 * Heurística: ~4 bytes por token (padrão BPE/GPT).
 */
export function estimateTokensFromSize(sizeBytes: number | undefined | null): number {
  return Math.ceil((sizeBytes ?? 0) / 4)
}
