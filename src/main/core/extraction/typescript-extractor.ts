/*
-T ---
*/

import { getLanguageForExtension } from '../language-adapter'
import { readStructure } from '../structure-reader'
import type { StructureExtractionPort, StructureExtractionInput, StructureExtractionResult } from './structure-extraction-port'

export class TypeScriptStructureExtractor implements StructureExtractionPort {
  supports(extension: string): boolean {
    const lang = getLanguageForExtension(extension)
    return lang === 'typescript' || lang === 'typescript-react'
  }

  extract(input: StructureExtractionInput): StructureExtractionResult {
    return readStructure(input.repositoryId, input.relativePath, input.extension, input.content)
  }
}
