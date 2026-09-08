/*
-T ---
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
