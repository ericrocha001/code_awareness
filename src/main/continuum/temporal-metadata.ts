import type { ContinuumPeriod } from '../../shared/types/continuum-ui-types'

export function metadataPeriod(value: unknown): ContinuumPeriod | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/.exec(value)
  if (!match) return null
  const [, y, m, d, h, min, sec, , oh, om] = match
  const year = Number(y), month = Number(m), day = Number(d)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
    (h !== undefined && (Number(h) > 23 || Number(min) > 59 || Number(sec ?? 0) > 59)) ||
    (oh !== undefined && (Number(oh) > 23 || Number(om) > 59))) return null
  return { year, month }
}

export function validatePeriods(periods: unknown, metadata?: Record<string, unknown>): asserts periods is Record<string, ContinuumPeriod> | undefined {
  if (periods === undefined) return
  if (!periods || typeof periods !== 'object' || Array.isArray(periods) || ![Object.prototype, null].includes(Object.getPrototypeOf(periods))) throw new Error('INVALID_ARGUMENT: periods must be an object')
  for (const [key, entry] of Object.entries(periods)) {
    const value = entry as ContinuumPeriod
    if (!key.trim() || ['__proto__', 'constructor', 'prototype', 'name', 'description', 'relations'].includes(key) ||
      !value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || !Object.prototype.hasOwnProperty.call(value, 'year') || Object.keys(value).some(k => k !== 'year' && k !== 'month') ||
      !Number.isInteger(value.year) || value.year < 0 || value.year > 9999 ||
      (value.month !== undefined && (!Number.isInteger(value.month) || value.month < 1 || value.month > 12)) ||
      Object.prototype.hasOwnProperty.call(metadata ?? {}, key)) throw new Error('INVALID_ARGUMENT: invalid or conflicting period')
  }
}
