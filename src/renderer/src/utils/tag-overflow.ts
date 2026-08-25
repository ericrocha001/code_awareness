/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Calcular, a partir de geometrias puras (sem DOM), quantos chips de tag cabem visivelmente em um container e quantas ficam ocultas.

Mapa de Relacionamentos do Script

1. ../components/FileCard/FileCard.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome o helper para contenção vertical de tags (eixo Y) no card.
   - Criticidade: Alta

2. ../components/FileCollection/FileRow.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome o helper para contenção horizontal de tags (eixo X) na row densa.
   - Criticidade: Alta

Invariantes do Script

1. Função pura: nenhuma leitura de DOM aqui — os componentes medem offsets e alimentam geometrias.
2. Container com tamanho zero ou negativo (ambiente não medido, ex.: jsdom/primeiro paint) produz ZERO ocultas — nunca um "+N" falso.
3. Tolerância de 1 unidade: chip cujo fim coincide exatamente com o limite do container conta como visível.

--- FIM ARQUITETURA DO SCRIPT ---
*/

/** Geometria de um chip no eixo relevante (topo/base no card; esquerda/direita na row). */
export interface ChipGeometry {
  start: number
  end: number
}

export interface TagOverflowResult {
  visibleCount: number
  hiddenCount: number
}

/**
 * Tolerância de 1 unidade para que chips encostados exatamente no limite do
 * container não sejam contados como ocultos por ruído de arredondamento.
 */
const EDGE_TOLERANCE = 1

export const computeTagOverflow = (
  chips: ChipGeometry[],
  containerSize: number
): TagOverflowResult => {
  // Guarda de ambiente não medido: sem geometria válida, nada é considerado oculto.
  if (containerSize <= 0 || chips.length === 0) {
    return { visibleCount: chips.length, hiddenCount: 0 }
  }

  let visibleCount = 0
  for (const chip of chips) {
    if (chip.end <= containerSize + EDGE_TOLERANCE) visibleCount++
  }

  return { visibleCount, hiddenCount: chips.length - visibleCount }
}
