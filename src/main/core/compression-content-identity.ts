/*
-T ---
*/

import { readFile } from 'fs/promises'
import { createHash } from 'crypto'
import type { CacheEntry } from './compression-cache'
import type { ContentIdentityPort } from './content-identity-port'

export interface ContentIdentityResult {
  hash: string | null
  fastPathHit: boolean
  cachedContent: string | null
}

/**
 * Resolve a identidade do arquivo e determina se há cache hit (fast path ou content hash).
 */
export async function resolveContentIdentity(
  repoPath: string,
  relativePath: string,
  fullPath: string,
  cached: CacheEntry | undefined,
  currentStat: { mtimeMs: number; size: number },
  provider?: ContentIdentityPort
): Promise<ContentIdentityResult> {
  // Fast Path: mtime + size idênticos → HIT imediato (zero I/O de conteúdo, zero hash)
  if (cached && cached.mtime === currentStat.mtimeMs && cached.size === currentStat.size) {
    return {
      hash: cached.contentHash,
      fastPathHit: true,
      cachedContent: cached.compressedContent
    }
  }

  // Resolução de hash: provider injetado primeiro, fallback para readFile
  let hash: string | null = null

  if (provider) {
    try {
      const provided = await provider.getContentHash(repoPath, relativePath)
      if (provided) {
        hash = provided
      }
    } catch {
      // Fallback para leitura interna caso o provider falhe
    }
  }

  if (!hash) {
    try {
      const content = await readFile(fullPath, 'utf-8')
      hash = createHash('sha256').update(content, 'utf-8').digest('hex')
    } catch {
      return {
        hash: null,
        fastPathHit: false,
        cachedContent: null
      }
    }
  }

  // Cache presente mas metadata diferente: verifica se o conteúdo permaneceu idêntico
  if (cached && cached.contentHash === hash) {
    return {
      hash,
      fastPathHit: false,
      cachedContent: cached.compressedContent
    }
  }

  // MISS real: conteúdo novo ou não cacheado
  return {
    hash,
    fastPathHit: false,
    cachedContent: null
  }
}
