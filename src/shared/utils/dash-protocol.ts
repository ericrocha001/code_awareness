/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Centralizar constantes de versão e representações suportadas do protocolo Code Dash.
2. Fornecer guardas de tipo e funções de normalização para dados do protocolo Code Dash.

Mapa de Relacionamentos do Script

1. src/shared/types/dash-types.ts
   - Tipo: Dependência Direta
   - Relação: Importa DashRepresentation para tipar constantes e type guards.
   - Criticidade: Alta

2. src/main/core/dash/dash-request-validator.ts
   - Tipo: Dependência Inversa
   - Relação: Consumido pelo validador para verificar versão do protocolo e tipos de representação.
   - Criticidade: Alta

Invariantes do Script

1. DASH_PROTOCOL_VERSION deve permanecer como 'code-dash/v1' de forma imutável.
2. normalizeDashProtocol nunca deve lançar exceção ao receber entradas inválidas ou de tipos arbitrários.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type { DashRepresentation } from '../types/dash-types'

export const DASH_PROTOCOL_VERSION = 'code-dash/v1'

export const DASH_SUPPORTED_REPRESENTATIONS: readonly DashRepresentation[] = [
  'source',
  'compression'
] as const

export function normalizeDashProtocol(input: unknown): string {
  if (typeof input === 'string') {
    return input.trim()
  }
  return ''
}

export function isDashRepresentation(value: unknown): value is DashRepresentation {
  if (typeof value !== 'string') {
    return false
  }
  return (DASH_SUPPORTED_REPRESENTATIONS as readonly string[]).includes(value)
}
