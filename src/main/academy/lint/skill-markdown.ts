import type {
  LintRange,
  ParsedInlineCodeSpan,
  ParsedMarkdownBlock,
  ParsedMarkdownFile,
  ParsedMarkdownHeading,
  ParsedMarkdownLink
} from './skill-lint-types'

interface RawLine {
  lineNumber: number
  text: string
  start: number
  contentEnd: number
  endWithEol: number
}

const INDEX_HEADING_RE = /^(?:contents|table of contents|índice|indice|sumário|sumario|summary|toc)$/i
const ATX_HEADING_RE = /^[ ]{0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/
const FENCE_OPEN_RE = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/
const SETEXT_RE = /^[ ]{0,3}(=+|-+)[ \t]*$/
const THEMATIC_BREAK_RE = /^[ ]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const HTML_START_RE = /^[ ]{0,3}<(?:!--|!DOCTYPE|\?|\/?[A-Za-z][A-Za-z0-9-]*(?:[\s>/]|$))/
const BLOCKQUOTE_RE = /^[ ]{0,3}>/
const LIST_ITEM_RE = /^[ ]{0,3}(?:[-+*][ \t]+|\d{1,9}[.)][ \t]+)/
const TABLE_RE = /^[ ]{0,3}\|/
const INDENTED_CODE_RE = /^(?: {4}|\t)/
const REF_DEF_RE = /^[ ]{0,3}\[([^\]]+)\]:[ \t]*(?:<([^>\s]+)>|([^\s]+))/

export function countLines(text: string): number {
  if (!text.length) return 0
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++
  }
  if (!text.endsWith('\n')) count++
  return count
}

function splitPreservingOffsets(text: string, startOffset: number): RawLine[] {
  const lines: RawLine[] = []
  let pos = startOffset
  let lineNumber = 1
  if (pos >= text.length) return lines
  while (pos < text.length) {
    const lf = text.indexOf('\n', pos)
    if (lf === -1) {
      const contentEnd = text.endsWith('\r') ? text.length - 1 : text.length
      lines.push({
        lineNumber,
        text: text.slice(pos, contentEnd),
        start: pos,
        contentEnd,
        endWithEol: text.length
      })
      break
    }
    const contentEnd = lf > pos && text.charCodeAt(lf - 1) === 13 ? lf - 1 : lf
    lines.push({
      lineNumber,
      text: text.slice(pos, contentEnd),
      start: pos,
      contentEnd,
      endWithEol: lf + 1
    })
    pos = lf + 1
    lineNumber++
  }
  return lines
}

function cleanAtxTitle(raw: string): string {
  return raw.replace(/[ \t]+#+[ \t]*$/, '').trim()
}

function isBlank(line: RawLine): boolean {
  return /^[ \t]*$/.test(line.text)
}

function isBlockInterrupt(line: RawLine): boolean {
  return (
    isBlank(line) ||
    ATX_HEADING_RE.test(line.text) ||
    FENCE_OPEN_RE.test(line.text) ||
    HTML_START_RE.test(line.text) ||
    BLOCKQUOTE_RE.test(line.text) ||
    LIST_ITEM_RE.test(line.text) ||
    TABLE_RE.test(line.text) ||
    THEMATIC_BREAK_RE.test(line.text)
  )
}

function maskInlineCode(segment: string): string {
  const chars = [...segment]
  let i = 0
  const out: string[] = []
  while (i < chars.length) {
    if (chars[i] !== '`') {
      out.push(chars[i])
      i++
      continue
    }
    let tickCount = 0
    while (i + tickCount < chars.length && chars[i + tickCount] === '`') tickCount++
    let j = i + tickCount
    let foundClose = false
    while (j < chars.length) {
      if (chars[j] === '`') {
        let closeCount = 0
        while (j + closeCount < chars.length && chars[j + closeCount] === '`') closeCount++
        if (closeCount === tickCount) {
          for (let k = i; k < j + closeCount; k++) out.push(' ')
          i = j + closeCount
          foundClose = true
          break
        }
        j += closeCount
      } else {
        j++
      }
    }
    if (!foundClose) {
      for (let k = 0; k < tickCount; k++) out.push('`')
      i += tickCount
    }
  }
  return out.join('')
}

function extractInlineCodeSpansFromLine(line: RawLine, spans: ParsedInlineCodeSpan[]): void {
  const s = line.text
  let i = 0
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2
      continue
    }
    if (s[i] !== '`') {
      i++
      continue
    }
    let tickCount = 0
    while (i + tickCount < s.length && s[i + tickCount] === '`') tickCount++
    let j = i + tickCount
    let foundClose = false
    while (j < s.length) {
      if (s[j] === '`') {
        let closeCount = 0
        while (j + closeCount < s.length && s[j + closeCount] === '`') closeCount++
        if (closeCount === tickCount) {
          let contentStart = i + tickCount
          let contentEnd = j
          let content = s.slice(contentStart, contentEnd)
          if (
            content.length >= 2 &&
            content.startsWith(' ') &&
            content.endsWith(' ') &&
            /[^ ]/.test(content)
          ) {
            contentStart += 1
            contentEnd -= 1
            content = content.slice(1, -1)
          }
          if (content.length > 0) {
            spans.push({
              text: content,
              range: {
                startLine: line.lineNumber,
                endLine: line.lineNumber,
                startOffset: line.start + contentStart,
                endOffset: line.start + contentEnd
              }
            })
          }
          i = j + closeCount
          foundClose = true
          break
        }
        j += closeCount
      } else {
        j++
      }
    }
    if (!foundClose) {
      i += tickCount
    }
  }
}

