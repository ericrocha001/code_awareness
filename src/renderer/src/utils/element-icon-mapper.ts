/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Mapear tipos de elementos de código para classes CSS dos Codicons.
2. Fornecer fallback determinístico para tipos de elemento não reconhecidos.
3. Expor a classe Devicon do VS Code para a futura ação "Abrir no VS Code".

Mapa de Relacionamentos do Script

1. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece o tipo CodeMapElementKind consumido pelo mapeamento.
   - Criticidade: Alta

2. CodeMapTree.tsx
   - Tipo: Dependência Inversa
   - Relação: Consumirá getElementIconClass na Sprint 11 para renderizar ícones.
   - Criticidade: Alta

3. ElementDetail.tsx
   - Tipo: Dependência Inversa
   - Relação: Consumirá getElementIconClass e getVsCodeIconClass na Sprint 13.
   - Criticidade: Média

Invariantes do Script

1. Toda entrada válida deve retornar uma classe CSS existente no codicon.css.
2. Tipos de elemento não reconhecidos devem sempre retornar a classe de fallback.
3. O mapeamento deve ser determinístico: mesma entrada sempre produz mesma saída.
4. O módulo nunca deve importar React, componentes ou lógica de negócio.

--- FIM ARQUITETURA DO SCRIPT ---
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