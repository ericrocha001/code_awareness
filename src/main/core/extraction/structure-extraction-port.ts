/*
-T ---
*/

import type { CodeMapElement, CodeMapRelationship } from '../../../shared/types'

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
}

export interface StructureExtractionPort {
  /** Retorna true se a porta é capaz de extrair estrutura de arquivos com a extensão fornecida. */
  supports(extension: string): boolean
  /** Executa a extração e retorna os elementos, relacionamentos e interfaces do arquivo. */
  extract(input: StructureExtractionInput): StructureExtractionResult
}
