/*
-T ---
*/

import type { CodeMapElement, CodeMapElementLocation, CodeMapRelationship } from '../../../shared/types'

export interface ImportBinding {
  sourceModule: string
  importedName: string
  localName: string
  location: CodeMapElementLocation
}

export interface ExportedConstNewBinding {
  declarationElementId: string
  exportedName: string
  constructorName: string
}

export interface ExportedConstCallBinding {
  declarationElementId: string
  exportedName: string
  calleeKind: 'identifier' | 'member'
  calleeName: string
  calleeReceiverName?: string
}

export type SymbolReferenceKind = 'reference' | 'call' | 'instantiation' | 'type'

export interface SymbolReferenceCandidate {
  name: string
  kind: SymbolReferenceKind
  location: CodeMapElementLocation
  sourceElementId: string | null
  receiver?: 'this' | 'identifier' | 'this-property'
  receiverName?: string
  receiverPropertyName?: string
  receiverPropertyOrigin?: 'class-property' | 'constructor-parameter-property'
  receiverTypeName?: string
  receiverBindingKind?: 'parameter' | 'const-new'
  optional?: boolean
}

export interface StructureExtractionInput {
  repositoryId: string
  relativePath: string
  extension: string
  content: string
}

export interface StructureExtractionResult {
  elements: CodeMapElement[]
  relationships: CodeMapRelationship[]
  elementInterfaces: Array<{ elementId: string; interfaceNames: string[] }>
  importBindings: ImportBinding[]
  exportedConstNewBindings: ExportedConstNewBinding[]
  exportedConstCallBindings: ExportedConstCallBinding[]
  symbolReferences: SymbolReferenceCandidate[]
}

export interface StructureExtractionPort {
  /** Retorna true se a porta é capaz de extrair estrutura de arquivos com a extensão fornecida. */
  supports(extension: string): boolean
  /** Executa a extração e retorna os elementos, relacionamentos e interfaces do arquivo. */
  extract(input: StructureExtractionInput): StructureExtractionResult
}
