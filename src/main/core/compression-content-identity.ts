/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Avaliar a identidade de conteúdo de arquivos com suporte a fast path O(1) baseado em mtime e tamanho.
2. Resolver o hash SHA-256 do conteúdo utilizando provider customizado injetado ou leitura direta em disco.
3. Determinar o status de cache hit (por metadata ou por hash) em relação à entrada em cache informada.

Mapa de Relacionamentos do Script

1. compression-cache.ts
   - Tipo: Contrato / Interface
   - Relação: Consome o tipo CacheEntry para inspecionar os metadados e o hash cacheados.
   - Criticidade: Alta

2. compression-service.ts
   - Tipo: Dependência Inversa
   - Relação: Consome resolveContentIdentity para decidir se utiliza conteúdo cacheado ou se enfileira o arquivo para compressão.
   - Criticidade: Alta

Invariantes do Script

1. O Fast Path de mtime+tamanho é avaliado antes de qualquer operação de I/O de conteúdo ou cálculo de hash.
2. Falhas no provider injetado nunca abortam a execução, acionando fallback transparente para leitura de disco.
3. Falhas na leitura do arquivo em disco retornam hash nulo sem lançar exceções para o chamador.
4. O módulo não armazena estado interno e não realiza mutações no cache.

--- FIM ARQUITETURA DO SCRIPT ---
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
