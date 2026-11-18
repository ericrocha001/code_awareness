import { isAbsolute, posix } from 'node:path'
import { diffLines } from 'diff'
import { parseDocument } from 'yaml'
import type { AcademyPackage } from '../../shared/types/academy-types'
import { AcademyError, normalizeAcademyPackage } from './academy-package'

export interface EvidenceWindow {
  path?: string
  offset?: number
  limit?: number
  textOffset?: number
  textLimit?: number
}

const isHighSurrogate = (code: number) => code >= 0xD800 && code <= 0xDBFF
const isLowSurrogate = (code: number) => code >= 0xDC00 && code <= 0xDFFF

function assertCanonicalDiffPath(path: unknown): string {
  if (
    typeof path !== 'string' ||
    !path ||
    (path !== 'SKILL.md' && (
      path.includes('\\') ||
      path.includes('\0') ||
      isAbsolute(path) ||
      path.startsWith('/') ||
      path === '.' ||
      path === '..' ||
      path.startsWith('../') ||
      path.endsWith('/') ||
      posix.normalize(path) !== path
    ))
  ) {
    throw new AcademyError('INVALID_ARGUMENT')
  }
  return path
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
  if (offset > 0 && offset < text.length && isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset))) {
    throw new AcademyError('INVALID_ARGUMENT')
  }
  let end = Math.min(offset + limit, text.length)
  if (end < text.length && end > offset && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
    end = end - 1 > offset ? end - 1 : end + 1
  }
  return { text: text.slice(offset, end), offset, totalCharacters: text.length, nextOffset: end < text.length ? end : null }
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

export function compareAcademyPackages(beforeInput: AcademyPackage | null, afterInput: AcademyPackage, window: EvidenceWindow = {}) {
  const changeLimit = windowNumber(window.limit, 10, 50)
  const textLimit = windowNumber(window.textLimit, 400, 4000)
  if (!changeLimit || !textLimit) throw new AcademyError('INVALID_ARGUMENT')
  windowNumber(window.offset, 0, Number.MAX_SAFE_INTEGER)
  windowNumber(window.textOffset, 0, Number.MAX_SAFE_INTEGER)

  const selectedPath = window.path === undefined ? undefined : assertCanonicalDiffPath(window.path)
  const before = beforeInput === null ? null : normalizeAcademyPackage(beforeInput)
  const after = normalizeAcademyPackage(afterInput)
  const oldFiles = before === null ? new Map<string, string>() : new Map(Object.entries({ ...before.artifacts, 'SKILL.md': before.skillMd }))
  const newFiles = new Map(Object.entries({ ...after.artifacts, 'SKILL.md': after.skillMd }))
  if (selectedPath !== undefined && !oldFiles.has(selectedPath) && !newFiles.has(selectedPath)) {
    throw new AcademyError('PATH_NOT_FOUND', `Path not found in compared versions: ${selectedPath}`, { path: selectedPath })
  }
  const targetPaths = selectedPath !== undefined ? [selectedPath] : [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()
  const rawChanges: Array<{ path: string; kind: 'ADDED' | 'REMOVED' | 'MODIFIED'; literalEffect: 'WHITESPACE_ONLY' | 'UNKNOWN'; side: 'BEFORE' | 'AFTER'; line: number; lineCount: number; rawText: string }> = []
  for (const path of targetPaths) {
    const oldText = oldFiles.get(path), newText = newFiles.get(path)
    if (oldText === newText) continue
    const kind = oldText === undefined ? 'ADDED' : newText === undefined ? 'REMOVED' : 'MODIFIED'
    const literalEffect = oldText !== undefined && newText !== undefined && oldText.replace(/\s/g, '') === newText.replace(/\s/g, '') ? 'WHITESPACE_ONLY' : 'UNKNOWN'
    let oldLine = 1, newLine = 1
    for (const part of diffLines(oldText ?? '', newText ?? '')) {
      const count = part.count ?? 0
      if (part.added || part.removed) rawChanges.push({ path, kind, literalEffect, side: part.removed ? 'BEFORE' : 'AFTER', line: part.removed ? oldLine : newLine, lineCount: count, rawText: part.value })
      if (!part.added) oldLine += count
      if (!part.removed) newLine += count
    }
    if (oldText === '' || newText === '') {
      if ((oldText === undefined && newText === '') || (newText === undefined && oldText === '')) rawChanges.push({ path, kind, literalEffect, side: kind === 'REMOVED' ? 'BEFORE' : 'AFTER', line: 1, lineCount: 0, rawText: '' })
    }
  }
  const pagedChanges = page(rawChanges, window)
  const changes = {
    ...pagedChanges,
    items: pagedChanges.items.map(({ rawText, ...entry }) => ({ ...entry, content: excerpt(rawText, window) }))
  }
  const includeFrontmatter = selectedPath === undefined || selectedPath === 'SKILL.md'
  let resolved = false
  let keys: string[] = []
  if (includeFrontmatter) {
    const newMeta = frontmatter(after.skillMd)
    if (before === null) {
      resolved = !!newMeta
      keys = newMeta ? Object.keys(newMeta).sort() : []
    } else {
      const oldMeta = frontmatter(before.skillMd)
      resolved = !!oldMeta && !!newMeta
      keys = oldMeta && newMeta ? [...new Set([...Object.keys(oldMeta), ...Object.keys(newMeta)])].sort().filter(key => JSON.stringify(oldMeta[key]) !== JSON.stringify(newMeta[key])) : []
    }
  }
  return { changes, frontmatter: { resolved, changedProperties: page(keys, window) }, semanticEffect: 'NOT_ASSESSED' as const }
}
