/*
-T ---
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