/*
-T ---
*/

import type { CodeMapElementKind } from '../../../shared/types'

const KIND_TO_CODICON: Record<CodeMapElementKind, string> = {
  class: 'codicon codicon-symbol-class',
  function: 'codicon codicon-symbol-method',
  method: 'codicon codicon-symbol-method',
  interface: 'codicon codicon-symbol-interface',
  enum: 'codicon codicon-symbol-enum',
  typeAlias: 'codicon codicon-symbol-structure',
  variable: 'codicon codicon-symbol-variable',
  constant: 'codicon codicon-symbol-constant',
  import: 'codicon codicon-arrow-down',
  export: 'codicon codicon-arrow-up',
  property: 'codicon codicon-symbol-property',
  parameter: 'codicon codicon-symbol-parameter',
  enumMember: 'codicon codicon-symbol-enum-member',
  cssRule: 'codicon codicon-symbol-rule',
  cssAtRule: 'codicon codicon-symbol-snippet',
  cssCustomProperty: 'codicon codicon-symbol-variable',
}

const FALLBACK_CLASS = 'codicon codicon-symbol-misc'

/** Tipo nominal para classes CSS dos Codicons — garante type safety na cadeia de renderização */
export type ElementIconClass = (typeof KIND_TO_CODICON)[keyof typeof KIND_TO_CODICON] | typeof FALLBACK_CLASS

/**
 * Retorna a classe CSS do Codicon correspondente ao tipo de elemento de código.
 *
 * @param kind - Tipo do elemento (ex.: "class", "method", "interface")
 * @returns Classe CSS completa do Codicon (ex.: "codicon codicon-symbol-class")
 */
export function getElementIconClass(kind: CodeMapElementKind): ElementIconClass {
  return KIND_TO_CODICON[kind] || FALLBACK_CLASS
}

/**
 * Retorna a classe Devicon do VS Code, no mesmo formato usado pelo file-icon-mapper.
 *
 * @returns Classe CSS do Devicon (ex.: "devicon-vscode-plain")
 */
export function getVsCodeIconClass(): string {
  return 'devicon-vscode-plain'
}