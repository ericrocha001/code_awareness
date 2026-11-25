import { createHash } from 'node:crypto'
import type { TokenizerPort } from '../../core/tokenizer'
import type { AcademyPackage } from '../../../shared/types/academy-types'
import { isMarkdownPath } from './skill-lint-ruleset'
import {
  LINE_CONVENTION,
  type FileMeasure,
  type ParsedMarkdownFile,
  type SectionMeasure,
  type SkillMeasures
} from './skill-lint-types'
import { countLines, parseMarkdownFile } from './skill-markdown'

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export interface MeasuredPackageFiles {
  measures: SkillMeasures
  parsedMarkdown: Map<string, ParsedMarkdownFile>
}

export function measurePackage(
  pkg: AcademyPackage,
  packageHash: string,
  meta: { name: string | null; description: string | null },
  tokenizer: TokenizerPort
): MeasuredPackageFiles {
  const hashPrefix = packageHash.slice(0, 12)
  const parsedMarkdown = new Map<string, ParsedMarkdownFile>()
  const files: FileMeasure[] = []
  const sections: SectionMeasure[] = []

  const allEntries: Array<[string, string]> = [
    ['SKILL.md', pkg.skillMd],
    ...Object.entries(pkg.artifacts).sort(([a], [b]) => a.localeCompare(b))
  ]

  let skillMdTokens = 0
  let skillMdLines = 0
  let skillMdBytes = 0
  let resourcesTokens = 0
  let resourcesBytes = 0
  let frontmatterTokens = 0
  let bodyTokens = 0
  let bodyLines = 0
  let bodyBytes = 0

  for (const [filePath, content] of allEntries) {
    const isSkillMd = filePath === 'SKILL.md'
    const isMd = isMarkdownPath(filePath)
    const bytes = Buffer.byteLength(content, 'utf8')
    const lines = countLines(content)
    const tokens = tokenizer.count(content)
    const sha256 = sha256Hex(content)
    let fileCoverage: 'COMPLETE' | 'PARTIAL' = 'COMPLETE'

    if (isMd) {
      const parsed = parseMarkdownFile(content, { isSkillMd })
      parsedMarkdown.set(filePath, parsed)
      fileCoverage = parsed.coverage

      if (isSkillMd) {
        if (parsed.frontmatterRange) {
          frontmatterTokens = tokenizer.count(
            content.slice(parsed.frontmatterRange.startOffset, parsed.frontmatterRange.endOffset)
          )
        }
        const bodyText = content.slice(parsed.bodyStartOffset)
        bodyTokens = tokenizer.count(bodyText)
        bodyLines = countLines(bodyText)
        bodyBytes = Buffer.byteLength(bodyText, 'utf8')
      }

      for (let i = 0; i < parsed.headings.length; i++) {
        const heading = parsed.headings[i]
        const nextAny = parsed.headings[i + 1]
        const ownEndOffset = nextAny ? nextAny.range.startOffset : content.length
        const ownEndLine = nextAny ? Math.max(heading.range.endLine, nextAny.range.startLine - 1) : lines

        let subtreeEndOffset = content.length
        let subtreeEndLine = lines
        for (let j = i + 1; j < parsed.headings.length; j++) {
          if (parsed.headings[j].level <= heading.level) {
            subtreeEndOffset = parsed.headings[j].range.startOffset
            subtreeEndLine = Math.max(heading.range.endLine, parsed.headings[j].range.startLine - 1)
            break
          }
        }

        const ownText = content.slice(heading.range.startOffset, ownEndOffset)
        const subtreeText = content.slice(heading.range.startOffset, subtreeEndOffset)

        sections.push({
          path: filePath,
          selector: `${hashPrefix}:${filePath}#h${heading.headingIndex}`,
          headingIndex: heading.headingIndex,
          level: heading.level,
          title: heading.title,
          range: {
            startLine: heading.range.startLine,
            endLine: ownEndLine,
            startOffset: heading.range.startOffset,
            endOffset: ownEndOffset
          },
          subtreeRange: {
            startLine: heading.range.startLine,
            endLine: subtreeEndLine,
            startOffset: heading.range.startOffset,
            endOffset: subtreeEndOffset
          },
          ownTokens: tokenizer.count(ownText),
          ownLines: countLines(ownText),
          ownBytes: Buffer.byteLength(ownText, 'utf8'),
          subtreeTokens: tokenizer.count(subtreeText),
          subtreeLines: countLines(subtreeText),
          subtreeBytes: Buffer.byteLength(subtreeText, 'utf8')
        })
      }
    }

    files.push({
      path: filePath,
      bytes,
      lines,
      tokens,
      sha256,
      isMarkdown: isMd,
      coverage: fileCoverage
    })

    if (isSkillMd) {
      skillMdTokens = tokens
      skillMdLines = lines
      skillMdBytes = bytes
    } else {
      resourcesTokens += tokens
      resourcesBytes += bytes
    }
  }

  const nameTokens = meta.name ? tokenizer.count(meta.name) : 0
  const descriptionTokens = meta.description ? tokenizer.count(meta.description) : 0

  return {
    measures: {
      lineConvention: LINE_CONVENTION,
      tokenizerId: tokenizer.id,
      tokenizerEncoding: tokenizer.encoding,
      nameTokens,
      descriptionTokens,
      metadataTokens: nameTokens + descriptionTokens,
      frontmatterTokens,
      bodyTokens,
      bodyLines,
      bodyBytes,
      skillMdTokens,
      skillMdLines,
      skillMdBytes,
      resourcesTokens,
      resourcesBytes,
      packageTokens: skillMdTokens + resourcesTokens,
      packageBytes: skillMdBytes + resourcesBytes,
      resourceCount: allEntries.length - 1,
      files,
      sections
    },
    parsedMarkdown
  }
}
