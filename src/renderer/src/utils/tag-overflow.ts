/*
-T ---
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
