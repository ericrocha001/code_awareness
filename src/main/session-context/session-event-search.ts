import { entireFileIdentity, type EntireFileSource } from './entire-source'
import type { SessionReferences } from './session-references'
import type { EventRow, SessionRow } from './types'

const maxCandidates = 8
const rawByteBudget = 192 * 1024
const maxEventBytes = 64 * 1024

export async function searchReferencedEvents<T>(
  refs: SessionReferences, row: SessionRow, candidates: EventRow[], term: string, limit: number, source: EntireFileSource,
  read: (event: EventRow, offset: number, deadline: number) => Promise<{ content: string; complete: boolean; range: { endByte: number } }>,
  assertCurrent: () => void, project: (event: EventRow) => T, fits: (events: (T & { match: { startByte: number } })[]) => boolean
) {
  const validate = async () => {
    assertCurrent()
    const current = refs.source(row.id)
    if (!current || current.revision !== row.revision || current.locator.kind !== 'ENTIRE_FILE' ||
      current.locator.identity !== source.identity || current.locator.path !== source.path) throw new Error('SOURCE_STALE')
    let identity: string
    try { identity = await entireFileIdentity(source.path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('SOURCE_UNAVAILABLE'); throw error }
    if (identity !== source.identity) throw new Error('SOURCE_STALE')
    assertCurrent()
  }
  await validate()
  const end = Date.now() + 5000, needle = Buffer.from(term)
  const events: (T & { match: { startByte: number } })[] = []
  let scanned = 0, omitted = 0, bytes = 0
  for (const event of candidates.slice(0, maxCandidates)) {
    if (scanned && (Date.now() >= end || events.length >= limit)) break
    const fields = refs.fields(event.id)
    const size = fields?.reduce((sum, field) => sum + field.endByte - field.startByte + 1, 0)
    if (!size || size > maxEventBytes || event.omission) { scanned++; omitted++; continue }
    if (bytes + size > rawByteBudget) break
    bytes += size
    let previous = Buffer.alloc(0), offset = 0, match: number | undefined, complete = false
    while (Date.now() < end) {
      let page
      try { page = await read(event, offset, end) }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'PROVIDER_TIMEOUT') throw error
        break
      }
      assertCurrent()
      const data = Buffer.concat([previous, Buffer.from(page.content)])
      const position = data.indexOf(needle)
      if (position >= 0) { match = offset - previous.length + position; break }
      if (page.complete) { complete = true; break }
      if (page.range.endByte <= offset) throw new Error('SOURCE_STALE')
      previous = Buffer.from(data.subarray(Math.max(0, data.length - needle.length + 1)))
      offset = page.range.endByte
    }
    if (match !== undefined) {
      const hit = { ...project(event), match: { startByte: match } }
      if (!fits([...events, hit])) {
        if (!events.length) throw new Error('RESPONSE_LIMIT_REACHED')
        break
      }
      events.push(hit)
    } else if (!complete) {
      if (!scanned) throw new Error('SEARCH_BUDGET_EXCEEDED')
      break
    }
    scanned++
  }
  await validate()
  const more = scanned < candidates.length
  return { events, scanned, more, search: { coverage: more || omitted || row.coverage !== 'COMPLETE' ? 'PARTIAL' : 'COMPLETE',
    domain: 'SANITIZED_TEXT_WITHIN_SELECTED_REFERENCES', caseSensitive: true, scanned, omitted } }
}
