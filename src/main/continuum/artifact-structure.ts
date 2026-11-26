// @ts-expect-error Electron Vite bundles this ESM dependency into the CommonJS main entry.
import { fromMarkdown } from 'mdast-util-from-markdown'
// @ts-expect-error Electron Vite bundles this ESM dependency into the CommonJS main entry.
import { gfm } from 'micromark-extension-gfm'
// @ts-expect-error Electron Vite bundles this ESM dependency into the CommonJS main entry.
import { gfmFromMarkdown } from 'mdast-util-gfm'
// @ts-expect-error Electron Vite bundles this ESM dependency into the CommonJS main entry.
import { toString } from 'mdast-util-to-string'
import { parseArtifactMarkdown } from './artifact-metadata'

export const STRUCTURE_VERSION = 2
export interface LiteralRange { start: number; end: number; startLine: number; endLine: number }
export interface OutlineSection extends LiteralRange {
  title: string; level: number; parent: number | null; ownEnd: number; hasChildren: boolean
}
export interface StructureQuery { artifactId: string; limit?: number; cursor?: string; sectionId?: string; includeBlocks?: boolean; includeRawMarkdownTokenCount?: boolean }
export interface SectionQuery { artifactId: string; sectionId: string; expectedRevision: number; includeDescendants?: boolean; blockId?: string; cursor?: string }
export interface StructureSection extends LiteralRange { sectionId: string; title: string; level: number; parentSectionId: string | null; hasChildren: boolean }
export interface StructureBlock extends LiteralRange { blockId: string; type: string }
export interface StructurePage { artifactId: string; revision: number; contentHash: string; sections?: StructureSection[]; blocks?: StructureBlock[]; nextCursor?: string; rawMarkdownTokenCount?: number; tokenizerId?: string; tokenizerEncoding?: string }
export interface SectionPage extends LiteralRange { artifactId: string; sectionId: string; blockId?: string; revision: number; contentHash: string; content: string; nextCursor?: string }

export function literalRange(raw: string, start: number, end: number): LiteralRange {
  return rangeLocator(raw)(start, end)
}
export function pageRange(raw: string, start: number, end: number, startLine: number): LiteralRange {
  let endLine = startLine
  for (let offset = start; offset < end; offset++) {
    if (raw[offset] === '\n' || raw[offset] === '\r' && raw[offset + 1] !== '\n') endLine++
  }
  return { start, end, startLine, endLine }
}
function rangeLocator(raw: string) {
  const starts = [0]
  for (const match of raw.matchAll(/\r\n|\n|\r/g)) starts.push(match.index! + match[0].length)
  const line = (offset: number) => {
    let low = 0, high = starts.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (starts[middle] <= offset) low = middle + 1
      else high = middle
    }
    return low
  }
  return (start: number, end: number): LiteralRange => ({ start, end, startLine: line(start), endLine: line(end) })
}
export function structuralBody(raw: string): string {
  try { return parseArtifactMarkdown(raw, true).body } catch { return raw }
}
export function parseStructure(raw: string) {
  const body = structuralBody(raw)
  const offset = raw.length - body.length
  const tree = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  return { offset, nodes: tree.children }
}
export function extractOutline(raw: string): OutlineSection[] {
  return outlineFromStructure(raw, parseStructure(raw))
}

function outlineFromStructure(raw: string, { offset, nodes }: ReturnType<typeof parseStructure>): OutlineSection[] {
  const range = rangeLocator(raw)
  const headings = nodes.filter(node => node.type === 'heading')
  const sections: OutlineSection[] = []
  if (!headings.length || raw.slice(offset, offset + headings[0].position!.start.offset!).trim()) {
    const end = headings.length ? offset + headings[0].position!.start.offset! : raw.length
    sections.push({ ...range(offset, end), title: headings.length ? 'Preamble' : 'Document content', level: 0, parent: null, ownEnd: end, hasChildren: false })
  }
  const stack: number[] = []
  for (const heading of headings) {
    const start = offset + heading.position!.start.offset!
    while (stack.length && sections[stack[stack.length - 1]].level >= heading.depth) {
      sections[stack.pop()!].end = start
    }
    const parent = stack.length ? stack[stack.length - 1] : null
    if (parent !== null) {
      if (!sections[parent].hasChildren) sections[parent].ownEnd = start
      sections[parent].hasChildren = true
    }
    sections.push({ ...range(start, raw.length), title: toString(heading).slice(0, 512), level: heading.depth, parent, ownEnd: raw.length, hasChildren: false })
    stack.push(sections.length - 1)
  }
  for (const section of sections) {
    section.ownEnd = Math.min(section.ownEnd, section.end)
    Object.assign(section, range(section.start, section.end))
  }
  return sections
}
export function extractBlocks(raw: string, section: OutlineSection): (LiteralRange & { type: string })[] {
  const { offset, nodes } = parseStructure(raw)
  const range = rangeLocator(raw)
  return nodes.filter(node => node.type !== 'heading' && offset + node.position!.start.offset! >= section.start && offset + node.position!.end.offset! <= section.ownEnd)
    .map(node => ({ ...range(offset + node.position!.start.offset!, offset + node.position!.end.offset!), type: node.type }))
}

export function extractSearchUnits(raw: string) {
  const parsed = parseStructure(raw)
  const sections = outlineFromStructure(raw, parsed)
  const units: Array<{ field: 'headings' | 'body'; section: number; block?: number; type: string; text: string }> = []
  let sectionIndex = 0
  let blockIndex = 0
  for (const node of parsed.nodes) {
    const start = parsed.offset + node.position!.start.offset!
    const end = parsed.offset + node.position!.end.offset!
    while (sectionIndex + 1 < sections.length && sections[sectionIndex + 1].start <= start) {
      sectionIndex++
      blockIndex = 0
    }
    const text = raw.slice(start, end)
    if (node.type === 'heading') {
      units.push({ field: 'headings', section: sectionIndex, type: node.type, text })
    } else {
      units.push({ field: 'body', section: sectionIndex, block: blockIndex++, type: node.type, text })
    }
  }
  return { sections, units }
}
