import type { CodeMapElement, CodeMapFile, CodeMapRelationship } from '../../../shared/types'
import type {
  DiscoverRepositoryResult,
  InspectFilesResult,
  InspectFilesOptions,
  GetRelationshipsResult,
  RelationshipOptions,
  ReadCodeResult,
  GetReferencesResult,
  GetSymbolDependenciesResult,
  GetSymbolHierarchyResult,
  SymbolHierarchyOptions
} from '../../../shared/types/context-navigation-types'
import type { ExactElementSource } from '../repository-model'
import type { PersistedSymbolReference } from '../symbol-reference-resolver'
import type { CodeMapDiscoveryPort } from './repo-discovery'

export interface NavigationInvocationContext {
  deadlineAtMs?: number
  requestId?: string
  sessionId?: string
  trace?: import('../../mcp/code-scope-health').CodeScopeTraceSink
}

export interface ContextNavigationPort {
  discoverRepository(repoPath: string, relativePaths?: string[], context?: NavigationInvocationContext): Promise<DiscoverRepositoryResult>
  getRelationships(repoPath: string, relativePaths: string[], options?: RelationshipOptions, context?: NavigationInvocationContext): Promise<GetRelationshipsResult>
  inspectFiles(repoPath: string, relativePaths: string[], options?: InspectFilesOptions, context?: NavigationInvocationContext): Promise<InspectFilesResult>
  getReferences(repoPath: string, targetIds: string[], context?: NavigationInvocationContext): Promise<GetReferencesResult>
  getSymbolDependencies(repoPath: string, sourceTargetIds: string[], context?: NavigationInvocationContext): Promise<GetSymbolDependenciesResult>
  getSymbolHierarchy(repoPath: string, targetIds: string[], options?: SymbolHierarchyOptions, context?: NavigationInvocationContext): Promise<GetSymbolHierarchyResult>
  readCode(repoPath: string, targetIds: string[], context?: NavigationInvocationContext): Promise<ReadCodeResult[]>
}

export interface CodeMapNavigationPort extends CodeMapDiscoveryPort {
  awaitReadiness?(repoPath: string, capability: 'FILE_INVENTORY' | 'STRUCTURE' | 'RELATIONSHIPS' | 'SYMBOL_REFERENCES'): Promise<void>
  getFiles(repoPath: string): CodeMapFile[]
  getElements(repoPath: string): CodeMapElement[]
  getSymbolReferencesByTargetElement(repoPath: string, targetElementId: string): PersistedSymbolReference[]
  getSymbolReferencesBySourceElement(repoPath: string, sourceElementId: string): PersistedSymbolReference[]
  getHierarchyRelationshipsBySourceElement(repoPath: string, elementId: string): CodeMapRelationship[]
  getHierarchyRelationshipsByTargetElement(repoPath: string, elementId: string): CodeMapRelationship[]
  getElementExactSources(repoPath: string, elementIds: string[]): Promise<Map<string, ExactElementSource>>
}
