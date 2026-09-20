import { createHash } from 'crypto'
import type { CodeMapElement, CodeMapRelationship } from '../../../shared/types'
import { extractTextDocument } from './text-document-extractor'
import type {
  StructureExtractionInput,
  StructureExtractionPort,
  StructureExtractionResult
} from './structure-extraction-port'

interface JsonPropertyRange {
  name: string
  start: number
  end: number
}

class JsonScanner {
  private index = 0
  private readonly properties: JsonPropertyRange[] = []

  constructor(private readonly content: string) {}

  scan(): JsonPropertyRange[] {
    if (this.content.charCodeAt(0) === 0xfeff) this.index++
    this.skipWhitespace()
    if (this.content[this.index] === '{') this.parseObject(true)
    else this.parseValue()
    this.skipWhitespace()
    if (this.index !== this.content.length) this.fail()
    return this.properties
  }

  private parseValue(): void {
    const token = this.content[this.index]
    if (token === '{') this.parseObject(false)
    else if (token === '[') this.parseArray()
    else if (token === '"') this.parseString()
    else if (token === 't') this.parseLiteral('true')
    else if (token === 'f') this.parseLiteral('false')
    else if (token === 'n') this.parseLiteral('null')
    else if (token === '-' || (token >= '0' && token <= '9')) this.parseNumber()
    else this.fail()
  }

  private parseObject(captureProperties: boolean): void {
    this.index++
    this.skipWhitespace()
    if (this.content[this.index] === '}') {
      this.index++
      return
    }
    while (this.index < this.content.length) {
      if (this.content[this.index] !== '"') this.fail()
      const propertyStart = this.index
      const name = this.parseString()
      this.skipWhitespace()
      if (this.content[this.index] !== ':') this.fail()
      this.index++
      this.skipWhitespace()
      this.parseValue()
      if (captureProperties) this.properties.push({ name, start: propertyStart, end: this.index })
      this.skipWhitespace()
      if (this.content[this.index] === '}') {
        this.index++
        return
      }
      if (this.content[this.index] !== ',') this.fail()
      this.index++
      this.skipWhitespace()
    }
    this.fail()
  }

  private parseArray(): void {
    this.index++
    this.skipWhitespace()
    if (this.content[this.index] === ']') {
      this.index++
      return
    }
    while (this.index < this.content.length) {
      this.parseValue()
      this.skipWhitespace()
      if (this.content[this.index] === ']') {
        this.index++
        return
      }
      if (this.content[this.index] !== ',') this.fail()
      this.index++
      this.skipWhitespace()
    }
    this.fail()
  }

  private parseString(): string {
    const start = this.index
    this.index++
    while (this.index < this.content.length) {
      const code = this.content.charCodeAt(this.index)
      if (code === 0x22) {
        this.index++
        return JSON.parse(this.content.slice(start, this.index)) as string
      }
      if (code < 0x20) this.fail()
      if (code === 0x5c) {
        this.index++
        const escape = this.content[this.index]
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(this.content.slice(this.index + 1, this.index + 5))) this.fail()
          this.index += 5
          continue
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) this.fail()
      }
      this.index++
    }
    this.fail()
  }

  private parseNumber(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.content.slice(this.index))
    if (!match) this.fail()
    this.index += match[0].length
  }

  private parseLiteral(literal: string): void {
    if (!this.content.startsWith(literal, this.index)) this.fail()
    this.index += literal.length
  }

  private skipWhitespace(): void {
    while (' \t\r\n'.includes(this.content[this.index] ?? '\0')) this.index++
  }

  private fail(): never {
    throw new SyntaxError(`Invalid JSON at character ${this.index}`)
  }
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

function extractJsonStructure(input: StructureExtractionInput): StructureExtractionResult {
  let ranges: JsonPropertyRange[]
  try {
    ranges = new JsonScanner(input.content).scan()
  } catch {
    return extractTextDocument(input)
  }

  const document = extractTextDocument(input).elements[0]
  const twins = new Map<string, number>()
  const locations = locationsAt(input.content, ranges.flatMap((range) => [range.start, range.end]))
  const sections: CodeMapElement[] = ranges.map((range) => {
    const twinIndex = twins.get(range.name) ?? 0
    twins.set(range.name, twinIndex + 1)
    const start = locations.get(range.start)!
    const end = locations.get(range.end)!
    return {
      id: elementId(input, range.name, document.id, twinIndex),
      repositoryId: input.repositoryId,
      fileId: input.relativePath,
      kind: 'section',
      name: range.name,
      parentElementId: document.id,
      location: {
        start,
        end
      },
      sizeLines: end.line - start.line,
      sizeBytes: end.byte - start.byte,
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
  })
  const relationships: CodeMapRelationship[] = sections.map((section) => ({
    id: relationshipId(document.id, section.id),
    repositoryId: input.repositoryId,
    sourceId: document.id,
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

export class JsonStructureExtractor implements StructureExtractionPort {
  supports(extension: string): boolean {
    return extension.toLowerCase() === '.json'
  }

  extract(input: StructureExtractionInput): StructureExtractionResult {
    return extractJsonStructure(input)
  }
}
