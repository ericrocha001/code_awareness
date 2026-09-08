import type { CodeMapFile, CodeMapRelationship } from '../../../shared/types'
import { getCanonicalTokenizer, type TokenizerPort } from '../tokenizer'
import { parseRM2, projectRM2, serializeRM2, type RM2Snapshot } from './rm2-encoder'

export type SerializationCandidateName = 'flat-full' | 'flat-minimal' | 'tree-text' | 'trie-compact' | 'trie-refs'

export interface SerializationBenchmarkResult {
  candidates: Array<{ name: SerializationCandidateName; tokens: number; valid: boolean }>
  winner: SerializationCandidateName
}

interface CanonicalCorpus {
  files: Array<{ path: string; tokens: number | null }>
  edges: Array<{ source: string; target: string }>
}

function canonicalCorpus(snapshot: RM2Snapshot): CanonicalCorpus {
  const projection = projectRM2(snapshot, 2)
  const pathsByReference = new Map(projection.files.map((file) => [file.contextReference, file.path]))
  return {
    files: projection.files.map((file) => ({ path: file.path, tokens: file.sourceTokens })),
    edges: projection.files.flatMap((file) => file.outgoingContextReferences.map((target) => ({
      source: file.path,
      target: pathsByReference.get(target)!
    })))
  }
}

function sameCorpus(left: CanonicalCorpus, right: CanonicalCorpus): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function flatCandidate(corpus: CanonicalCorpus, repoRoot = ''): { content: string; decoded: CanonicalCorpus } {
  const prefix = repoRoot ? `${repoRoot.replace(/\\/g, '/').replace(/\/$/, '')}/` : ''
  const content = [
    ...corpus.files.map((file) => `f\t${file.tokens ?? '-'}\t${prefix}${file.path}`),
    ...corpus.edges.map((edge) => `r\t${prefix}${edge.source}\t${prefix}${edge.target}`)
  ].join('\n')
  const strip = (path: string) => prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
  const files: CanonicalCorpus['files'] = []
  const edges: CanonicalCorpus['edges'] = []
  for (const line of content.split('\n')) {
    const [kind, first, second] = line.split('\t')
    if (kind === 'f') files.push({ path: strip(second), tokens: first === '-' ? null : Number(first) })
    if (kind === 'r') edges.push({ source: strip(first), target: strip(second) })
  }
  return { content, decoded: { files, edges } }
}

function treeCandidate(corpus: CanonicalCorpus): { content: string; decoded: CanonicalCorpus } {
  const root: Record<string, unknown> = {}
  for (const file of corpus.files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>
    node[parts.at(-1)!] = file.tokens
  }
  const lines: string[] = []
  const emit = (node: Record<string, unknown>, depth: number) => {
    for (const [name, value] of Object.entries(node).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
      if (value && typeof value === 'object') {
        lines.push(`${'  '.repeat(depth)}${name}/`)
        emit(value as Record<string, unknown>, depth + 1)
      } else {
        lines.push(`${'  '.repeat(depth)}${value ?? '-'} ${name}`)
      }
    }
  }
  emit(root, 0)
  lines.push(...corpus.edges.map((edge) => `r\t${edge.source}\t${edge.target}`))
  const content = lines.join('\n')
  const directories: string[] = []
  const files: CanonicalCorpus['files'] = []
  const edges: CanonicalCorpus['edges'] = []
  for (const line of content.split('\n')) {
    if (line.startsWith('r\t')) {
      const [, source, target] = line.split('\t')
      edges.push({ source, target })
      continue
    }
    const spaces = line.match(/^ */)?.[0].length ?? 0
    const depth = spaces / 2
    const value = line.slice(spaces)
    if (value.endsWith('/')) {
      directories.length = depth
      directories[depth] = value.slice(0, -1)
      continue
    }
    const separator = value.indexOf(' ')
    const tokenValue = value.slice(0, separator)
    files.push({
      path: [...directories.slice(0, depth), value.slice(separator + 1)].join('/'),
      tokens: tokenValue === '-' ? null : Number(tokenValue)
    })
  }
  return { content, decoded: { files, edges } }
}

