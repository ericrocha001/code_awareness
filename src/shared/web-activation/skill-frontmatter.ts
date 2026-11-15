import { parseDocument } from 'yaml'

export interface SkillFrontmatter {
  name: string
  description: string
  [key: string]: unknown
}

export type SkillFrontmatterParseResult =
  | { ok: true; frontmatter: SkillFrontmatter }
  | { ok: false; code: 'MISSING_FRONTMATTER' | 'INVALID_YAML' | 'INVALID_FRONTMATTER'; message: string }

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/
const FRONTMATTER_PATTERN = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

function toJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('NON_FINITE_NUMBER')
    return value
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = toJsonValue(v)
    }
    return out
  }
  throw new Error('UNSUPPORTED_FRONTMATTER_TYPE')
}

export function parseSkillFrontmatter(skillMd: string): SkillFrontmatterParseResult {
  if (typeof skillMd !== 'string') {
    return { ok: false, code: 'MISSING_FRONTMATTER', message: 'SKILL.md must be a string' }
  }
  const normalized = skillMd.charCodeAt(0) === 0xfeff ? skillMd.slice(1) : skillMd
  const match = FRONTMATTER_PATTERN.exec(normalized)
  if (!match) {
    return { ok: false, code: 'MISSING_FRONTMATTER', message: 'SKILL.md must start with closed YAML frontmatter' }
  }
  const doc = parseDocument(match[1], { uniqueKeys: true })
  if (doc.errors.length > 0) {
    return { ok: false, code: 'INVALID_YAML', message: doc.errors[0].message }
  }
  let parsed: unknown
  try {
    parsed = toJsonValue(doc.toJS({ maxAliasCount: 0 }))
  } catch (error) {
    return {
      ok: false,
      code: 'INVALID_FRONTMATTER',
      message: error instanceof Error ? error.message : 'Frontmatter contains unsupported values'
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'INVALID_FRONTMATTER', message: 'Frontmatter must be a YAML mapping object' }
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.name !== 'string' || !SKILL_NAME_PATTERN.test(record.name.trim())) {
    return {
      ok: false,
      code: 'INVALID_FRONTMATTER',
      message: 'Frontmatter name must be a lowercase filesystem-safe identifier'
    }
  }
  if (typeof record.description !== 'string' || !record.description.trim()) {
    return { ok: false, code: 'INVALID_FRONTMATTER', message: 'Frontmatter description is required' }
  }
  return {
    ok: true,
    frontmatter: {
      ...record,
      name: record.name.trim(),
      description: record.description
    }
  }
}

export function deepEqualFrontmatter(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqualFrontmatter(a[i], b[i])) return false
    }
    return true
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const objA = a as Record<string, unknown>
    const objB = b as Record<string, unknown>
    const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined)
    const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined)
    if (keysA.length !== keysB.length) return false
    for (const key of keysA) {
      if (!Object.hasOwn(objB, key)) return false
      if (!deepEqualFrontmatter(objA[key], objB[key])) return false
    }
    return true
  }
  return false
}
