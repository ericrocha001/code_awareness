import type { CodeMapElement, CodeMapFile } from '../../../shared/types'
import { projectFileOutline } from './file-outline'
import { projectFileRelationships } from './file-relationships'
import type { RepoDiscoveryLayer, RepoDiscoveryResult } from '../../../shared/types/repo-discovery-types'
import {
  ContextNavigationError,
  type DiscoverRepositoryResult,
  type InspectFilesResult,
  type InspectFilesOptions,
  type GetRelationshipsResult,
  type RelationshipOptions,
  type ReadCodeResult,
  type FileRelationship,
  type GetReferencesResult,
  type GetSymbolDependenciesResult,
  type SymbolDependencyLocation,
  type GetSymbolHierarchyResult,
  type SymbolHierarchyOptions,
  type SymbolHierarchyRelation
} from '../../../shared/types/context-navigation-types'
import { createFullTargetId, parseCodeTargetId, projectFullTarget } from './code-target'
import type { CodeMapNavigationPort, ContextNavigationPort, NavigationInvocationContext } from './context-navigation-port'
import { RepoDiscovery } from './repo-discovery'

function emitTrace(
  context: NavigationInvocationContext | undefined,
  stage: import('../../mcp/code-scope-health').CodeScopeTraceStage,
  status: 'started' | 'success' | 'error',
  options?: { tool?: string; error?: string; durationMs?: number; capability?: string }
): void {
  if (!context?.trace || !context.requestId) return
  context.trace.record({
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    sessionId: context.sessionId ?? 'local',
    method: 'tools/call',
    tool: options?.tool ?? 'discover_repository',
    stage,
    durationMs: options?.durationMs ?? 0,
    status,
    ...(options?.error ? { error: options.error } : {}),
    ...(options?.capability ? { capability: options.capability } : {})
  })
}

function requireNonEmptyUnique(values: string[], emptyCode: 'EMPTY_SCOPE' | 'EMPTY_TARGETS', duplicateCode: 'DUPLICATE_PATH' | 'DUPLICATE_TARGET'): void {
  if (values.length === 0) {
    throw new ContextNavigationError(emptyCode, 'At least one reference is required')
  }
  const duplicate = values.find((value, index) => values.indexOf(value) !== index)
  if (duplicate !== undefined) {
    throw new ContextNavigationError(duplicateCode, `Duplicate reference: ${duplicate}`, duplicate)
  }
}

export class ContextEngine implements ContextNavigationPort {
  private readonly repoDiscovery: RepoDiscovery

  constructor(private readonly codeMap: CodeMapNavigationPort) {
    this.repoDiscovery = new RepoDiscovery(codeMap)
  }

  discover(repoPath: string, layer: RepoDiscoveryLayer): Promise<RepoDiscoveryResult> {
    return this.repoDiscovery.generate(repoPath, layer)
  }

