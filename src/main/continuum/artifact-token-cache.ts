import type Database from 'better-sqlite3'
import { countCanonicalTokens, getCanonicalTokenizer } from '../core/tokenizer'

export const TOKEN_CACHE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS artifact_token_cache (
    artifact_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    tokenizer_id TEXT NOT NULL,
    tokenizer_encoding TEXT NOT NULL,
    raw_markdown_token_count INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, tokenizer_id, tokenizer_encoding)
  );
`

export interface TokenCountResult {
  rawMarkdownTokenCount: number
  tokenizerId: string
  tokenizerEncoding: string
}

interface CacheRow {
  revision: number
  content_hash: string
  tokenizer_id: string
  tokenizer_encoding: string
  raw_markdown_token_count: number
}

export class ArtifactTokenCache {
  constructor(private readonly db: Database.Database) {}

  /**
   * Returns the token count for an artifact's rawMarkdown.
   * Uses the cache when revision, contentHash and tokenizer identity match; recomputes on miss.
   * Never reads rawMarkdown from the DB unless a cache miss requires it.
   */
  measure(artifactId: string, revision: number, contentHash: string, rawMarkdown: string): TokenCountResult {
    const tokenizer = getCanonicalTokenizer()
    const row = this.db.prepare(
      'SELECT revision, content_hash, tokenizer_id, tokenizer_encoding, raw_markdown_token_count FROM artifact_token_cache WHERE artifact_id = ? AND tokenizer_id = ? AND tokenizer_encoding = ?'
    ).get(artifactId, tokenizer.id, tokenizer.encoding) as CacheRow | undefined

    if (row && row.revision === revision && row.content_hash === contentHash) {
      return { rawMarkdownTokenCount: row.raw_markdown_token_count, tokenizerId: row.tokenizer_id, tokenizerEncoding: row.tokenizer_encoding }
    }

    const { tokenCount } = countCanonicalTokens(rawMarkdown)
    this.db.prepare(
      `INSERT OR REPLACE INTO artifact_token_cache (artifact_id, revision, content_hash, tokenizer_id, tokenizer_encoding, raw_markdown_token_count)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(artifactId, revision, contentHash, tokenizer.id, tokenizer.encoding, tokenCount)

    return { rawMarkdownTokenCount: tokenCount, tokenizerId: tokenizer.id, tokenizerEncoding: tokenizer.encoding }
  }

  /**
   * Returns token counts for multiple artifacts, fetching rawMarkdown only for cache misses.
   * Accepts a loader that receives only the IDs with cache misses.
   */
  measureBatch(
    entries: Array<{ artifactId: string; revision: number; contentHash: string }>,
    loadMarkdown: (misses: Array<{ artifactId: string; revision: number; contentHash: string }>) => Map<string, string>
  ): Map<string, TokenCountResult> {
    const tokenizer = getCanonicalTokenizer()
    const results = new Map<string, TokenCountResult>()
    const misses: Array<{ artifactId: string; revision: number; contentHash: string }> = []

    const cachedRows = this.db.prepare(
      `SELECT artifact_id, revision, content_hash, tokenizer_id, tokenizer_encoding, raw_markdown_token_count FROM artifact_token_cache
       WHERE tokenizer_id = ? AND tokenizer_encoding = ? AND artifact_id IN (${entries.map(() => '?').join(',')})`
    ).all(tokenizer.id, tokenizer.encoding, ...entries.map(e => e.artifactId)) as (CacheRow & { artifact_id: string })[]

    const cacheMap = new Map(cachedRows.map(r => [r.artifact_id, r]))

    for (const entry of entries) {
      const cached = cacheMap.get(entry.artifactId)
      if (cached && cached.revision === entry.revision && cached.content_hash === entry.contentHash) {
        results.set(entry.artifactId, { rawMarkdownTokenCount: cached.raw_markdown_token_count, tokenizerId: cached.tokenizer_id, tokenizerEncoding: cached.tokenizer_encoding })
      } else {
        misses.push(entry)
      }
    }

    if (misses.length > 0) {
      const markdowns = loadMarkdown(misses)
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO artifact_token_cache (artifact_id, revision, content_hash, tokenizer_id, tokenizer_encoding, raw_markdown_token_count)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      const insertBatch = this.db.transaction((missEntries: typeof misses) => {
        for (const entry of missEntries) {
          const rawMarkdown = markdowns.get(entry.artifactId)
          if (rawMarkdown === undefined) continue
          const { tokenCount } = countCanonicalTokens(rawMarkdown)
          insert.run(entry.artifactId, entry.revision, entry.contentHash, tokenizer.id, tokenizer.encoding, tokenCount)
          results.set(entry.artifactId, { rawMarkdownTokenCount: tokenCount, tokenizerId: tokenizer.id, tokenizerEncoding: tokenizer.encoding })
        }
      })
      insertBatch(misses)
    }

    return results
  }
}
