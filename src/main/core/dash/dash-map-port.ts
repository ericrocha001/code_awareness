import type { CodeMapService } from '../code-map-service'

export type DashMapPort = Pick<
  CodeMapService,
  | 'awaitReadiness'
  | 'getFiles'
  | 'getElements'
  | 'getRelationships'
  | 'getSymbolReferencesBySourceElement'
  | 'getSymbolReferencesByTargetElement'
  | 'getElementExactSources'
  | 'getFileContent'
>
