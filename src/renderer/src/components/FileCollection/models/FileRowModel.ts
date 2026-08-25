/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir o contrato de dados pré-processados para renderização da FileRow, centralizado como fonte única de verdade.
2. Expor TagRenderData com paleta de cores já resolvida (background e text), eliminando resolução por linha.

Mapa de Relacionamentos do Script

1. FileView.tsx
   - Tipo: Fluxo de Dados
   - Relação: Pré-resolve TagRenderData a partir de allTags + tema e injeta como prop `tags` em cada FileRow.
   - Criticidade: Alta

2. FileRow.tsx
   - Tipo: Contrato / Interface
   - Relação: Consome TagRenderData como prop `tags`, sem precisar resolver paleta ou Map de tags.
   - Criticidade: Alta

Invariantes do Script

1. Este arquivo não contém lógica executável nem side effects — é módulo folha exclusivo de declaração de tipos.
2. TagRenderData deve conter todos os dados necessários para renderização visual da tag sem dependências externas.

--- FIM ARQUITETURA DO SCRIPT ---
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
