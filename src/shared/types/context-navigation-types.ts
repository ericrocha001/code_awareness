export interface DiscoverRepositoryResult {
  directories: Array<{ relativePath: string; children: string[] }>
}
export type RelationshipDirection = 'in' | 'out' | 'both'
export interface RelationshipOptions {
  direction?: RelationshipDirection
  details?: boolean
}
export interface FileRelationship {
  relativePath: string
  type?: 'imports'
}
export interface GetRelationshipsResult {
  files: Array<{ relativePath: string; out?: FileRelationship[]; in?: FileRelationship[] }>
}
export interface InspectFilesOptions {
  signatures?: boolean
}
export interface FileOutlineElement {
  kind: 'class' | 'function' | 'method' | 'interface' | 'enum' | 'typeAlias' | 'constant' | 'document' | 'section'
  name: string
  target?: string
  signature?: string
  children?: FileOutlineElement[]
}
export interface InspectFilesResult {
  files: Array<{ relativePath: string; elements: FileOutlineElement[] }>
}
export interface ReadCodeResult {
  targetId: string
  relativePath: string
  source: string
}
export type SymbolReferenceKind = 'reference' | 'call' | 'instantiation' | 'type'
export interface SymbolReferenceLocation {
  relativePath: string
  kind: SymbolReferenceKind
  line: number
  sourceTarget?: string
}
export interface GetReferencesResult {
  targets: Array<{ target: string; references: SymbolReferenceLocation[] }>
}
export interface SymbolDependencyLocation {
  target: string
  kind: SymbolReferenceKind
  relativePath: string
}
export interface GetSymbolDependenciesResult {
  sources: Array<{ source: string; dependencies: SymbolDependencyLocation[] }>
}
export type SymbolHierarchyDirection = 'up' | 'down' | 'both'
export interface SymbolHierarchyOptions {
  direction?: SymbolHierarchyDirection
}
export type SymbolHierarchyKind = 'extends' | 'implements'
export interface SymbolHierarchyRelation {
  kind: SymbolHierarchyKind
  target: string
  relativePath: string
}
export interface GetSymbolHierarchyResult {
  targets: Array<{
    target: string
    up?: SymbolHierarchyRelation[]
    down?: SymbolHierarchyRelation[]
  }>
}
export type ContextNavigationErrorCode =
  | 'EMPTY_SCOPE'
  | 'DUPLICATE_PATH'
  | 'INVALID_PATH'
  | 'UNKNOWN_DIRECTORY'
  | 'UNKNOWN_FILE'
  | 'INVALID_ARGUMENT'
  | 'EMPTY_TARGETS'
  | 'DUPLICATE_TARGET'
  | 'INVALID_TARGET'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_RETRIEVABLE'
  | 'EXACT_SOURCE_UNAVAILABLE'

export class ContextNavigationError extends Error {
  readonly name = 'ContextNavigationError'
  constructor(
    readonly code: ContextNavigationErrorCode,
    message: string,
    readonly reference?: string
  ) {
    super(message)
  }
}
