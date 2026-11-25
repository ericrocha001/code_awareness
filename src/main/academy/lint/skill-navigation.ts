import { posix } from 'node:path'
import type { AcademyPackage, AcademySkillSummary, AcademySkillVersion } from '../../../shared/types/academy-types'
import { AcademyError } from '../academy-package'
import type { FileOutlineEntry, PackageFacts, SkillLintFinding } from './skill-lint-types'

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

const SELECTOR_RE = /^([a-f0-9]{12}):(.+?)#(h|b)(\d+)$/

export function assertCanonicalSkillFilePath(path: unknown): string {
  if (typeof path !== 'string' || !path) {
    throw new AcademyError('INVALID_ARTIFACT_PATH', 'Invalid skill file path')
  }
  if (path === 'SKILL.md') return path
  const normalized = posix.normalize(path)
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    posix.isAbsolute(path) ||
    path.startsWith('/') ||
    path === '.' ||
    path === '..' ||
    path.startsWith('../') ||
    path.endsWith('/') ||
    normalized !== path ||
    path.toLowerCase() === 'skill.md'
  ) {
    throw new AcademyError('INVALID_ARTIFACT_PATH', `Invalid canonical artifact path: ${path}`, { path })
  }
  return path
}

export function getPackageFileContent(pkg: AcademyPackage, path: string): string | undefined {
  if (path === 'SKILL.md') return pkg.skillMd
  return Object.hasOwn(pkg.artifacts, path) ? pkg.artifacts[path] : undefined
}

export function sliceLiteralText(
  text: string,
  textOffset = 0,
  textLimit = 12000
): { text: string; offset: number; totalCharacters: number; nextOffset: number | null } {
  if (!Number.isSafeInteger(textOffset) || textOffset < 0) {
    throw new AcademyError('INVALID_ARGUMENT', 'textOffset must be a non-negative integer')
  }
  if (!Number.isSafeInteger(textLimit) || textLimit < 1 || textLimit > 12288) {
    throw new AcademyError('INVALID_ARGUMENT', 'textLimit must be an integer between 1 and 12288')
  }
  if (
    textOffset > 0 &&
    textOffset < text.length &&
    isHighSurrogate(text.charCodeAt(textOffset - 1)) &&
    isLowSurrogate(text.charCodeAt(textOffset))
  ) {
    throw new AcademyError('INVALID_ARGUMENT', 'textOffset splits a UTF-16 surrogate pair')
  }
  const offset = Math.min(textOffset, text.length)
  let end = Math.min(offset + textLimit, text.length)
  if (
    end < text.length &&
    end > offset &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end = end - 1 > offset ? end - 1 : end + 1
  }
  return {
    text: text.slice(offset, end),
    offset,
    totalCharacters: text.length,
    nextOffset: end < text.length ? end : null
  }
}

export function parseSnapshotSelector(
  selector: string,
  expectedPackageHash: string,
  expectedPath: string
): { kind: 'h' | 'b'; index: number } {
  const match = SELECTOR_RE.exec(selector)
  if (!match) {
    throw new AcademyError('SELECTOR_STALE', 'Invalid or malformed snapshot selector', { selector })
  }
  const [, hashPrefix, selPath, kind, rawIdx] = match
  if (hashPrefix !== expectedPackageHash.slice(0, 12) || selPath !== expectedPath) {
    throw new AcademyError('SELECTOR_STALE', 'Selector does not match target version snapshot or path', {
      selector,
      expectedPackageHash: expectedPackageHash.slice(0, 12),
      expectedPath
    })
  }
  return { kind: kind as 'h' | 'b', index: Number(rawIdx) }
}

export function buildManifestView(
  skill: AcademySkillSummary,
  versionRecord: AcademySkillVersion,
  facts: PackageFacts | null
) {
  return {
    skillId: skill.id,
    name: skill.name,
    scope: skill.scope,
    status: skill.status,
    version: versionRecord.version,
    packageHash: versionRecord.packageHash,
    contentState: versionRecord.contentState ?? 'PRESENT',
    files: facts
      ? facts.measures.files.map(file => ({
          path: file.path,
          bytes: file.bytes,
          sha256: file.sha256,
          lines: file.lines,
          tokens: file.tokens,
          isMarkdown: file.isMarkdown,
          coverage: file.coverage
        }))
      : [],
    ...(facts
      ? {
          measures: {
            lineConvention: facts.lineConvention,
            tokenizerId: facts.tokenizerId,
            metadataTokens: facts.measures.metadataTokens,
            bodyTokens: facts.measures.bodyTokens,
            bodyLines: facts.measures.bodyLines,
            skillMdTokens: facts.measures.skillMdTokens,
            resourcesTokens: facts.measures.resourcesTokens,
            packageTokens: facts.measures.packageTokens,
            packageBytes: facts.measures.packageBytes,
            resourceCount: facts.measures.resourceCount
          }
        }
      : {})
  }
}

