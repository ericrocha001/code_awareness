import { createHash } from 'crypto'
import type { CodeMapElement, CodeMapRelationship } from '../../../shared/types'
import { extractTextDocument } from './text-document-extractor'
import type {
  StructureExtractionInput,
  StructureExtractionPort,
  StructureExtractionResult
} from './structure-extraction-port'

interface MarkdownLine {
  start: number
  text: string
}

interface MarkdownHeading {
  level: number
  name: string
  start: number
}

interface OpenSection {
  level: number
  element: CodeMapElement
}

function linesOf(content: string): MarkdownLine[] {
  const lines: MarkdownLine[] = []
  let start = 0
  for (let index = 0; index <= content.length; index++) {
    if (index !== content.length && content[index] !== '\n') continue
    const end = index > start && content[index - 1] === '\r' ? index - 1 : index
    lines.push({ start, text: content.slice(start, end) })
    start = index + 1
  }
  return lines
}

function frontmatterEnd(lines: MarkdownLine[]): number {
  if ((lines[0]?.text.replace(/^\uFEFF/, '') ?? '') !== '---') return -1
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].text === '---' || lines[index].text === '...') return index
  }
  return -1
}

function fenceMarker(line: string): { marker: '`' | '~'; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return null
  const marker = match[1][0] as '`' | '~'
  if (marker === '`' && match[2].includes('`')) return null
  return { marker, length: match[1].length }
}

function closesFence(line: string, fence: { marker: '`' | '~'; length: number }): boolean {
  const expression = fence.marker === '`' ? /^ {0,3}(`{3,})[ \t]*$/ : /^ {0,3}(~{3,})[ \t]*$/
  const match = expression.exec(line)
  return Boolean(match && match[1].length >= fence.length)
}

function atxHeading(line: string): { level: number; name: string } | null {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line)
  if (!match) return null
  let name = match[2] ?? ''
  name = name.replace(/[ \t]+#+[ \t]*$/, '').trim()
  return { level: match[1].length, name }
}

function headingsOf(content: string): MarkdownHeading[] {
  const lines = linesOf(content)
  const yamlEnd = frontmatterEnd(lines)
  const headings: MarkdownHeading[] = []
  let fence: { marker: '`' | '~'; length: number } | null = null
  for (let index = 0; index < lines.length; index++) {
    if (yamlEnd >= 0 && index <= yamlEnd) continue
    const line = lines[index]
    const text = index === 0 ? line.text.replace(/^\uFEFF/, '') : line.text
    if (fence) {
      if (closesFence(text, fence)) fence = null
      continue
    }
    const openingFence = fenceMarker(text)
    if (openingFence) {
      fence = openingFence
      continue
    }
    const heading = atxHeading(text)
    if (heading) headings.push({ ...heading, start: line.start })
  }
  return headings
}

function locationsAt(content: string, indices: number[]): Map<number, { line: number; column: number; byte: number }> {
  const locations = new Map<number, { line: number; column: number; byte: number }>()
  const sorted = [...new Set(indices)].sort((left, right) => left - right)
  let previousIndex = 0
  let byte = 0
  let line = 1
  let lastLineBreak = -1
  for (const index of sorted) {
    for (let cursor = previousIndex; cursor < index; cursor++) {
      if (content[cursor] === '\n') {
        line++
        lastLineBreak = cursor
      }
    }
    byte += Buffer.byteLength(content.slice(previousIndex, index), 'utf-8')
    locations.set(index, { line, column: index - lastLineBreak - 1, byte })
    previousIndex = index
  }
  return locations
}

function elementId(input: StructureExtractionInput, name: string, parentElementId: string, twinIndex: number): string {
  return createHash('sha256')
    .update(`${input.repositoryId}:${input.relativePath}:section:${name}:${parentElementId}::${twinIndex}`)
    .digest('hex')
    .substring(0, 16)
}

function relationshipId(sourceId: string, targetId: string): string {
  return createHash('sha256').update(`${sourceId}:${targetId}:contains`).digest('hex').substring(0, 16)
}

function extractMarkdownStructure(input: StructureExtractionInput): StructureExtractionResult {
  const document = extractTextDocument(input).elements[0]
  const headings = headingsOf(input.content)
  const twins = new Map<string, number>()
  const open: OpenSection[] = []
  const sections: CodeMapElement[] = []

  for (const heading of headings) {
    while (open.length && open[open.length - 1].level >= heading.level) {
      open.pop()!.element.location.end.byte = heading.start
    }
    if (!heading.name) continue
    const parentElementId = open[open.length - 1]?.element.id ?? document.id
    const twinKey = `${parentElementId}:${heading.name}`
    const twinIndex = twins.get(twinKey) ?? 0
    twins.set(twinKey, twinIndex + 1)
    const element: CodeMapElement = {
      id: elementId(input, heading.name, parentElementId, twinIndex),
      repositoryId: input.repositoryId,
      fileId: input.relativePath,
      kind: 'section',
      name: heading.name,
      parentElementId,
      location: {
        start: { line: 0, column: 0, byte: heading.start },
        end: { line: 0, column: 0, byte: input.content.length }
      },
      sizeLines: 0,
      sizeBytes: 0,
      visibility: null,
      modifiers: [],
      returnType: null,
      baseClass: null,
      hasDocumentation: false,
      parameterCount: 0,
      retrievalKind: 'A',
      granularity: 'structural',
      retrievable: true
    }
    sections.push(element)
    open.push({ level: heading.level, element })
  }

  const characterRanges = sections.flatMap((section) => [section.location.start.byte, section.location.end.byte])
  const locations = locationsAt(input.content, characterRanges)
  for (const section of sections) {
    const start = locations.get(section.location.start.byte)!
    const end = locations.get(section.location.end.byte)!
    section.location = { start, end }
    section.sizeLines = end.line - start.line
    section.sizeBytes = end.byte - start.byte
  }

  const relationships: CodeMapRelationship[] = sections.map((section) => ({
    id: relationshipId(section.parentElementId!, section.id),
    repositoryId: input.repositoryId,
    sourceId: section.parentElementId!,
    targetId: section.id,
    type: 'contains',
    sourceKind: 'element',
    targetKind: 'element'
  }))
  return {
    elements: [document, ...sections],
    relationships,
    elementInterfaces: [],
    importBindings: [],
    exportedConstNewBindings: [],
    exportedConstCallBindings: [],
    symbolReferences: []
  }
}

export class MarkdownStructureExtractor implements StructureExtractionPort {
  supports(extension: string): boolean {
    return ['.md', '.markdown'].includes(extension.toLowerCase())
  }

  extract(input: StructureExtractionInput): StructureExtractionResult {
    return extractMarkdownStructure(input)
  }
}