function extractInlineFromLine(
  line: RawLine,
  links: ParsedMarkdownLink[],
  inlineCodeSpans: ParsedInlineCodeSpan[]
): void {
  extractInlineLinksFromLine(line, links)
  extractInlineCodeSpansFromLine(line, inlineCodeSpans)
}

function extractInlineLinksFromLine(line: RawLine, links: ParsedMarkdownLink[]): void {
  const masked = maskInlineCode(line.text)
  let i = 0
  while (i < masked.length) {
    const isImage = masked[i] === '!' && masked[i + 1] === '['
    const bracketStart = isImage ? i + 1 : masked[i] === '[' ? i : -1
    if (bracketStart === -1 || (bracketStart > 0 && masked[bracketStart - 1] === '\\')) {
      i++
      continue
    }
    const closeBracket = findClosingBracket(masked, bracketStart)
    if (closeBracket === -1 || masked[closeBracket + 1] !== '(') {
      i = bracketStart + 1
      continue
    }
    const targetInfo = parseLinkDestination(masked, closeBracket + 2)
    if (!targetInfo) {
      i = closeBracket + 1
      continue
    }
    const rawTarget = line.text.slice(targetInfo.targetStart, targetInfo.targetEnd)
    if (rawTarget.length > 0) {
      links.push({
        rawTarget,
        kind: isImage ? 'IMAGE' : 'INLINE',
        range: {
          startLine: line.lineNumber,
          endLine: line.lineNumber,
          startOffset: line.start + targetInfo.targetStart,
          endOffset: line.start + targetInfo.targetEnd
        }
      })
    }
    i = targetInfo.closeParen + 1
  }
}

