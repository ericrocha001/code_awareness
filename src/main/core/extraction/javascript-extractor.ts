/*
-T ---
*/

import { getLanguageForExtension } from '../language-adapter'
import { readStructure } from '../structure-reader'
import type {
  StructureExtractionPort,
  StructureExtractionInput,
  StructureExtractionResult
} from './structure-extraction-port'

export class JavaScriptStructureExtractor implements StructureExtractionPort {
  supports(extension: string): boolean {
    const lang = getLanguageForExtension(extension)
    return lang === 'javascript' || lang === 'javascript-react'
  }

  extract(input: StructureExtractionInput): StructureExtractionResult {
    try {
      return readStructure(input.repositoryId, input.relativePath, input.extension, input.content)
    } catch (err) {
      console.warn(`[JavaScriptStructureExtractor] Falha ao extrair estrutura de "${input.relativePath}":`, err)
      return { elements: [], relationships: [], elementInterfaces: [] }
    }
  }
}
