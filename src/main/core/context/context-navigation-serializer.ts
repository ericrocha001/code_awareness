import type { DiscoverRepositoryResult, GetRelationshipsResult, InspectFilesResult, FileOutlineElement, ReadCodeResult, GetReferencesResult, GetSymbolDependenciesResult, GetSymbolHierarchyResult } from '../../../shared/types/context-navigation-types'

export function serializeDiscovery(result: DiscoverRepositoryResult): string {
  return result.directories.map((directory) => [`[${directory.relativePath}]`, ...directory.children].join('\n')).join('\n\n')
}

export function serializeRelationships(result: GetRelationshipsResult): string {
  return result.files.map((file) => {
    const sections = [`[${file.relativePath}]`]
    for (const direction of ['out', 'in'] as const) {
      const edges = file[direction]
      if (edges) sections.push([direction.toUpperCase(), ...edges.map((edge) => edge.relativePath + (edge.type ? ` ${edge.type}` : ''))].join('\n'))
    }
    return sections.join('\n\n')
  }).join('\n\n')
}

export function serializeInspectFiles(result: InspectFilesResult): string {
  const lines = (elements: FileOutlineElement[], depth = 0): string[] => elements.flatMap((element) => [
    `${'  '.repeat(depth)}${element.kind === 'method' ? '' : `${element.kind} `}${element.signature ?? element.name}${element.target ? ` ${element.target}` : ''}`,
    ...lines(element.children ?? [], depth + 1)
  ])
  return result.files.map((file) => [`[${file.relativePath}]`, lines(file.elements).join('\n')].join('\n\n')).join('\n\n')
}

export function serializeReadCode(result: ReadCodeResult): string {
  return `[${result.targetId} ${result.relativePath}]\n\n${result.source}`
}

export function serializeReferences(result: GetReferencesResult): string {
  return result.targets.map(({ target, references }) => [
    `[${target}]`,
    references.length > 0
      ? references.map((reference) => `${reference.relativePath}:${reference.line} ${reference.kind}${reference.sourceTarget ? ` ${reference.sourceTarget}` : ''}`).join('\n')
      : 'NONE'
  ].join('\n\n')).join('\n\n')
}

export function serializeSymbolDependencies(result: GetSymbolDependenciesResult): string {
  return result.sources.map(({ source, dependencies }) => [
    `[${source}]`,
    dependencies.length > 0
      ? dependencies.map((dependency) => `${dependency.kind} ${dependency.target} ${dependency.relativePath}`).join('\n')
      : 'NONE'
  ].join('\n\n')).join('\n\n')
}

export function serializeSymbolHierarchy(result: GetSymbolHierarchyResult): string {
  return result.targets.map((entry) => {
    const sections = [`[${entry.target}]`]
    if (entry.up?.length) sections.push(['UP', ...entry.up.map((relation) => `${relation.kind} ${relation.target} ${relation.relativePath}`)].join('\n'))
    if (entry.down?.length) sections.push(['DOWN', ...entry.down.map((relation) => `${relation.kind} ${relation.target} ${relation.relativePath}`)].join('\n'))
    if (sections.length === 1) sections.push('NONE')
    return sections.join('\n\n')
  }).join('\n\n')
}
