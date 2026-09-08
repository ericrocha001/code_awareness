/*
-T ---
*/

import type { DashSettings } from '../types'

/** Configurações padrão do Code Dash: todas as opções de economia desativadas. */
export const DEFAULT_DASH_SETTINGS: DashSettings = {
  removeComments: false,
  removeEmptyLines: false,
  truncateBase64: false
}

/**
 * Normaliza defensivamente configurações do Code Dash de origem desconhecida.
 * Aceita null, undefined, arrays e objetos com campos extras ou ausentes,
 * retornando sempre um objeto completo e válido. Nunca lança erro.
 */
export function normalizeDashSettings(input: unknown): DashSettings {
  const raw = (typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input
    : {}) as Record<string, unknown>

  const bool = (key: keyof DashSettings, fallback: boolean): boolean =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : fallback

  return {
    removeComments: bool('removeComments', DEFAULT_DASH_SETTINGS.removeComments),
    removeEmptyLines: bool('removeEmptyLines', DEFAULT_DASH_SETTINGS.removeEmptyLines),
    truncateBase64: bool('truncateBase64', DEFAULT_DASH_SETTINGS.truncateBase64)
  }
}