export function buildResourceView(
  skill: AcademySkillSummary,
  versionRecord: AcademySkillVersion,
  path: string,
  textOffset?: number,
  textLimit?: number
) {
  if (versionRecord.contentState === 'DELETED') {
    throw new AcademyError('VERSION_CONTENT_DELETED', 'Skill version content was deleted')
  }
  const canonicalPath = assertCanonicalSkillFilePath(path)
  const content = getPackageFileContent(versionRecord.package, canonicalPath)
  if (content === undefined) {
    throw new AcademyError('PATH_NOT_FOUND', `Path not found in version ${versionRecord.version}: ${canonicalPath}`, {
      path: canonicalPath,
      version: versionRecord.version
    })
  }
  return {
    skillId: skill.id,
    name: skill.name,
    scope: skill.scope,
    version: versionRecord.version,
    packageHash: versionRecord.packageHash,
    path: canonicalPath,
    content: sliceLiteralText(content, textOffset, textLimit)
  }
}

export function buildOutlineView(
  skill: AcademySkillSummary,
  versionRecord: AcademySkillVersion,
  facts: PackageFacts,
  path: string,
  findings: SkillLintFinding[],
  offset = 0,
  limit = 50
) {
  if (versionRecord.contentState === 'DELETED') {
    throw new AcademyError('VERSION_CONTENT_DELETED', 'Skill version content was deleted')
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AcademyError('INVALID_ARGUMENT', 'offset must be a non-negative integer')
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AcademyError('INVALID_ARGUMENT', 'limit must be an integer between 1 and 100')
  }
  const canonicalPath = assertCanonicalSkillFilePath(path)
  const fileContent = getPackageFileContent(versionRecord.package, canonicalPath)
  if (fileContent === undefined) {
    throw new AcademyError('PATH_NOT_FOUND', `Path not found in version ${versionRecord.version}: ${canonicalPath}`)
  }
  const fileMeasure = facts.measures.files.find(f => f.path === canonicalPath)
  const outline = facts.outlines[canonicalPath]
  const allEntries: FileOutlineEntry[] = outline ? outline.entries : []
  const pagedEntries = allEntries.slice(offset, offset + limit)
  const nextOffset = offset + pagedEntries.length < allEntries.length ? offset + pagedEntries.length : null

  return {
    skillId: skill.id,
    name: skill.name,
    scope: skill.scope,
    version: versionRecord.version,
    packageHash: versionRecord.packageHash,
    path: canonicalPath,
    coverage: outline?.coverage ?? fileMeasure?.coverage ?? 'COMPLETE',
    fileMeasure,
    entries: pagedEntries,
    totalEntries: allEntries.length,
    offset,
    nextOffset,
    localLinks: facts.localLinks.filter(l => l.path === canonicalPath),
    externalRefs: facts.externalRefs.filter(r => r.path === canonicalPath),
    findings: findings.filter(
      f => f.path === canonicalPath || f.occurrences?.some(occ => occ.path === canonicalPath)
    )
  }
}

