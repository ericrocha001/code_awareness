/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Centralizar constantes compartilhadas entre os componentes da CodeMapView.
2. Evitar duplicação de rótulos e chaves de persistência entre módulos.

Mapa de Relacionamentos do Script

1. CodeMapDetailPanel.tsx
   - Tipo: Dependência Direta
   - Relação: Consome ELEMENT_GROUP_LABELS e ELEMENT_MICRO_LABELS.
   - Criticidade: Alta

2. CodeMapView.tsx
   - Tipo: Dependência Direta
   - Relação: Consome EXTENSION_FILTER_KEY_PREFIX e TAG_FILTER_KEY_PREFIX para persistir filtros por projeto.
   - Criticidade: Alta

Invariantes do Script

1. O módulo é folha — não importa nada além de tipos.
2. A chave EXTENSION_FILTER_KEY_PREFIX deve ser exatamente `codeMap:filesView:extensions:` para preservar filtros salvos da FilesView.
3. A chave TAG_FILTER_KEY_PREFIX deve ser exatamente `codeMap:filesView:tags:` para persistir o filtro de tags por projeto.
4. Os rótulos são em português do Brasil.

--- FIM ARQUITETURA DO SCRIPT ---
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
  export: 'Exports'
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
  export: 'EX'
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
  export: '#64748b'
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
