import { createHash } from 'crypto'
import { posix } from 'path'
import type { StructureExtractionInput, StructureExtractionResult } from './structure-extraction-port'

export function extractTextDocument({ repositoryId, relativePath, content }: StructureExtractionInput): StructureExtractionResult {
  const name = posix.basename(relativePath)
  const sizeBytes = Buffer.byteLength(content, 'utf-8')
  const lines = content.split('\n')
  return {
    elements: [{
      id: createHash('sha256').update(`${repositoryId}:${relativePath}:document:${name}:::0`).digest('hex').substring(0, 16),
      repositoryId,
      fileId: relativePath,
      kind: 'document',
      name,
      parentElementId: null,
      location: {
        start: { byte: 0, line: 1, column: 0 },
        end: { byte: sizeBytes, line: lines.length, column: lines[lines.length - 1].length }
      },
      sizeLines: lines.length - 1,
      sizeBytes,
      visibility: null,
      modifiers: [],
      returnType: null,
      baseClass: null,
      hasDocumentation: false,
      parameterCount: 0,
      retrievalKind: 'A',
      granularity: 'structural',
      retrievable: true
    }],
    relationships: [],
    elementInterfaces: [],
    importBindings: [],
    exportedConstNewBindings: [],
    exportedConstCallBindings: [],
    symbolReferences: []
  }
}
