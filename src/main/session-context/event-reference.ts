import { EVENT_TYPES, type EventInput } from './types'
import type { ReferencedEvent } from './entire-transcript'
import { safeFile, sanitize, utf8Prefix } from './privacy'
import { sourceTimestamp } from './source-time'

export function assertEventEnvelope(event: Pick<EventInput, 'type' | 'sourcePosition' | 'omission'>): void {
  if (!EVENT_TYPES.includes(event.type) || !Number.isSafeInteger(event.sourcePosition) || event.sourcePosition < 0 || (event.omission !== undefined && !['LIMIT_REACHED', 'REDACTED', 'UNAVAILABLE'].includes(event.omission))) throw new Error('INVALID_EVENT')
}
export function eventReference(event: ReferencedEvent): ReferencedEvent {
  assertEventEnvelope(event)
  if (event.success !== undefined && typeof event.success !== 'boolean') throw new Error('INVALID_EVENT')
  return { type: event.type, timestamp: sourceTimestamp(event.timestamp), tool: event.tool ? utf8Prefix(sanitize(event.tool), 80) : undefined, success: event.success,
    sourcePosition: event.sourcePosition, files: event.files.map(safeFile).filter((file): file is string => !!file),
    fields: event.fields.map(field => {
      if (![field.startByte, field.endByte, field.bytes].every(value => Number.isSafeInteger(value) && value >= 0) || field.endByte < field.startByte || !/^[a-f0-9]{64}$/.test(field.digest) || !['JSON_STRING', 'JSON_VALUE'].includes(field.encoding) || !/^[A-Za-z0-9_/-]{1,512}$/.test(field.path)) throw new Error('SOURCE_LOCATOR_INVALID')
      return { path: field.path, bytes: field.bytes, digest: field.digest, encoding: field.encoding, startByte: field.startByte, endByte: field.endByte }
    }) }
}
