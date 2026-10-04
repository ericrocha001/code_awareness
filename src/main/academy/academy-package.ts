import { createHash } from 'node:crypto'
import { isAbsolute, posix } from 'node:path'
import type { AcademyPackage } from '../../shared/types/academy-types'

export class AcademyError extends Error {
  constructor(readonly code: string, message = code, readonly details?: Record<string, unknown>) {
    super(message)
  }
}

export interface AcademyMetadata { name: string; description: string }

const TEXT_ENCODER = new TextEncoder()

export function parseSkillMetadata(skillMd: string): AcademyMetadata {
  if (skillMd.charCodeAt(0) === 0xfeff) skillMd = skillMd.slice(1)
  const lines = skillMd.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') throw new AcademyError('INVALID_METADATA', 'SKILL.md must start with YAML frontmatter')
  const end = lines.slice(1).findIndex((line) => line.trim() === '---')
  if (end < 0) throw new AcademyError('INVALID_METADATA', 'SKILL.md frontmatter is not closed')
  const values = new Map<string, string>()
  for (const line of lines.slice(1, end + 1)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    values.set(match[1], value)
  }
  const name = values.get('name')?.trim() ?? ''
  const description = values.get('description')?.trim() ?? ''
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new AcademyError('INVALID_METADATA', 'Frontmatter name must be a lowercase filesystem-safe identifier')
  if (!description) throw new AcademyError('INVALID_METADATA', 'Frontmatter description is required')
  return { name, description }
}

export function normalizeAcademyPackage(input: AcademyPackage): AcademyPackage {
  if (!input || typeof input.skillMd !== 'string' || !input.skillMd) throw new AcademyError('INVALID_PACKAGE', 'SKILL.md is required')
  parseSkillMetadata(input.skillMd)
  const artifacts: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [rawPath, content] of Object.entries(input.artifacts ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const path = rawPath.replaceAll('\\', '/')
    const normalized = posix.normalize(path)
    if (!path || isAbsolute(path) || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || normalized === 'SKILL.md') {
      throw new AcademyError('INVALID_ARTIFACT_PATH', `Invalid artifact path: ${rawPath}`)
    }
    const folded = normalized.toLowerCase()
    if (seen.has(folded)) throw new AcademyError('DUPLICATE_ARTIFACT_PATH', `Duplicate artifact path: ${rawPath}`)
    if (typeof content !== 'string' || content.includes('\0')) throw new AcademyError('NON_TEXT_ARTIFACT', `Artifact must be UTF-8 text: ${rawPath}`)
    seen.add(folded)
    artifacts[normalized] = content
  }
  if (input.skillMd.includes('\0')) throw new AcademyError('NON_TEXT_ARTIFACT', 'SKILL.md must be UTF-8 text')
  return { skillMd: input.skillMd, artifacts }
}

export function hashAcademyPackage(input: AcademyPackage): string {
  const pkg = normalizeAcademyPackage(input)
  const hash = createHash('sha256')
  const add = (path: string, value: string) => {
    const bytes = TEXT_ENCODER.encode(value)
    hash.update(`${path.length}:${path}:${bytes.byteLength}:`)
    hash.update(bytes)
  }
  add('SKILL.md', pkg.skillMd)
  for (const [path, value] of Object.entries(pkg.artifacts)) add(path, value)
  return hash.digest('hex')
}
