/*
-T ---
*/

import type { FileCardFile } from '../types'

/** Dados de renderização de uma tag com paleta de cores pré-resolvida pelo FileView. */
export interface TagRenderData {
  id: string
  name: string
  /** Cor de fundo do chip, já adaptada ao tema ativo. */
  background: string
  /** Cor do texto do chip, já adaptada ao tema ativo. */
  text: string
}

/** Modelo pré-processado de linha de arquivo para uso futuro em otimizações de virtualização. */
export interface FileRowModel {
  file: FileCardFile
  tags: readonly TagRenderData[]
}
