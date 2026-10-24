import type { StructureExtractionResult } from './extraction/structure-extraction-port'

export interface SymbolResolutionFacts {
  fileId: string
  contentHash: string
  fileImportTargets?: string[]
  importBindings: StructureExtractionResult['importBindings']
  exportedConstNewBindings: StructureExtractionResult['exportedConstNewBindings']
  exportedConstCallBindings: StructureExtractionResult['exportedConstCallBindings']
  symbolReferenceCandidates: StructureExtractionResult['symbolReferences']
}

export function symbolResolutionFacts(fileId: string, contentHash: string, extraction: StructureExtractionResult): SymbolResolutionFacts {
  return {
    fileId, contentHash,
    fileImportTargets: extraction.relationships.filter(relationship => relationship.type === 'imports' && relationship.sourceKind === 'file' && relationship.targetKind === 'file').map(relationship => relationship.targetId),
    importBindings: extraction.importBindings,
    exportedConstNewBindings: extraction.exportedConstNewBindings,
    exportedConstCallBindings: extraction.exportedConstCallBindings,
    symbolReferenceCandidates: extraction.symbolReferences
  }
}