function findClosingBracket(text: string, openIdx: number): number {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
      continue
    }
    if (text[i] === '[') depth++
    else if (text[i] === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function parseLinkDestination(
  text: string,
  startAfterOpenParen: number
): { targetStart: number; targetEnd: number; closeParen: number } | null {
  let pos = startAfterOpenParen
  while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t')) pos++
  if (pos >= text.length) return null

  let targetStart = pos
  let targetEnd = pos

  if (text[pos] === '<') {
    targetStart = pos + 1
    let closeAngle = targetStart
    while (closeAngle < text.length && text[closeAngle] !== '>' && text[closeAngle] !== '\n') {
      if (text[closeAngle] === '\\') closeAngle += 2
      else closeAngle++
    }
    if (closeAngle >= text.length || text[closeAngle] !== '>') return null
    targetEnd = closeAngle
    pos = closeAngle + 1
  } else {
    let parenDepth = 0
    while (pos < text.length) {
      const ch = text[pos]
      if (ch === '\\') {
        pos += 2
        continue
      }
      if (ch === '(') {
        parenDepth++
        pos++
        continue
      }
      if (ch === ')') {
        if (parenDepth === 0) break
        parenDepth--
        pos++
        continue
      }
      if (ch === ' ' || ch === '\t') break
      pos++
    }
    targetEnd = pos
  }

  while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t')) pos++
  if (pos < text.length && (text[pos] === '"' || text[pos] === "'" || text[pos] === '(')) {
    const quote = text[pos] === '(' ? ')' : text[pos]
    pos++
    while (pos < text.length && text[pos] !== quote) {
      if (text[pos] === '\\') pos += 2
      else pos++
    }
    if (pos >= text.length) return null
    pos++
    while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t')) pos++
  }

  if (text[pos] !== ')') return null
  return { targetStart, targetEnd, closeParen: pos }
}

export function parseMarkdownFile(text: string, options: { isSkillMd: boolean }): ParsedMarkdownFile {
  const bomOffset = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const lines = splitPreservingOffsets(text, bomOffset)
  const lineCount = countLines(text)
  const partialReasons: string[] = []
  let coverage: 'COMPLETE' | 'PARTIAL' = 'COMPLETE'

  let frontmatterRange: LintRange | null = null
  let bodyStartOffset = bomOffset
  let idx = 0

  const blocks: ParsedMarkdownBlock[] = []
  const headings: ParsedMarkdownHeading[] = []
  const links: ParsedMarkdownLink[] = []
  const inlineCodeSpans: ParsedInlineCodeSpan[] = []

  if (options.isSkillMd && lines.length > 0 && lines[0].text.trim() === '---') {
    let closeIdx = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].text.trim() === '---') {
        closeIdx = i
        break
      }
    }
    if (closeIdx >= 1) {
      frontmatterRange = {
        startLine: lines[0].lineNumber,
        endLine: lines[closeIdx].lineNumber,
        startOffset: lines[0].start,
        endOffset: lines[closeIdx].endWithEol
      }
      blocks.push({
        blockIndex: blocks.length,
        type: 'frontmatter',
        range: frontmatterRange,
        rawText: text.slice(frontmatterRange.startOffset, frontmatterRange.endOffset)
      })
      bodyStartOffset = lines[closeIdx].endWithEol
      idx = closeIdx + 1
    }
  }

  let prevWasBlank = true
  while (idx < lines.length) {
    const line = lines[idx]

    if (isBlank(line)) {
      prevWasBlank = true
      idx++
      continue
    }

    const fenceMatch = FENCE_OPEN_RE.exec(line.text)
    if (fenceMatch) {
      const fenceMarker = fenceMatch[1]
      const fenceChar = fenceMarker[0]
      const info = fenceMatch[2]
      if (!(fenceChar === '`' && info.includes('`'))) {
        const startIdx = idx
        idx++
        let closed = false
        while (idx < lines.length) {
          const trimmed = lines[idx].text.trimEnd()
          const closeCheck = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(trimmed)
          if (closeCheck && closeCheck[1][0] === fenceChar && closeCheck[1].length >= fenceMarker.length) {
            closed = true
            break
          }
          idx++
        }
        const endIdx = closed ? idx : lines.length - 1
        if (!closed) {
          coverage = 'PARTIAL'
          partialReasons.push('UNCLOSED_FENCE')
        }
        const range: LintRange = {
          startLine: lines[startIdx].lineNumber,
          endLine: lines[endIdx].lineNumber,
          startOffset: lines[startIdx].start,
          endOffset: lines[endIdx].endWithEol
        }
        blocks.push({
          blockIndex: blocks.length,
          type: 'fenced_code',
          range,
          rawText: text.slice(range.startOffset, range.endOffset)
        })
        idx = endIdx + 1
        prevWasBlank = false
        continue
      }
    }

    if (HTML_START_RE.test(line.text)) {
      const startIdx = idx
      idx++
      while (idx < lines.length && !isBlank(lines[idx])) idx++
      const endIdx = idx - 1
      coverage = 'PARTIAL'
      partialReasons.push('HTML_BLOCK')
      const range: LintRange = {
        startLine: lines[startIdx].lineNumber,
        endLine: lines[endIdx].lineNumber,
        startOffset: lines[startIdx].start,
        endOffset: lines[endIdx].endWithEol
      }
      blocks.push({
        blockIndex: blocks.length,
        type: 'html',
        range,
        rawText: text.slice(range.startOffset, range.endOffset)
      })
      prevWasBlank = false
      continue
    }

    const atxMatch = ATX_HEADING_RE.exec(line.text)
    if (atxMatch) {
      const level = atxMatch[1].length
      const title = cleanAtxTitle(atxMatch[2] ?? '')
      const range: LintRange = {
        startLine: line.lineNumber,
        endLine: line.lineNumber,
        startOffset: line.start,
        endOffset: line.endWithEol
      }
      const headingIndex = headings.length
      const blockIndex = blocks.length
      headings.push({ headingIndex, blockIndex, level, title, range })
      blocks.push({
        blockIndex,
        type: 'heading',
        headingIndex,
        level,
        title,
        range,
        rawText: text.slice(range.startOffset, range.endOffset)
      })
      extractInlineFromLine(line, links, inlineCodeSpans)
      idx++
      prevWasBlank = false
      continue
    }

    if (THEMATIC_BREAK_RE.test(line.text)) {
      idx++
      prevWasBlank = false
      continue
    }

    if (prevWasBlank && INDENTED_CODE_RE.test(line.text)) {
      const startIdx = idx
      let lastCodeIdx = idx
      idx++
      while (idx < lines.length) {
        if (isBlank(lines[idx])) {
          idx++
          continue
        }
        if (INDENTED_CODE_RE.test(lines[idx].text)) {
          lastCodeIdx = idx
          idx++
          continue
        }
        break
      }
      const range: LintRange = {
        startLine: lines[startIdx].lineNumber,
        endLine: lines[lastCodeIdx].lineNumber,
        startOffset: lines[startIdx].start,
        endOffset: lines[lastCodeIdx].endWithEol
      }
      blocks.push({
        blockIndex: blocks.length,
        type: 'indented_code',
        range,
        rawText: text.slice(range.startOffset, range.endOffset)
      })
      idx = lastCodeIdx + 1
      prevWasBlank = false
      continue
    }

    if (BLOCKQUOTE_RE.test(line.text)) {
      const startIdx = idx
      while (idx < lines.length && BLOCKQUOTE_RE.test(lines[idx].text)) {
        extractInlineFromLine(lines[idx], links, inlineCodeSpans)
        idx++
      }
      const endIdx = idx - 1
      const range: LintRange = {
        startLine: lines[startIdx].lineNumber,
        endLine: lines[endIdx].lineNumber,
        startOffset: lines[startIdx].start,
        endOffset: lines[endIdx].endWithEol
      }
      blocks.push({
        blockIndex: blocks.length,
        type: 'blockquote',
        range,
        rawText: text.slice(range.startOffset, range.endOffset)
      })
      prevWasBlank = false
      continue
    }

    if (TABLE_RE.test(line.text)) {
      const startIdx = idx
      while (idx < lines.length && TABLE_RE.test(lines[idx].text)) {
        extractInlineFromLine(lines[idx], links, inlineCodeSpans)
        idx++
      }
      const endIdx = idx - 1
      const range: LintRange = {
        startLine: lines[startIdx].lineNumber,
        endLine: lines[endIdx].lineNumber,
        startOffset: lines[startIdx].start,
        endOffset: lines[endIdx].endWithEol
      }
      blocks.push({
        blockIndex: blocks.length,
        type: 'table',
        range,
        rawText: text.slice(range.startOffset, range.endOffset)
      })
      prevWasBlank = false
      continue
    }

    if (LIST_ITEM_RE.test(line.text)) {
      const startIdx = idx
      let lastListIdx = idx
      extractInlineFromLine(lines[idx], links, inlineCodeSpans)
      idx++
      while (idx < lines.length) {
        if (isBlank(lines[idx])) {
          let look = idx + 1
          while (look < lines.length && isBlank(lines[look])) look++
          if (look < lines.length && (LIST_ITEM_RE.test(lines[look].text) || /^[ ]{2,}\S/.test(lines[look].text))) {
            idx = look
            continue
          }
          break
        }
        if (
          ATX_HEADING_RE.test(lines[idx].text) ||
          FENCE_OPEN_RE.test(lines[idx].text) ||
          HTML_START_RE.test(lines[idx].text) ||
          BLOCKQUOTE_RE.test(lines[idx].text) ||
          THEMATIC_BREAK_RE.test(lines[idx].text)
        ) {
          break
        }
        extractInlineFromLine(lines[idx], links, inlineCodeSpans)
        lastListIdx = idx
        idx++
      }
      const range: LintRange = {
        startLine: lines[startIdx].lineNumber,
        endLine: lines[lastListIdx].lineNumber,
        startOffset: lines[startIdx].start,
        endOffset: lines[lastListIdx].endWithEol
      }
      blocks.push({
        blockIndex: blocks.length,
        type: 'list',
        range,
        rawText: text.slice(range.startOffset, range.endOffset)
      })
      idx = lastListIdx + 1
      prevWasBlank = false
      continue
    }

    const refMatch = REF_DEF_RE.exec(line.text)
    if (refMatch) {
      const rawTarget = refMatch[2] ?? refMatch[3] ?? ''
      if (rawTarget) {
        const targetPos = line.text.indexOf(rawTarget, line.text.indexOf(':'))
        links.push({
          rawTarget,
          kind: 'REFERENCE',
          range: {
            startLine: line.lineNumber,
            endLine: line.lineNumber,
            startOffset: line.start + Math.max(0, targetPos),
            endOffset: line.start + Math.max(0, targetPos) + rawTarget.length
          }
        })
      }
      idx++
      prevWasBlank = false
      continue
    }

    // Paragraph or Setext heading
    const startIdx = idx
    let setextLevel: number | null = null
    while (idx < lines.length) {
      if (idx > startIdx && isBlockInterrupt(lines[idx])) break
      if (idx + 1 < lines.length && SETEXT_RE.test(lines[idx + 1].text) && !THEMATIC_BREAK_RE.test(lines[idx + 1].text)) {
        setextLevel = lines[idx + 1].text.trim()[0] === '=' ? 1 : 2
        idx++
        break
      }
      idx++
    }

    if (setextLevel !== null) {
      const headingEndIdx = idx
      for (let i = startIdx; i < headingEndIdx; i++) extractInlineFromLine(lines[i], links, inlineCodeSpans)
      const title = lines.slice(startIdx, headingEndIdx).map(l => l.text.trim()).join(' ')
      const range: LintRange = {
        startLine: lines[startIdx].lineNumber,
        endLine: lines[headingEndIdx].lineNumber,
        startOffset: lines[startIdx].start,
        endOffset: lines[headingEndIdx].endWithEol
      }
      const headingIndex = headings.length
      const blockIndex = blocks.length
      headings.push({ headingIndex, blockIndex, level: setextLevel, title, range })
      blocks.push({
        blockIndex,
        type: 'heading',
        headingIndex,
        level: setextLevel,
        title,
        range,
        rawText: text.slice(range.startOffset, range.endOffset)
      })
      idx = headingEndIdx + 1
      prevWasBlank = false
      continue
    }

    const endIdx = idx - 1
    for (let i = startIdx; i <= endIdx; i++) extractInlineFromLine(lines[i], links, inlineCodeSpans)
    const range: LintRange = {
      startLine: lines[startIdx].lineNumber,
      endLine: lines[endIdx].lineNumber,
      startOffset: lines[startIdx].start,
      endOffset: lines[endIdx].endWithEol
    }
    blocks.push({
      blockIndex: blocks.length,
      type: 'paragraph',
      range,
      rawText: text.slice(range.startOffset, range.endOffset)
    })
    prevWasBlank = false
  }

  const hasNavigationIndex =
    headings.some(h => h.range.startLine <= 50 && INDEX_HEADING_RE.test(h.title.trim())) ||
    links.filter(l => l.range.startLine <= 50 && l.rawTarget.startsWith('#')).length >= 3

  return {
    coverage,
    partialReasons: [...new Set(partialReasons)],
    lineCount,
    frontmatterRange,
    bodyStartOffset,
    hasNavigationIndex,
    headings,
    blocks,
    links,
    inlineCodeSpans
  }
}
