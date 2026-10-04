import type { AcademyOpenAiPluginProfile, AcademyOpenAiSnapshotEntry } from '../../../shared/types/academy-types'
import { AcademyError, parseSkillMetadata } from '../academy-package'
import { OPENAI_PLUGIN_SCHEMA } from './openai-plugin-model'
import type { ZipEntry } from './deterministic-zip'

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export interface OpenAiPackageValidation { valid: true; entryCount: number; skillCount: number }

export function validateOpenAiPluginPackage(entries: ZipEntry[], profile: AcademyOpenAiPluginProfile, snapshot: AcademyOpenAiSnapshotEntry[]): OpenAiPackageValidation {
  const errors: string[] = []
  const paths = new Map<string, Buffer>()
  for (const entry of entries) {
    const path = entry.path.replaceAll('\\', '/')
    if (path.startsWith('/') || path.split('/').includes('..') || paths.has(path.toLowerCase())) errors.push(`INVALID_PATH:${entry.path}`)
    paths.set(path.toLowerCase(), entry.data)
    const text = isTextPath(path) ? entry.data.toString('utf8') : ''
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b/.test(text)) errors.push(`KNOWN_SECRET:${path}`)
  }
  const roots = new Set(entries.map((entry) => entry.path.split('/')[0]).filter(Boolean))
  if (roots.size !== 1 || !roots.has(profile.name)) errors.push('EXACTLY_ONE_PLUGIN_ROOT_REQUIRED')
  const manifestPath = `${profile.name}/plugin.json`.toLowerCase()
  const manifestBytes = paths.get(manifestPath)
  let manifest: any = null
  try { manifest = manifestBytes ? JSON.parse(manifestBytes.toString('utf8')) : null } catch { errors.push('INVALID_PLUGIN_JSON') }
  if (!manifestBytes) errors.push('PLUGIN_JSON_MISSING')
  if (manifest) {
    if (manifest.$schema !== OPENAI_PLUGIN_SCHEMA) errors.push('INVALID_PLUGIN_SCHEMA')
    if (manifest.name !== profile.name || !NAME.test(manifest.name)) errors.push('INVALID_PLUGIN_IDENTITY')
    if (!SEMVER.test(manifest.version)) errors.push('INVALID_PLUGIN_VERSION')
    if (typeof manifest.description !== 'string' || !manifest.description.trim()) errors.push('INVALID_PLUGIN_DESCRIPTION')
    if (!manifest.author || typeof manifest.author.name !== 'string' || !manifest.author.name.trim()) errors.push('INVALID_PLUGIN_AUTHOR')
    const openAiInterface = manifest.extensions?.['com.openai']?.interface
    if (!openAiInterface || typeof openAiInterface.displayName !== 'string') errors.push('INVALID_OPENAI_INTERFACE')
    const assetReferences = [openAiInterface?.composerIcon, openAiInterface?.logo].filter((value): value is string => typeof value === 'string')
    for (const reference of assetReferences) {
      if (!reference.startsWith('./') || reference.includes('..')) errors.push(`INVALID_ASSET_REFERENCE:${reference}`)
      else if (!paths.has(`${profile.name}/${reference.slice(2)}`.toLowerCase())) errors.push(`MISSING_ASSET:${reference}`)
    }
    if (!profile.logoPath && assetReferences.length) errors.push('UNCONFIGURED_ASSET_REFERENCE')
  }

  const expectedNames = new Set(snapshot.map((entry) => entry.name))
  const discovered = new Set<string>()
  for (const entry of entries) {
    const match = new RegExp(`^${escapeRegExp(profile.name)}/skills/([^/]+)/SKILL\\.md$`).exec(entry.path)
    if (!match) continue
    const name = match[1]
    if (!NAME.test(name)) errors.push(`INVALID_SKILL_DIRECTORY:${name}`)
    if (discovered.has(name)) errors.push(`DUPLICATE_SKILL:${name}`)
    discovered.add(name)
    try {
      assertValidFrontmatter(entry.data.toString('utf8'))
      const metadata = parseSkillMetadata(entry.data.toString('utf8'))
      if (metadata.name !== name) errors.push(`SKILL_NAME_MISMATCH:${name}`)
    } catch (error) { errors.push(`INVALID_SKILL:${name}:${error instanceof Error ? error.message : String(error)}`) }
  }
  for (const name of expectedNames) if (!discovered.has(name)) errors.push(`SNAPSHOT_SKILL_MISSING:${name}`)
  for (const name of discovered) if (!expectedNames.has(name)) errors.push(`EXTERNAL_SKILL:${name}`)
  for (const entry of entries) {
    const allowed = entry.path === `${profile.name}/plugin.json` || entry.path === `${profile.name}/assets/logo.png` || entry.path.startsWith(`${profile.name}/skills/`)
    if (!allowed) errors.push(`UNEXPECTED_FILE:${entry.path}`)
    if (/\/(?:mcp\.json|\.app\.json|\.codex-plugin\/|node_modules\/|scripts?\/)/i.test(`/${entry.path}`)) errors.push(`FORBIDDEN_COMPONENT:${entry.path}`)
  }
  const logo = paths.get(`${profile.name}/assets/logo.png`.toLowerCase())
  if (profile.logoPath && !logo) errors.push('CONFIGURED_LOGO_MISSING')
  if (logo) validatePngLogo(logo, errors)
  if (errors.length) throw new AcademyError('OPENAI_PACKAGE_INVALID', errors.join('; '), { errors })
  return { valid: true, entryCount: entries.length, skillCount: discovered.size }
}

function assertValidFrontmatter(value: string): void {
  const lines = value.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') throw new Error('frontmatter missing')
  const end = lines.slice(1).findIndex((line) => line.trim() === '---')
  if (end < 0) throw new Error('frontmatter unclosed')
  const keys = new Set<string>()
  for (const line of lines.slice(1, end + 1)) {
    if (!line.trim() || /^\s+#/.test(line)) continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+.*)?$/.exec(line)
    if (!match) throw new Error(`invalid YAML line: ${line}`)
    if (keys.has(match[1])) throw new Error(`duplicate YAML key: ${match[1]}`)
    keys.add(match[1])
  }
}

function validatePngLogo(value: Buffer, errors: string[]): void {
  if (value.length > 5 * 1024 * 1024) errors.push('LOGO_TOO_LARGE')
  if (value.length < 24 || value.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') { errors.push('LOGO_UNSUPPORTED_FORMAT'); return }
  const width = value.readUInt32BE(16); const height = value.readUInt32BE(20)
  if (width !== height || width < 48 || width > 4096) errors.push(`LOGO_INVALID_DIMENSIONS:${width}x${height}`)
}

function isTextPath(path: string): boolean { return /(?:\.md|\.json|\.ya?ml|\.txt)$/i.test(path) }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
