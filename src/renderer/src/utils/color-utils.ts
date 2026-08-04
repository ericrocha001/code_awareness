/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Calcular cor de texto contrastante (preto ou branco) com base na luminância de uma cor hexadecimal.
2. Fornecer função pura e defensiva para uso em componentes que exibem cores dinâmicas.

Mapa de Relacionamentos do Script

1. CodeSourceView.tsx
   - Tipo: Dependência Direta
   - Relação: Usa getContrastColor para garantir legibilidade das tags ativas.
   - Criticidade: Baixa

2. CodeCompressionView.tsx
   - Tipo: Dependência Direta
   - Relação: Usa getContrastColor para garantir legibilidade das tags ativas.
   - Criticidade: Baixa

Invariantes do Script

1. A função deve ser pura — mesma entrada, mesma saída.
2. Nunca lançar exceção para entradas inválidas — retornar '#fff' como fallback seguro.
3. O limiar de luminância 0.5 separa cores claras de escuras.

--- FIM ARQUITETURA DO SCRIPT ---
*/

/**
 * Retorna '#000' (preto) para cores claras ou '#fff' (branco) para cores escuras,
 * garantindo contraste adequado para texto sobre fundo colorido.
 */
export function getContrastColor(hexColor: string): string {
  if (!hexColor || hexColor.length < 7) return '#fff'

  try {
    const r = parseInt(hexColor.slice(1, 3), 16)
    const g = parseInt(hexColor.slice(3, 5), 16)
    const b = parseInt(hexColor.slice(5, 7), 16)

    if (isNaN(r) || isNaN(g) || isNaN(b)) return '#fff'

    // Fórmula de luminância relativa (W3C)
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    return luminance > 0.5 ? '#000' : '#fff'
  } catch {
    return '#fff'
  }
}