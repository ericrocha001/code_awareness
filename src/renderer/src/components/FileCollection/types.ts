/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Centralizar os tipos compartilhados da coleção de arquivos (estrutura de arquivo, interação ativa e contratos de retorno dos hooks).
2. Servir como fonte única de verdade dos contratos da FileCollection.

Mapa de Relacionamentos do Script

1. useFileCollectionSelection.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece as interfaces FileCardFile e FileCollectionSelectionResult.
   - Criticidade: Alta

2. useFileCollectionInteraction.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece o tipo ActiveInteractionType e as interfaces ActiveInteraction e FileCollectionInteractionResult.
   - Criticidade: Alta

3. FileRow.tsx
   - Tipo: Contrato / Interface
   - Relação: Fornece RowActionType para o callback consolidado onRowAction.
   - Criticidade: Média

Invariantes do Script

1. Este arquivo não contém lógica executável nem side effects, sendo um módulo folha exclusivo de declaração de tipos.
2. A interface ActiveInteraction desacopla completamente o tipo de interação e o arquivo de qualquer implementação de UI.

--- FIM ARQUITETURA DO SCRIPT ---
*/

/** Descreve um arquivo pertencente à coleção. */
export interface FileCardFile {
  /** Caminho relativo do arquivo no repositório. */
  relativePath: string
  /** Nome do arquivo (basename). */
  name: string
  /** Estimativa de tokens (opcional). */
  tokenEstimate?: number
  /** Status de alteração do arquivo (opcional). */
  changeType?: 'modified' | 'added' | 'deleted' | 'tracked'
}

/** Tipo da interação ativa sobre um arquivo. */
export type ActiveInteractionType = 'tagPopover' | 'actionMenu'

/** Tipo de ação disparada pela FileRow via callback consolidado. */
export type RowActionType = 'toggle' | 'tagInteraction' | 'actionInteraction'

/** Interação ativa atual, originada por um arquivo específico. */
export interface ActiveInteraction {
  /** Tipo da interação ativa. */
  type: ActiveInteractionType
  /** Caminho relativo do arquivo que originou a interação. */
  relativePath: string
  /** Elemento DOM gatilho do clique que originou a interação (âncora preferencial). */
  anchor?: HTMLElement
}

/** Contrato de retorno do hook useFileCollectionSelection. */
export interface FileCollectionSelectionResult {
  toggleFile: (relativePath: string) => void
  toggleMaster: () => void
  clearSelection: () => void
  isAllSelected: boolean
  selectedCount: number
}

/** Contrato de retorno do hook useFileCollectionInteraction. */
export interface FileCollectionInteractionResult {
  activeInteraction: ActiveInteraction | null
  openTagPopover: (relativePath: string, anchor?: HTMLElement) => void
  openActionMenu: (relativePath: string, anchor?: HTMLElement) => void
  closeInteraction: () => void
}