function compactTrieCandidate(corpus: CanonicalCorpus): { content: string; decoded: CanonicalCorpus } {
  const root: Record<string, unknown> = {}
  for (const file of corpus.files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>
    node[parts.at(-1)!] = file.tokens
  }
  const content = JSON.stringify([root, corpus.edges])
  const [decodedRoot, edges] = JSON.parse(content) as [Record<string, unknown>, CanonicalCorpus['edges']]
  const files: CanonicalCorpus['files'] = []
  const visit = (node: Record<string, unknown>, prefix: string[]) => {
    for (const [name, value] of Object.entries(node).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
      if (value && typeof value === 'object') visit(value as Record<string, unknown>, [...prefix, name])
      else files.push({ path: [...prefix, name].join('/'), tokens: value === null ? null : Number(value) })
    }
  }
  visit(decodedRoot, [])
  return { content, decoded: { files, edges } }
}

function refsCandidate(snapshot: RM2Snapshot): { content: string; decoded: CanonicalCorpus } {
  const content = serializeRM2(projectRM2(snapshot, 2))
  const parsed = parseRM2(content)
  const pathsByReference = new Map(parsed.files.map((file) => [file.contextReference, file.path]))
  return {
    content,
    decoded: {
      files: parsed.files.map((file) => ({ path: file.path, tokens: file.sourceTokens })),
      edges: parsed.files.flatMap((file) => file.imports.map((target) => ({
        source: file.path,
        target: pathsByReference.get(target)!
      })))
    }
  }
}

export function benchmarkRepoMapSerialization(
  snapshot: RM2Snapshot,
  repoRoot: string,
  tokenizer: TokenizerPort = getCanonicalTokenizer()
): SerializationBenchmarkResult {
  const corpus = canonicalCorpus(snapshot)
  const candidates = [
    { name: 'flat-full' as const, ...flatCandidate(corpus, repoRoot) },
    { name: 'flat-minimal' as const, ...flatCandidate(corpus) },
    { name: 'tree-text' as const, ...treeCandidate(corpus) },
    { name: 'trie-compact' as const, ...compactTrieCandidate(corpus) },
    { name: 'trie-refs' as const, ...refsCandidate(snapshot) }
  ].map((candidate) => ({
    name: candidate.name,
    tokens: tokenizer.count(candidate.content),
    valid: sameCorpus(corpus, candidate.decoded)
  }))
  const valid = candidates.filter((candidate) => candidate.valid).sort((left, right) => left.tokens - right.tokens)
  if (!valid.length) throw new Error('No valid Repo Map serialization candidate.')
  return { candidates, winner: valid[0].name }
}

export function createSerializationSnapshot(paths: string[], dense = false): RM2Snapshot {
  const files: CodeMapFile[] = [...paths].sort().map((path, index) => ({
    id: `f${index}`,
    repositoryId: 'harness',
    relativePath: path,
    language: 'typescript',
    extension: path.slice(path.lastIndexOf('.')),
    lines: 1,
    sizeBytes: 1,
    mtime: 1,
    contentHash: String(index),
    contextReference: `r${index.toString(36)}`,
    tokenCount: index + 1,
    status: 'indexed'
  }))
  const relationships: CodeMapRelationship[] = []
  if (files.length > 1) {
    const edgeCount = dense ? Math.min(files.length * 3, 300) : files.length - 1
    for (let index = 0; index < edgeCount; index++) {
      const source = files[index % files.length]
      const target = files[(index * 7 + 1) % files.length]
      if (source.id === target.id) continue
      relationships.push({
        id: `r${index}`,
        repositoryId: 'harness',
        sourceId: source.id,
        targetId: target.id,
        sourceKind: 'file',
        targetKind: 'file',
        type: 'imports'
      })
    }
  }
  return { files, elements: [], relationships }
}