export function buildSectionView(
  skill: AcademySkillSummary,
  versionRecord: AcademySkillVersion,
  facts: PackageFacts,
  path: string,
  selector: string,
  includeDescendants = false,
  textOffset?: number,
  textLimit?: number
) {
  if (versionRecord.contentState === 'DELETED') {
    throw new AcademyError('VERSION_CONTENT_DELETED', 'Skill version content was deleted')
  }
  const canonicalPath = assertCanonicalSkillFilePath(path)
  const fileContent = getPackageFileContent(versionRecord.package, canonicalPath)
  if (fileContent === undefined) {
    throw new AcademyError('PATH_NOT_FOUND', `Path not found in version ${versionRecord.version}: ${canonicalPath}`)
  }
  parseSnapshotSelector(selector, versionRecord.packageHash, canonicalPath)

  const outline = facts.outlines[canonicalPath]
  const entry = outline?.entries.find(e => e.selector === selector)
  if (!entry) {
    throw new AcademyError('SELECTOR_NOT_FOUND', `Selector not found in ${canonicalPath}: ${selector}`, { selector })
  }

  let range = entry.range
  if (entry.kind === 'HEADING') {
    const sectionMeasure = facts.measures.sections.find(s => s.selector === selector)
    if (sectionMeasure) {
      range = includeDescendants ? sectionMeasure.subtreeRange : sectionMeasure.range
    }
  }

  const literal = fileContent.slice(range.startOffset, range.endOffset)
  return {
    skillId: skill.id,
    name: skill.name,
    scope: skill.scope,
    version: versionRecord.version,
    packageHash: versionRecord.packageHash,
    path: canonicalPath,
    selector,
    kind: entry.kind,
    blockType: entry.blockType,
    includeDescendants,
    range,
    content: sliceLiteralText(literal, textOffset, textLimit)
  }
}

function lineNumberAtOffset(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) line++
  }
  return line
}

function containingSectionSelector(facts: PackageFacts, path: string, offset: number): string | null {
  const sections = facts.measures.sections.filter(s => s.path === path)
  let best: string | null = null
  for (const section of sections) {
    if (section.range.startOffset <= offset && offset < section.range.endOffset) {
      best = section.selector
    }
  }
  return best
}

export function buildSearchView(
  skill: AcademySkillSummary,
  versionRecord: AcademySkillVersion,
  facts: PackageFacts,
  query: string,
  path?: string,
  caseSensitive = false,
  offset = 0,
  limit = 20
) {
  if (versionRecord.contentState === 'DELETED') {
    throw new AcademyError('VERSION_CONTENT_DELETED', 'Skill version content was deleted')
  }
  if (typeof query !== 'string' || query.length < 1 || query.length > 200) {
    throw new AcademyError('INVALID_ARGUMENT', 'query must be 1..200 characters')
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AcademyError('INVALID_ARGUMENT', 'offset must be a non-negative integer')
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new AcademyError('INVALID_ARGUMENT', 'limit must be an integer between 1 and 50')
  }

  const targetPaths: string[] = []
  if (path !== undefined) {
    const canonicalPath = assertCanonicalSkillFilePath(path)
    if (getPackageFileContent(versionRecord.package, canonicalPath) === undefined) {
      throw new AcademyError('PATH_NOT_FOUND', `Path not found in version ${versionRecord.version}: ${canonicalPath}`)
    }
    targetPaths.push(canonicalPath)
  } else {
    targetPaths.push('SKILL.md', ...Object.keys(versionRecord.package.artifacts).sort())
  }

  const needle = caseSensitive ? query : query.toLowerCase()
  const matches: Array<{
    path: string
    line: number
    startOffset: number
    endOffset: number
    sectionSelector: string | null
    preview: string
  }> = []

  for (const filePath of targetPaths) {
    const content = getPackageFileContent(versionRecord.package, filePath)!
    const haystack = caseSensitive ? content : content.toLowerCase()
    let searchFrom = 0
    while (searchFrom <= haystack.length - needle.length) {
      const idx = haystack.indexOf(needle, searchFrom)
      if (idx === -1) break
      const endOffset = idx + needle.length
      const previewStart = Math.max(0, idx - 40)
      const previewEnd = Math.min(content.length, previewStart + 160)
      const preview = content.slice(previewStart, previewEnd).replace(/\r?\n/g, ' ')
      matches.push({
        path: filePath,
        line: lineNumberAtOffset(content, idx),
        startOffset: idx,
        endOffset,
        sectionSelector: containingSectionSelector(facts, filePath, idx),
        preview: preview.length > 160 ? preview.slice(0, 160) : preview
      })
      searchFrom = idx + Math.max(1, needle.length)
    }
  }

  const paged = matches.slice(offset, offset + limit)
  const nextOffset = offset + paged.length < matches.length ? offset + paged.length : null

  return {
    skillId: skill.id,
    name: skill.name,
    scope: skill.scope,
    version: versionRecord.version,
    packageHash: versionRecord.packageHash,
    query,
    caseSensitive,
    ...(path !== undefined ? { path: assertCanonicalSkillFilePath(path) } : {}),
    matches: paged,
    totalMatches: matches.length,
    offset,
    nextOffset
  }
}
