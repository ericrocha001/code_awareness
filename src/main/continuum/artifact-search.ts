import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import { countCanonicalTokens } from '../core/tokenizer'
import type { ArtifactNavigation } from './artifact-navigation'
import { SEARCH_FIELDS, type ArtifactSearchQuery, type SearchField, type SearchMode } from './artifact-search-query'
import { canonicalJson, normalizeMetadataValue } from './artifact-metadata'

type Parameter = string | number
type Identity = { artifactId: string; revision: number; contentHash: string }
type Match = Identity & {
  id: number
  name: string
  field: SearchField
  section: number | null
  block: number | null
  path: string | null
  excerpt: string
  partial: boolean
  score: number
  alternative: number
  mode: SearchMode
}
type Counts = { eligible: number; indexed: number; pending: number; failed: number; fallback: number }
type PagePosition = { offset: number; afterArtifact: string }
type SearchHit = {
  artifactId: string
  revision: number
  name: string
  matchCount: number
  location: {
    field: SearchField
    headingPath?: string
    sectionId?: string
    blockId?: string
    excerpt: string
    partial: boolean
  }
  explanation?: { field: SearchField; mode: SearchMode; alternative: number; ranking: string }
}
type SearchPage = {
  repositoryId: string
  authority: 'CONTINUUM'
  coverage: Counts & { state: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'; limitations?: string[] }
  hits: SearchHit[]
  nextCursor?: string
  budgetReached?: true
  tokenUsage?: { encoding: 'cl100k_base'; estimated: true; payloadTokenCount: number }
}

const weights = [9, 5, 7, 1, 4]
const literalBatchSize = 4
const before = '\u0001', after = '\u0002'
const quote = (text: string) => '"' + text.replaceAll('"', '""') + '"'
const asciiFold = (text: string) => text.replace(/[A-Z]/g, character => character.toLowerCase())

function clip(text: string, position: number): { excerpt: string; partial: boolean } {
  const start = Math.max(0, position - 24)
  const aligned = start && /[\uDC00-\uDFFF]/.test(text[start]) ? start - 1 : start
  const excerpt = [...text.slice(aligned, aligned + 321)].slice(0, 160).join('')
  return { excerpt, partial: aligned > 0 || aligned + excerpt.length < text.length }
}

function readCursor(cursor: string | undefined, scope: string, key: string): PagePosition {
  if (!cursor) return { offset: 0, afterArtifact: '' }
  try {
    const [data, mac, extra] = cursor.split('.')
    const expected = createHmac('sha256', key).update(data).digest()
    const received = Buffer.from(mac, 'base64url')
    if (extra || received.length !== expected.length || !timingSafeEqual(expected, received)) throw new Error()
    const body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
    if (body.scope !== scope || !Number.isSafeInteger(body.offset) || body.offset < 0 ||
      typeof body.afterArtifact !== 'string') throw new Error()
    return { offset: body.offset, afterArtifact: body.afterArtifact }
  } catch {
    throw new Error('SEARCH_CURSOR_STALE: restart the search with its current repository and filters')
  }
}

function writeCursor(position: PagePosition, scope: string, key: string): string {
  const data = Buffer.from(JSON.stringify({ scope, ...position })).toString('base64url')
  return data + '.' + createHmac('sha256', key).update(data).digest('base64url')
}

function lexicalExpression(db: Database.Database, query: string, mode: SearchMode, distance?: number): string {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.continuum_query_tokens USING fts5(text, tokenize='unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.continuum_query_vocab USING fts5vocab(continuum_query_tokens, instance);
  `)
  db.exec('DELETE FROM temp.continuum_query_tokens')
  db.prepare('INSERT INTO temp.continuum_query_tokens(text) VALUES (?)').run(query)
  const terms = (db.prepare('SELECT term FROM temp.continuum_query_vocab ORDER BY offset').pluck().all() as string[]).map(quote)
  db.exec('DELETE FROM temp.continuum_query_tokens')
  if (!terms.length || terms.length > 32 || mode === 'NEAR' && terms.length < 2) {
    throw new Error('INVALID_ARGUMENT: lexical search requires 1–32 tokens and NEAR requires at least two')
  }
  if (mode === 'NEAR') return `NEAR(${terms.join(' ')}, ${distance})`
  if (mode === 'PHRASE') return terms.join(' + ')
  return terms.join(mode === 'ANY_TERMS' ? ' OR ' : ' AND ')
}

export function searchArtifacts(
  db: Database.Database, repositoryId: string, navigation: ArtifactNavigation, key: string,
  available: boolean, query: ArtifactSearchQuery, clauses: string[], parameters: Parameter[]
): SearchPage {
  if (query.artifactId) {
    clauses.push('a.artifact_id = ?')
    parameters.push(query.artifactId)
  }
  const scopeFilter = clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''
  const generation = available ? db.prepare('SELECT version, generation FROM artifact_search_generation WHERE id=1').get() as { version: string; generation: number } : undefined
  const counts = generation ? db.prepare(`
    SELECT count(*) AS eligible,
      count(CASE WHEN p.state IN ('CURRENT', 'FALLBACK') THEN 1 END) AS indexed,
      count(CASE WHEN p.state IS NULL OR p.state='PENDING' THEN 1 END) AS pending,
      count(CASE WHEN p.state='FAILED' THEN 1 END) AS failed,
      count(CASE WHEN p.state='FALLBACK' THEN 1 END) AS fallback
    FROM artifacts a LEFT JOIN artifact_search_projection p ON p.artifact_id=a.artifact_id
      AND p.revision=a.revision AND p.content_hash=a.content_hash AND p.version=?
    ${scopeFilter}
  `).get(generation.version, ...parameters) as Counts : {
    eligible: db.prepare(`SELECT count(*) FROM artifacts a ${scopeFilter}`).pluck().get(...parameters) as number,
    indexed: 0, pending: 0, failed: 0, fallback: 0
  }
  const expressions = [query, ...query.alternatives ?? []]
  const needsScan = expressions.some(expression => expression.mode === 'LITERAL' && [...expression.query].length < 3)
  const { cursor, ...selection } = query
  const scope = createHash('sha256').update(canonicalJson(normalizeMetadataValue({ repositoryId, generation: generation ?? null, selection }))).digest('base64url')
  const position = readCursor(cursor, scope, key)
  const page: SearchPage = {
    repositoryId, authority: 'CONTINUUM',
    coverage: { ...counts, state: !generation ? 'UNAVAILABLE' : counts.pending || counts.failed || counts.fallback || needsScan ? 'PARTIAL' : 'COMPLETE' },
    hits: []
  }
  const limitations: string[] = []
  if (!generation) limitations.push('INDEX_UNAVAILABLE')
  if (counts.pending) limitations.push('INDEX_PENDING')
  if (counts.failed) limitations.push('INDEX_FAILED')
  if (counts.fallback) limitations.push('STRUCTURAL_FALLBACK')
  if (needsScan && generation) limitations.push('BOUNDED_LITERAL_SCAN')
  if (limitations.length) page.coverage.limitations = limitations
  const budget = query.tokenBudget ?? 1200

  const fields = query.fields ?? SEARCH_FIELDS
  const where = [
    ...clauses,
    `u.field IN (${fields.map(() => '?').join(',')})`,
    ...(query.blockType ? ['u.block_type = ?', "u.field = 'body'"] : [])
  ]
  const matchParameters = [...parameters, ...fields, ...(query.blockType ? [query.blockType] : [])]
  const eligible = `
    JOIN artifacts a ON a.artifact_id=u.artifact_id
    JOIN artifact_search_projection p ON p.artifact_id=a.artifact_id AND p.revision=a.revision
      AND p.content_hash=a.content_hash AND p.version=? AND p.state IN ('CURRENT', 'FALLBACK')
    WHERE ${where.join(' AND ')}
  `
  let scanThrough = ''
  let scanMore = false
  const matches = new Map<number, Match>()
  if (generation) {
    let range = ''
    const rangeParameters: string[] = []
    if (needsScan) {
      const ids = db.prepare(`
        SELECT a.artifact_id FROM artifacts a
        JOIN artifact_search_projection p ON p.artifact_id=a.artifact_id AND p.revision=a.revision
          AND p.content_hash=a.content_hash AND p.version=? AND p.state IN ('CURRENT', 'FALLBACK')
        WHERE a.artifact_id>? ${clauses.map(clause => 'AND ' + clause).join(' ')}
        ORDER BY a.artifact_id LIMIT ?
      `).pluck().all(generation.version, position.afterArtifact, ...parameters, literalBatchSize + 1) as string[]
      scanMore = ids.length > literalBatchSize
      scanThrough = ids[Math.min(ids.length, literalBatchSize) - 1] ?? position.afterArtifact
      range = 'AND a.artifact_id>? AND a.artifact_id<=?'
      rangeParameters.push(position.afterArtifact, scanThrough)
      if (!scanMore && !counts.pending && !counts.failed && !counts.fallback) {
        page.coverage.state = 'COMPLETE'
        page.coverage.limitations = undefined
      }
    }
    const columns = 'u.id, a.artifact_id AS artifactId, a.name, a.revision, a.content_hash AS contentHash, u.field, u.section, u.block, u.path'
    for (const [alternative, expression] of expressions.entries()) {
      const mode = expression.mode ?? 'ALL_TERMS'
      const literal = mode === 'LITERAL'
      const indexedLiteral = literal && [...expression.query].length >= 3
      const source = literal
        ? indexedLiteral ? 'artifact_search_literal JOIN artifact_search_units u ON u.id=artifact_search_literal.rowid' : 'artifact_search_units u'
        : 'artifact_search_lexical JOIN artifact_search_units u ON u.id=artifact_search_lexical.rowid'
      const score = literal ? '0' : `bm25(artifact_search_lexical, ${weights.join(',')})`
      const evidence = literal ? 'u.text' : `snippet(artifact_search_lexical, -1, char(1), char(2), '…', 18)`
      const predicate = indexedLiteral ? 'AND artifact_search_literal MATCH ?' : literal ? '' : 'AND artifact_search_lexical MATCH ?'
      const term = literal ? quote(expression.query) : `{${fields.join(' ')}} : (${lexicalExpression(db, expression.query, mode, expression.distance)})`
      const rows = db.prepare(`
        SELECT ${columns}, ${score} AS score, ${evidence} AS text FROM ${source}
        ${eligible} ${range} ${predicate}
      `).iterate(generation.version, ...matchParameters, ...rangeParameters, ...(predicate ? [term] : [])) as Iterable<Omit<Match, 'excerpt' | 'partial' | 'alternative' | 'mode'> & { text: string }>
      const needle = expression.caseSensitive ? expression.query : asciiFold(expression.query)
      for (const { text, ...row } of rows) {
        if (matches.has(row.id)) continue
        const index = literal ? (expression.caseSensitive ? text : asciiFold(text)).indexOf(needle) : text.indexOf(before)
        if (literal && index < 0) continue
        const evidenceText = literal ? text : text.replaceAll(before, '').replaceAll(after, '')
        const clipped = clip(evidenceText, Math.max(index, 0))
        matches.set(row.id, { ...row, ...clipped, partial: clipped.partial || !literal && evidenceText.includes('…'),
          alternative, mode, score: literal ? -weights[SEARCH_FIELDS.indexOf(row.field)] : row.score })
      }
    }
  }

  const ranked = [...matches.values()].sort((a, b) =>
    a.alternative - b.alternative || a.score - b.score || (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : a.id - b.id))
  const seen = new Map<string, number>()
  for (const row of ranked) seen.set(row.artifactId, (seen.get(row.artifactId) ?? 0) + 1)
  const grouped = new Set<string>()
  const candidates = query.artifactId ? ranked : ranked.filter(row => {
    if (grouped.has(row.artifactId)) return false
    grouped.add(row.artifactId)
    return true
  })
  const next = (offset: number) => offset < candidates.length
    ? writeCursor({ offset, afterArtifact: position.afterArtifact }, scope, key)
    : scanMore ? writeCursor({ offset: 0, afterArtifact: scanThrough }, scope, key) : undefined
  const includeUsage = query.includeTokenUsage === true
  const withinBudget = (candidate: SearchPage): boolean => {
    if (includeUsage || candidate.budgetReached) {
      candidate.tokenUsage = { encoding: 'cl100k_base', estimated: true, payloadTokenCount: 0 }
      for (let attempts = 0; attempts < 5; attempts++) {
        const { tokenCount: count } = countCanonicalTokens(JSON.stringify(candidate))
        if (candidate.tokenUsage.payloadTokenCount === count) return count <= budget
        candidate.tokenUsage.payloadTokenCount = count
      }
    }
    return countCanonicalTokens(JSON.stringify(candidate)).tokenCount <= budget
  }
  let offset = position.offset
  for (; offset < candidates.length && page.hits.length < (query.limit ?? 5); offset++) {
    const row = candidates[offset]
    const selectors = row.section === null ? {} : navigation.selectLocation(row, row.section, row.block)
    const hit: SearchHit = {
      artifactId: row.artifactId, revision: row.revision, name: row.name,
      matchCount: seen.get(row.artifactId)!,
      location: { field: row.field, ...(row.path ? { headingPath: [...row.path].slice(0, 160).join('') } : {}), ...selectors,
        excerpt: row.excerpt, partial: row.partial },
      ...(query.explain ? { explanation: { field: row.field, mode: row.mode, alternative: row.alternative,
        ranking: row.mode === 'LITERAL' ? 'literal match and field weight' : 'BM25 and field weight' } } : {})
    }
    const tentative = { ...page, hits: [...page.hits, hit], nextCursor: next(offset + 1) }
    if (!withinBudget(tentative)) {
      page.budgetReached = true
      break
    }
    page.hits.push(hit)
  }
  page.nextCursor = next(offset)
  if (page.budgetReached && !page.hits.length) throw new Error('BUDGET_TOO_SMALL: increase tokenBudget or disable explain')
  while (!withinBudget(page)) {
    if (!page.hits.length) throw new Error('BUDGET_TOO_SMALL: increase tokenBudget')
    page.hits.pop()
    page.budgetReached = true
    page.nextCursor = next(--offset)
  }
  return page
}
