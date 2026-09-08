/*
-T ---
*/

/** Representa um arquivo alterado dentro de uma implementação (checkpoint). */
export interface FileListItem {
  path: string
  name: string
  changeType: 'modified' | 'added' | 'deleted'
}

/** Estado de UI do autosave na documentação. */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'