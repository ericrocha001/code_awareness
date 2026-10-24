import { diffLines } from 'diff'
import { parseDocument } from 'yaml'
import type { AcademyPackage } from '../../shared/types/academy-types'
import { AcademyError, normalizeAcademyPackage } from './academy-package'

export interface EvidenceWindow {
  offset?: number
  limit?: number
  textOffset?: number
  textLimit?: number
}

export function windowNumber(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new AcademyError('INVALID_ARGUMENT')
  return value
}

export function excerpt(text: string, window: EvidenceWindow = {}) {
  const offset = windowNumber(window.textOffset, 0, Number.MAX_SAFE_INTEGER)
  const limit = windowNumber(window.textLimit, 400, 4000)
  if (!limit) throw new AcademyError('INVALID_ARGUMENT')
  return { text: text.slice(offset, offset + limit), offset, totalCharacters: text.length, nextOffset: offset + limit < text.length ? offset + limit : null }
}

export function page<T>(values: T[], window: EvidenceWindow = {}) {
  const offset = windowNumber(window.offset, 0, Number.MAX_SAFE_INTEGER)
  const limit = windowNumber(window.limit, 10, 50)
  if (!limit) throw new AcademyError('INVALID_ARGUMENT')
  return { items: values.slice(offset, offset + limit), total: values.length, offset, nextOffset: offset + limit < values.length ? offset + limit : null }
}

function frontmatter(text: string): Record<string, unknown> | null {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return null
  try {
    const doc = parseDocument(match[1], { uniqueKeys: true })
    if (doc.errors.length) return null
    const result = doc.toJS({ maxAliasCount: 0 })
    return result && typeof result === 'object' && !Array.isArray(result) ? result : null
  } catch { return null }
}

export function compareAcademyPackages(beforeInput: AcademyPackage, afterInput: AcademyPackage, window: EvidenceWindow = {}) {
  const before = normalizeAcademyPackage(beforeInput), after = normalizeAcademyPackage(afterInput)
  const oldFiles = new Map(Object.entries({ ...before.artifacts, 'SKILL.md': before.skillMd }))
  const newFiles = new Map(Object.entries({ ...after.artifacts, 'SKILL.md': after.skillMd }))
  const changes: Array<{ path: string; kind: 'ADDED' | 'REMOVED' | 'MODIFIED'; literalEffect: 'WHITESPACE_ONLY' | 'UNKNOWN'; side: 'BEFORE' | 'AFTER'; line: number; lineCount: number; content: ReturnType<typeof excerpt> }> = []
  for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    const oldText = oldFiles.get(path), newText = newFiles.get(path)
    if (oldText === newText) continue
    const kind = oldText === undefined ? 'ADDED' : newText === undefined ? 'REMOVED' : 'MODIFIED'
    const literalEffect = oldText !== undefined && newText !== undefined && oldText.replace(/\s/g, '') === newText.replace(/\s/g, '') ? 'WHITESPACE_ONLY' : 'UNKNOWN'
    let oldLine = 1, newLine = 1
    for (const part of diffLines(oldText ?? '', newText ?? '')) {
      const count = part.count ?? 0
      if (part.added || part.removed) changes.push({ path, kind, literalEffect, side: part.removed ? 'BEFORE' : 'AFTER', line: part.removed ? oldLine : newLine, lineCount: count, content: excerpt(part.value, window) })
      if (!part.added) oldLine += count
      if (!part.removed) newLine += count
    }
    if (oldText === '' || newText === '') {
      if ((oldText === undefined && newText === '') || (newText === undefined && oldText === '')) changes.push({ path, kind, literalEffect, side: kind === 'REMOVED' ? 'BEFORE' : 'AFTER', line: 1, lineCount: 0, content: excerpt('', window) })
    }
  }
  const oldMeta = frontmatter(before.skillMd), newMeta = frontmatter(after.skillMd)
  const keys = oldMeta && newMeta ? [...new Set([...Object.keys(oldMeta), ...Object.keys(newMeta)])].sort().filter(key => JSON.stringify(oldMeta[key]) !== JSON.stringify(newMeta[key])) : []
  return { changes: page(changes, window), frontmatter: { resolved: !!oldMeta && !!newMeta, changedProperties: page(keys, window) }, semanticEffect: 'NOT_ASSESSED' as const }
}