  async discoverRepository(repoPath: string, relativePaths: string[] = ['.'], context?: NavigationInvocationContext): Promise<DiscoverRepositoryResult> {
    const paths = this.validatePaths(relativePaths)

    emitTrace(context, 'codescope-readiness-requested', 'started', { tool: 'discover_repository', capability: 'FILE_INVENTORY' })
    try {
      if (typeof this.codeMap.awaitReadiness === 'function') {
        await this.codeMap.awaitReadiness(repoPath, 'FILE_INVENTORY')
      } else {
        await this.codeMap.awaitSnapshot(repoPath)
      }
      emitTrace(context, 'codescope-readiness-satisfied', 'success', { tool: 'discover_repository', capability: 'FILE_INVENTORY' })
    } catch (error) {
      emitTrace(context, 'codescope-readiness-failed', 'error', {
        tool: 'discover_repository',
        error: error instanceof Error ? error.message : String(error),
        capability: 'FILE_INVENTORY'
      })
      throw error
    }

    emitTrace(context, 'codescope-index-query-started', 'started', { tool: 'discover_repository' })
    const files = this.codeMap.getFiles(repoPath)
    emitTrace(context, 'codescope-index-query-completed', 'success', { tool: 'discover_repository' })

    emitTrace(context, 'codescope-result-assembly-started', 'started', { tool: 'discover_repository' })
    const result = { directories: paths.map((relativePath) => {
      const prefix = relativePath === '.' ? '' : relativePath + '/'
      const directories = new Set<string>()
      const leaves = new Set<string>()
      for (const file of files) {
        if (!file.relativePath.startsWith(prefix)) continue
        const remainder = file.relativePath.slice(prefix.length)
        const slash = remainder.indexOf('/')
        if (slash < 0) leaves.add(remainder)
        else directories.add(remainder.slice(0, slash) + '/')
      }
      if (relativePath !== '.' && !directories.size && !leaves.size) {
        throw new ContextNavigationError('UNKNOWN_DIRECTORY', 'Unknown CodeMap directory: ' + relativePath, relativePath)
      }
      return { relativePath, children: [...[...directories].sort(), ...[...leaves].sort()] }
    }) }
    emitTrace(context, 'codescope-result-assembly-completed', 'success', { tool: 'discover_repository' })
    return result
  }

  private validatePaths(relativePaths: string[]): string[] {
    const paths = relativePaths.map((relativePath) => {
      if (!relativePath || /[\\:\x00-\x1f\x7f]/.test(relativePath) || relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
        throw new ContextNavigationError('INVALID_PATH', 'Expected a repository-relative path', relativePath)
      }
      return relativePath.split('/').filter((part) => part && part !== '.').join('/') || '.'
    })
    requireNonEmptyUnique(paths, 'EMPTY_SCOPE', 'DUPLICATE_PATH')
    return paths
  }

  private selectFiles(files: CodeMapFile[], paths: string[]): CodeMapFile[] {
    const byPath = new Map(files.map((file) => [file.relativePath, file]))
    return paths.map((relativePath) => {
      const file = byPath.get(relativePath)
      if (!file) throw new ContextNavigationError('UNKNOWN_FILE', 'Unknown CodeMap file: ' + relativePath, relativePath)
      return file
    })
  }

  private resolveTargets(targetIds: string[], elementsById: Map<string, CodeMapElement>): Array<{ targetId: string; element: CodeMapElement }> {
    const targets = targetIds.map((targetId) => {
      const parsed = parseCodeTargetId(targetId)
      if (!parsed) {
        throw new ContextNavigationError('INVALID_TARGET', `Invalid CodeTarget: ${targetId}`, targetId)
      }
      const element = elementsById.get(parsed.elementId)
      if (!element) {
        throw new ContextNavigationError('ELEMENT_NOT_FOUND', `CodeTarget element not found: ${targetId}`, targetId)
      }
      if (!element.retrievable) {
        throw new ContextNavigationError('ELEMENT_NOT_RETRIEVABLE', `CodeTarget element is not retrievable: ${targetId}`, targetId)
      }
      return { targetId: createFullTargetId(element.id), element }
    })
    requireNonEmptyUnique(targets.map((target) => target.targetId), 'EMPTY_TARGETS', 'DUPLICATE_TARGET')
    return targets
  }

  async getRelationships(repoPath: string, relativePaths: string[], options: RelationshipOptions = {}): Promise<GetRelationshipsResult> {
    const paths = this.validatePaths(relativePaths)
    const direction = options.direction ?? 'both'
    if (!['in', 'out', 'both'].includes(direction)) throw new ContextNavigationError('INVALID_ARGUMENT', 'Invalid relationship direction')
    await this.codeMap.awaitSnapshot(repoPath)
    const files = this.codeMap.getFiles(repoPath)
    const selected = this.selectFiles(files, paths)
    const byId = new Map(files.map((file) => [file.id, file.relativePath]))
    const index = projectFileRelationships(files, this.codeMap.getElements(repoPath), this.codeMap.getRelationships(repoPath))
    const edges = (ids: Set<string> | undefined): FileRelationship[] => [...(ids ?? [])].map((id) => byId.get(id)!).sort()
      .map((relativePath) => ({ relativePath, ...(options.details ? { type: 'imports' as const } : {}) }))
    return { files: selected.map((file) => ({
      relativePath: file.relativePath,
      ...(direction !== 'in' ? { out: edges(index.out.get(file.id)) } : {}),
      ...(direction !== 'out' ? { in: edges(index.in.get(file.id)) } : {})
    })) }
  }

