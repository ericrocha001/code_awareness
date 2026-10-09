import { createHash } from 'node:crypto'
import type { CodeMapElement, CodeMapFile } from '../../../shared/types'
import type { DashRequest } from '../../../shared/types/dash-types'
import { DASH_FIELDS } from '../../../shared/utils/dash-protocol'
import { projectFullTarget } from '../context/code-target'
import type { PersistedSymbolReference } from '../symbol-reference-resolver'
import type { DashMapPort } from './dash-map-port'
import { DashQueryResolver, type DashEntity, type DashSet } from './dash-query-resolver'
import { DashError } from './dash-request-validator'

export type DashContextPacket = Record<string, unknown>[]
export type DashPacketSerializer = (packet: DashContextPacket) => string
export const serializeDashPacket: DashPacketSerializer = (packet) => JSON.stringify(packet)

export async function materializeDashPacket(
  request: DashRequest,
  sets: Map<string, DashSet>,
  resolver: DashQueryResolver,
  map: DashMapPort,
  repo: string
): Promise<DashContextPacket> {
  const selected = new Map<
    string,
    { type: DashSet['type']; entity: DashEntity; fields: Set<string> }
  >()
  for (const emit of request.emit) {
    const set = sets.get(emit.from)!
    for (const entity of set.entities) {
      const key = `${set.type}:${entity.id}`
      const entry = selected.get(key) ?? { type: set.type, entity, fields: new Set<string>() }
      for (const field of emit.include) entry.fields.add(field)
      selected.set(key, entry)
    }
  }
  const sourceIds = [...selected.values()]
    .filter((x) => x.type === 'element-set' && x.fields.has('source'))
    .map((x) => x.entity.id)
  const literalFiles = [...selected.values()].some((x) => x.fields.has('fileSource'))
  if (sourceIds.length || literalFiles) await resolver.ready('STRUCTURE')
  const needsElements = [...selected.values()].some((x) => x.type !== 'file-set')
  const freshElements = new Map(
    needsElements ? resolver.getElements().map((x) => [x.id, x] as const) : []
  )
  for (const id of sourceIds) {
    const element = freshElements.get(id)
    if (!element?.retrievable)
      throw new DashError('EXACT_SOURCE_UNAVAILABLE', 'Element does not support exact retrieval')
    if (resolver.getFiles().find((x) => x.id === element.fileId)?.status === 'modified')
      throw new DashError('STALE_SOURCE', 'File changed since indexing')
  }
  const sources = sourceIds.length ? await map.getElementExactSources(repo, sourceIds) : new Map()
  for (const id of sourceIds) {
    const source = sources.get(id)
    if (!source)
      throw new DashError(
        'EXACT_SOURCE_UNAVAILABLE',
        'Exact source unavailable or incompatible with indexed content'
      )
    const element = selected.get(`element-set:${id}`)!.entity as CodeMapElement
    if (
      source.relativePath !== resolver.path(element) ||
      source.startByte !== element.location.start.byte ||
      source.endByte !== element.location.end.byte
    )
      throw new DashError('STALE_SOURCE', 'Indexed element range changed during execution')
  }
  const packet: DashContextPacket = []
  for (const type of ['file-set', 'element-set', 'reference-set'] as const) {
    const entries = [...selected.values()].filter((x) => x.type === type)
    const ordered = resolver.canonical(
      type,
      entries.map((x) => x.entity)
    )
    const byId = new Map(entries.map((x) => [x.entity.id, x]))
    for (const entity of ordered.entities) {
      const { fields } = byId.get(entity.id)!
      const record: Record<string, unknown> = {}
      for (const field of DASH_FIELDS[type]) {
        if (!fields.has(field)) continue
        let value: unknown
        if (field === 'path') value = resolver.path(entity)
        else if (type === 'file-set') {
          const file = resolver.getFiles().find((x) => x.id === entity.id) as CodeMapFile
          if (field === 'fileSource') {
            const content = await map.getFileContent(repo, file.relativePath)
            if (!content || content.truncated)
              throw new DashError('EXACT_SOURCE_UNAVAILABLE', 'Full file source unavailable')
            if (
              !file.contentHash ||
              createHash('sha256').update(content.content, 'utf8').digest('hex') !==
                file.contentHash
            )
              throw new DashError('STALE_SOURCE', 'File changed since indexing')
            value = content.content
          } else value = field === 'bytes' ? file.sizeBytes : file[field as keyof CodeMapFile]
        } else if (type === 'element-set') {
          const element = entity as CodeMapElement
          switch (field) {
            case 'source':
              value = sources.get(entity.id)!.content
              break
            case 'target':
              value = projectFullTarget(element)
              break
            case 'signature':
              value = element.declarationSignature
              break
            case 'lines':
              value = element.sizeLines
              break
            case 'bytes':
              value = element.sizeBytes
              break
            default:
              value = element[field as keyof CodeMapElement]
          }
        } else {
          const ref = entity as PersistedSymbolReference
          if (field === 'line') value = ref.location.start.line
          else if (field === 'kind') value = ref.kind
          else if (field === 'sourceTarget') {
            const source = ref.sourceElementId ? freshElements.get(ref.sourceElementId) : undefined
            value = source ? projectFullTarget(source) : null
          }
        }
        record[field] = value ?? null
      }
      packet.push(record)
    }
  }
  return packet
}
