import type { RepoDiscoveryLayer } from '../../../shared/types/repo-discovery-types'
import { getCanonicalTokenizer, type TokenizerPort } from '../tokenizer'
import {
  buildRepoMapFacts,
  type RepoMapFactFile,
  type RepoMapFacts,
  type RepoMapSnapshot
} from './repo-map-facts'

export type RM2Snapshot = RepoMapSnapshot
export type RM2Projection = RepoMapFacts
export type RM2ProjectionFile = RepoMapFactFile

export interface ParsedRM2File {
  contextReference: string | null
  path: string
  sourceTokens: number | null
  outgoingContextReferences: string[]
  imports: string[]
}

export interface ParsedRM2 {
  layer: RepoDiscoveryLayer
  projectName: string
  files: ParsedRM2File[]
}

interface TrieNode {
  directories: Map<string, TrieNode>
  files: Array<RepoMapFactFile & { path: string }>
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}

export function projectRM2(snapshot: RM2Snapshot, layer: RepoDiscoveryLayer): RM2Projection {
  return buildRepoMapFacts(snapshot, layer)
}

function encodePath(value: string): string {
  return /[\t\r\n]/.test(value) || /^[">]/.test(value) ? JSON.stringify(value) : value
}

function decodePath(value: string): string {
  return value.startsWith('"') ? JSON.parse(value) as string : value
}

function buildTrie(files: RepoMapFactFile[]): TrieNode {
  const root: TrieNode = { directories: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (const directory of parts.slice(0, -1)) {
      let child = node.directories.get(directory)
      if (!child) {
        child = { directories: new Map(), files: [] }
        node.directories.set(directory, child)
      }
      node = child
    }
    node.files.push({ ...file, path: parts.at(-1)! })
  }
  return root
}

function requiredReferences(projection: RM2Projection): Set<string> {
  return new Set(projection.files.flatMap((file) => file.outgoingContextReferences))
}

function leafLine(
  file: RepoMapFactFile,
  layer: RepoDiscoveryLayer,
  referenced: ReadonlySet<string>,
  path = file.path
): string {
  const fields: string[] = []
  if (referenced.has(file.contextReference)) fields.push(file.contextReference)
  fields.push(file.sourceTokens === null ? '-' : String(file.sourceTokens), encodePath(path))
  if (layer === 2 && file.outgoingContextReferences.length > 0) {
    fields.push(`>${file.outgoingContextReferences.join(',')}`)
  }
  return fields.join('\t')
}

function collectFiles(node: TrieNode, prefix = ''): Array<{ file: RepoMapFactFile; path: string }> {
  const result = node.files.map((file) => ({ file, path: `${prefix}${file.path}` }))
  for (const [name, child] of [...node.directories].sort(([left], [right]) => compareText(left, right))) {
    result.push(...collectFiles(child, `${prefix}${name}/`))
  }
  return result
}

function indent(lines: string[]): string[] {
  return lines.map((line) => `\t${line}`)
}

function renderPathNode(node: TrieNode, tokenizer: TokenizerPort): string[] {
  const lines: string[] = []
  for (const [name, child] of [...node.directories].sort(([left], [right]) => compareText(left, right))) {
    const descendants = collectFiles(child, `${name}/`).map(({ path }) => encodePath(path))
    if (descendants.length === 1) {
      lines.push(...descendants)
      continue
    }
    const nested = [`${encodePath(name)}/`, ...indent(renderPathNode(child, tokenizer))]
    lines.push(...(tokenizer.count(nested.join('\n')) < tokenizer.count(descendants.join('\n')) ? nested : descendants))
  }
  lines.push(...[...node.files].sort((left, right) => compareText(left.path, right.path)).map((file) => encodePath(file.path)))
  return lines
}

function renderNode(
  node: TrieNode,
  layer: RepoDiscoveryLayer,
  referenced: ReadonlySet<string>,
  tokenizer: TokenizerPort
): string[] {
  const lines: string[] = []
  for (const [name, child] of [...node.directories].sort(([left], [right]) => compareText(left, right))) {
    const descendants = collectFiles(child, `${name}/`)
    const flat = descendants.map(({ file, path }) => leafLine(file, layer, referenced, path))
    if (descendants.length === 1) {
      lines.push(...flat)
      continue
    }
    const nestedPaths = [`${encodePath(name)}/`, ...indent(renderPathNode(child, tokenizer))]
    const flatPaths = descendants.map(({ path }) => encodePath(path))
    const useNested = tokenizer.count(nestedPaths.join('\n')) < tokenizer.count(flatPaths.join('\n'))
    lines.push(...(useNested ? [`${encodePath(name)}/`, ...indent(renderNode(child, layer, referenced, tokenizer))] : flat))
  }
  for (const file of [...node.files].sort((left, right) => compareText(left.path, right.path))) {
    lines.push(leafLine(file, layer, referenced))
  }
  return lines
}

function legend(layer: RepoDiscoveryLayer): string {
  const parts = [
    `RM2L${layer}=Repo Discovery ${layer === 1 ? 'Inventory' : 'Connections'}`,
    'PROJECT.name=project name',
    'dirs/=nested exact path prefixes',
    'file=[ref\\t]source_tokens\\tpath',
    'source_tokens=exact cl100k_base count',
    'ref=Context Reference when the file is an edge target',
    'absent facts are not serialized'
  ]
  if (layer === 2) parts.push('>ref=outbound internal file edge; inbound is derived')
  return parts.join('; ')
}

export function serializeRM2(
  projection: RM2Projection,
  tokenizer: TokenizerPort = getCanonicalTokenizer()
): string {
  const lines = [
    `RM2L${projection.layer}`,
    `PROJECT{name=${JSON.stringify(projection.projectName)}}`,
    `LEGEND{${legend(projection.layer)}}`,
    'MAP|H'
  ]
  lines.push(...renderNode(buildTrie(projection.files), projection.layer, requiredReferences(projection), tokenizer))
  return lines.join('\n')
}

export function parseRM2(content: string): ParsedRM2 {
  const lines = content.split('\n')
  const version = /^RM2L([12])$/.exec(lines.shift() ?? '')
  if (!version) throw new Error('Unsupported RM2 grammar.')
  const layer = Number(version[1]) as RepoDiscoveryLayer
  const project = /^PROJECT\{name=(.*)\}$/.exec(lines.shift() ?? '')
  if (!project) throw new Error('Invalid RM2 project header.')
  const projectName = JSON.parse(project[1]) as string
  if (!/^LEGEND\{.*\}$/.test(lines.shift() ?? '')) throw new Error('Invalid RM2 legend.')
  if (lines.shift() !== 'MAP|H') throw new Error('Invalid RM2 map header.')

  const files: ParsedRM2File[] = []
  const directories: string[] = []
  for (const line of lines) {
    if (!line) continue
    const depth = line.match(/^\t*/)?.[0].length ?? 0
    const value = line.slice(depth)
    if (value.endsWith('/') && !value.includes('\t')) {
      directories.length = depth
      directories[depth] = decodePath(value.slice(0, -1))
      continue
    }
    const fields = value.split('\t')
    const reference = fields.length >= 3 && !fields[2].startsWith('>') ? fields.shift()! : null
    const sourceTokenValue = fields.shift()
    const pathValue = fields.shift()
    if (sourceTokenValue === undefined || pathValue === undefined) throw new Error('Invalid RM2 file record.')
    const outgoingField = fields.find((field) => field.startsWith('>'))
    const outgoingContextReferences = outgoingField ? outgoingField.slice(1).split(',').filter(Boolean) : []
    const path = [...directories.slice(0, depth), decodePath(pathValue)].join('/')
    files.push({
      contextReference: reference,
      path,
      sourceTokens: sourceTokenValue === '-' ? null : Number(sourceTokenValue),
      outgoingContextReferences,
      imports: outgoingContextReferences
    })
  }
  return { layer, projectName, files }
}

function comparableProjection(projection: RM2Projection): unknown {
  const referenced = requiredReferences(projection)
  return {
    layer: projection.layer,
    projectName: projection.projectName,
    files: projection.files.map((file) => ({
      contextReference: referenced.has(file.contextReference) ? file.contextReference : null,
      path: file.path,
      sourceTokens: file.sourceTokens,
      outgoingContextReferences: file.outgoingContextReferences
    })).sort((left, right) => compareText(left.path, right.path))
  }
}

function comparableParsed(parsed: ParsedRM2): unknown {
  return {
    layer: parsed.layer,
    projectName: parsed.projectName,
    files: parsed.files.map(({ imports: _imports, ...file }) => file)
      .sort((left, right) => compareText(left.path, right.path))
  }
}

export interface RM2RoundTripResult {
  valid: boolean
  originalFiles: number
  parsedFiles: number
  originalEdges: number
  parsedEdges: number
}

export function verifyRM2Projection(projection: RM2Projection): RM2RoundTripResult {
  const parsed = parseRM2(serializeRM2(projection))
  const countEdges = (files: Array<{ outgoingContextReferences: string[] }>) =>
    files.reduce((sum, file) => sum + file.outgoingContextReferences.length, 0)
  return {
    valid: JSON.stringify(comparableProjection(projection)) === JSON.stringify(comparableParsed(parsed)),
    originalFiles: projection.files.length,
    parsedFiles: parsed.files.length,
    originalEdges: countEdges(projection.files),
    parsedEdges: countEdges(parsed.files)
  }
}

export function verifyRM2RoundTrip(snapshot: RM2Snapshot, layer: RepoDiscoveryLayer): RM2RoundTripResult {
  return verifyRM2Projection(projectRM2(snapshot, layer))
}

export function countRM2Tokens(
  projection: RM2Projection,
  tokenizer: TokenizerPort = getCanonicalTokenizer()
): number {
  return tokenizer.count(serializeRM2(projection, tokenizer))
}