  async inspectFiles(repoPath: string, relativePaths: string[], options: InspectFilesOptions = {}): Promise<InspectFilesResult> {
    const paths = this.validatePaths(relativePaths)
    await this.codeMap.awaitSnapshot(repoPath)
    const selected = this.selectFiles(this.codeMap.getFiles(repoPath), paths)
    const elements = this.codeMap.getElements(repoPath)
    return { files: selected.map((file) => ({
      relativePath: file.relativePath,
      elements: projectFileOutline(elements.filter((element) => element.fileId === file.id), options)
    })) }
  }

  async getReferences(repoPath: string, targetIds: string[]): Promise<GetReferencesResult> {
    requireNonEmptyUnique(targetIds, 'EMPTY_TARGETS', 'DUPLICATE_TARGET')
    await this.codeMap.awaitSnapshot(repoPath)
    const elements = this.codeMap.getElements(repoPath)
    const elementsById = new Map(elements.map((element) => [element.id, element]))
    const filesById = new Map(this.codeMap.getFiles(repoPath).map((file) => [file.id, file]))
    const targets = this.resolveTargets(targetIds, elementsById)

    return {
      targets: targets.map(({ targetId, element }) => {
        const references = [...this.codeMap.getSymbolReferencesByTargetElement(repoPath, element.id)]
          .sort((left, right) => {
            const leftPath = filesById.get(left.sourceFileId)?.relativePath ?? ''
            const rightPath = filesById.get(right.sourceFileId)?.relativePath ?? ''
            const pathOrder = leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
            const kindOrder = left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0
            return pathOrder ||
              left.location.start.line - right.location.start.line ||
              left.location.start.byte - right.location.start.byte ||
              kindOrder
          })
          .flatMap((reference) => {
            const file = filesById.get(reference.sourceFileId)
            if (!file) return []
            const sourceElement = reference.sourceElementId ? elementsById.get(reference.sourceElementId) : undefined
            const sourceTarget = sourceElement ? projectFullTarget(sourceElement) : undefined
            return [{
              relativePath: file.relativePath,
              kind: reference.kind,
              line: reference.location.start.line,
              ...(sourceTarget ? { sourceTarget } : {})
            }]
          })
        return { target: targetId, references }
      })
    }
  }

