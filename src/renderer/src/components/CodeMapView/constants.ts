/*
-T ---
*/

/** Rótulos em português por tipo de elemento. */
export const ELEMENT_GROUP_LABELS: Record<string, string> = {
  class: 'Classes',
  function: 'Funções',
  method: 'Métodos',
  interface: 'Interfaces',
  enum: 'Enums',
  typeAlias: 'Type Aliases',
  variable: 'Variáveis',
  constant: 'Constantes',
  import: 'Imports',
  export: 'Exports',
  property: 'Propriedades',
  parameter: 'Parâmetros',
  enumMember: 'Membros de Enum',
  cssRule: 'Regras CSS',
  cssAtRule: 'At-Rules CSS',
  cssCustomProperty: 'Custom Properties CSS'
}

/** Micro-rótulos uppercase por tipo de elemento. */
export const ELEMENT_MICRO_LABELS: Record<string, string> = {
  class: 'CL',
  function: 'FN',
  method: 'MT',
  interface: 'IF',
  enum: 'EN',
  typeAlias: 'TA',
  variable: 'VR',
  constant: 'CT',
  import: 'IM',
  export: 'EX',
  property: 'PR',
  parameter: 'PA',
  enumMember: 'EM',
  cssRule: 'CR',
  cssAtRule: 'AR',
  cssCustomProperty: 'CP'
}

/** Cores semânticas por tipo de elemento para os ícones Codicon no painel. */
export const ELEMENT_ICON_COLORS: Record<string, string> = {
  class: '#f59e0b',
  function: '#22c55e',
  method: '#22c55e',
  interface: '#a855f7',
  enum: '#f97316',
  typeAlias: '#06b6d4',
  variable: '#3b82f6',
  constant: '#3b82f6',
  import: '#64748b',
  export: '#64748b',
  property: '#8b5cf6',
  parameter: '#94a3b8',
  enumMember: '#fb923c',
  cssRule: '#38bdf8',
  cssAtRule: '#0ea5e9',
  cssCustomProperty: '#2dd4bf'
}

/** Chave de localStorage usada pela FilesView para persistir extensões selecionadas.
 *  Reutilizada pelos filtros de extensão — preserva os filtros já salvos dos usuários. */
export const EXTENSION_FILTER_KEY_PREFIX = 'codeMap:filesView:extensions:'

/** Chave de localStorage usada para persistir as tags selecionadas no funil de filtro
 *  por projeto. Isolada por projeto, seguindo o padrão das extensões. */
export const TAG_FILTER_KEY_PREFIX = 'codeMap:filesView:tags:'

/** Chave real de arquivos sem extensão (ex: Dockerfile, Makefile, README). */
export const NO_EXTENSION_KEY = ''

/** Label amigável exibido na UI para arquivos sem extensão. */
export const NO_EXTENSION_LABEL = '(sem extensão)'

/** Converte a chave crua de extensão em label amigável para exibição. */
export const extensionLabel = (ext: string): string => ext || NO_EXTENSION_LABEL
