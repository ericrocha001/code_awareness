import type { InspectFilesOptions, RelationshipOptions, SymbolHierarchyOptions } from '../../../shared/types/context-navigation-types'
import type { ContextNavigationPort, NavigationInvocationContext } from './context-navigation-port'

export interface ProjectContextNavigation {
  discoverRepository(relativePaths?: string[], context?: NavigationInvocationContext): ReturnType<ContextNavigationPort['discoverRepository']>
  getRelationships(relativePaths: string[], options?: RelationshipOptions, context?: NavigationInvocationContext): ReturnType<ContextNavigationPort['getRelationships']>
  inspectFiles(relativePaths: string[], options?: InspectFilesOptions, context?: NavigationInvocationContext): ReturnType<ContextNavigationPort['inspectFiles']>
  getReferences(targetIds: string[], context?: NavigationInvocationContext): ReturnType<ContextNavigationPort['getReferences']>
  getSymbolDependencies(sourceTargetIds: string[], context?: NavigationInvocationContext): ReturnType<ContextNavigationPort['getSymbolDependencies']>
  getSymbolHierarchy(targetIds: string[], options?: SymbolHierarchyOptions, context?: NavigationInvocationContext): ReturnType<ContextNavigationPort['getSymbolHierarchy']>
  readCode(targetIds: string[], context?: NavigationInvocationContext): ReturnType<ContextNavigationPort['readCode']>
}

export function bindProjectNavigation(navigation: ContextNavigationPort, repoPath: string): ProjectContextNavigation {
  return {
    discoverRepository: (relativePaths, context) =>
      context !== undefined
        ? navigation.discoverRepository(repoPath, relativePaths, context)
        : navigation.discoverRepository(repoPath, relativePaths),
    getRelationships: (relativePaths, options, context) =>
      context !== undefined
        ? navigation.getRelationships(repoPath, relativePaths, options, context)
        : navigation.getRelationships(repoPath, relativePaths, options),
    inspectFiles: (relativePaths, options, context) =>
      context !== undefined
        ? navigation.inspectFiles(repoPath, relativePaths, options, context)
        : navigation.inspectFiles(repoPath, relativePaths, options),
    getReferences: (targetIds, context) =>
      context !== undefined
        ? navigation.getReferences(repoPath, targetIds, context)
        : navigation.getReferences(repoPath, targetIds),
    getSymbolDependencies: (sourceTargetIds, context) =>
      context !== undefined
        ? navigation.getSymbolDependencies(repoPath, sourceTargetIds, context)
        : navigation.getSymbolDependencies(repoPath, sourceTargetIds),
    getSymbolHierarchy: (targetIds, options, context) =>
      context !== undefined
        ? navigation.getSymbolHierarchy(repoPath, targetIds, options, context)
        : navigation.getSymbolHierarchy(repoPath, targetIds, options),
    readCode: (targetIds, context) =>
      context !== undefined
        ? navigation.readCode(repoPath, targetIds, context)
        : navigation.readCode(repoPath, targetIds)
  }
}