  async getSymbolDependencies(repoPath: string, sourceTargetIds: string[]): Promise<GetSymbolDependenciesResult> {
    requireNonEmptyUnique(sourceTargetIds, 'EMPTY_TARGETS', 'DUPLICATE_TARGET')
    await this.codeMap.awaitSnapshot(repoPath)
    const elements = this.codeMap.getElements(repoPath)
    const elementsById = new Map(elements.map((element) => [element.id, element]))
    const filesById = new Map(this.codeMap.getFiles(repoPath).map((file) => [file.id, file]))
    const sources = this.resolveTargets(sourceTargetIds, elementsById)

    return {
      sources: sources.map(({ targetId: source, element }) => {
        const unique = new Map<string, SymbolDependencyLocation>()
        for (const reference of this.codeMap.getSymbolReferencesBySourceElement(repoPath, element.id)) {
          const targetElement = elementsById.get(reference.targetElementId)
          const target = targetElement ? projectFullTarget(targetElement) : undefined
          const relativePath = targetElement ? filesById.get(targetElement.fileId)?.relativePath : undefined
          if (!targetElement || !target || !relativePath) continue
          const key = `${targetElement.id}\0${reference.kind}`
          if (!unique.has(key)) unique.set(key, { target, kind: reference.kind, relativePath })
        }
        const dependencies = [...unique.values()].sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath) ||
          left.kind.localeCompare(right.kind) ||
          left.target.localeCompare(right.target)
        )
        return { source, dependencies }
      })
    }
  }

  async getSymbolHierarchy(repoPath: string, targetIds: string[], options: SymbolHierarchyOptions = {}): Promise<GetSymbolHierarchyResult> {
    requireNonEmptyUnique(targetIds, 'EMPTY_TARGETS', 'DUPLICATE_TARGET')
    const direction = options.direction ?? 'both'
    if (!['up', 'down', 'both'].includes(direction)) {
      throw new ContextNavigationError('INVALID_ARGUMENT', 'Invalid symbol hierarchy direction')
    }
    await this.codeMap.awaitSnapshot(repoPath)
    const elements = this.codeMap.getElements(repoPath)
    const elementsById = new Map(elements.map((element) => [element.id, element]))
    const filesById = new Map(this.codeMap.getFiles(repoPath).map((file) => [file.id, file]))
    const targets = this.resolveTargets(targetIds, elementsById)

    const project = (relationships: ReturnType<CodeMapNavigationPort['getHierarchyRelationshipsBySourceElement']>, relatedEndpoint: 'sourceId' | 'targetId'): SymbolHierarchyRelation[] => {
      const unique = new Map<string, SymbolHierarchyRelation>()
      for (const relationship of relationships) {
        if (relationship.type !== 'extends' && relationship.type !== 'implements') continue
        const relatedElement = elementsById.get(relationship[relatedEndpoint])
        const target = relatedElement ? projectFullTarget(relatedElement) : undefined
        const relativePath = relatedElement ? filesById.get(relatedElement.fileId)?.relativePath : undefined
        if (!relatedElement || !target || !relativePath) continue
        const key = `${relationship.type}\0${relatedElement.id}`
        if (!unique.has(key)) unique.set(key, { kind: relationship.type, target, relativePath })
      }
      return [...unique.values()].sort((left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.relativePath.localeCompare(right.relativePath) ||
        left.target.localeCompare(right.target)
      )
    }

    return {
      targets: targets.map(({ targetId: target, element }) => ({
        target,
        ...(direction !== 'down' ? { up: project(this.codeMap.getHierarchyRelationshipsBySourceElement(repoPath, element.id), 'targetId') } : {}),
        ...(direction !== 'up' ? { down: project(this.codeMap.getHierarchyRelationshipsByTargetElement(repoPath, element.id), 'sourceId') } : {})
      }))
    }
  }

  async readCode(repoPath: string, targetIds: string[]): Promise<ReadCodeResult[]> {
    requireNonEmptyUnique(targetIds, 'EMPTY_TARGETS', 'DUPLICATE_TARGET')
    await this.codeMap.awaitSnapshot(repoPath)

    const elementsById = new Map(this.codeMap.getElements(repoPath).map((element) => [element.id, element]))
    const filesById = new Map(this.codeMap.getFiles(repoPath).map((file) => [file.id, file]))
    const targets = this.resolveTargets(targetIds, elementsById)

    const sources = await this.codeMap.getElementExactSources(repoPath, targets.map(({ element }) => element.id))
    return targets.map(({ targetId, element }) => {
      const source = sources.get(element.id)
      const file = filesById.get(element.fileId)
      if (
        !source || !file ||
        source.startByte !== element.location.start.byte ||
        source.endByte !== element.location.end.byte ||
        source.relativePath !== file.relativePath
      ) {
        throw new ContextNavigationError('EXACT_SOURCE_UNAVAILABLE', `Exact source unavailable for CodeTarget: ${targetId}`, targetId)
      }
      return {
        targetId,
        relativePath: file.relativePath,
        source: source.content
      }
    })
  }
}
