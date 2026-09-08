/*
-T ---
*/

export interface CacheEntry {
  mtime: number              // Fast path: se mtime+size iguais, HIT imediato
  size: number               // Fast path: combinado com mtime
  contentHash: string        // Identidade forte: SHA-256 do conteúdo
  compressedContent: string  // Resultado da compressão
  sizeBytes: number          // Tamanho em bytes do compressedContent (para LRU por memória)
  lastAccessed: number       // Timestamp do último acesso (para LRU real)
}

/**
 * Cache LRU em memória com controle de limite por bytes e contagem de entradas.
 */
export class CompressionCache {
  private readonly cache = new Map<string, CacheEntry>()
  private currentCacheBytes = 0
  private readonly maxCacheBytes: number
  private readonly maxCacheEntries: number

  constructor(maxCacheBytes: number, maxCacheEntries: number) {
    this.maxCacheBytes = maxCacheBytes
    this.maxCacheEntries = maxCacheEntries
  }

  /**
   * Obtém a entrada do cache SEM alterar a ordem de recenticidade LRU.
   *
   * Para atualizar a recenticidade (tornar a entrada mais recente), use touch().
   *
   * @param key Chave da entrada no cache
   * @returns A entrada do cache ou undefined se não existir
   */
  get(key: string): CacheEntry | undefined {
    return this.cache.get(key)
  }

  /**
   * Verifica se uma chave existe no cache.
   */
  has(key: string): boolean {
    return this.cache.has(key)
  }

  /**
   * Insere ou atualiza uma entrada no cache aplicando evicção LRU por bytes e quantidade.
   */
  set(key: string, entry: CacheEntry): void {
    // Guarda defensiva: uma entrada individual que exceda o limite de bytes nunca entra no
    // cache. Sem isso, com o cache vazio, o while de evicção (que exige cache.size > 0) seria
    // pulado e o invariante de maxCacheBytes seria violado.
    if (entry.sizeBytes > this.maxCacheBytes) return

    const existing = this.cache.get(key)
    if (existing) {
      this.currentCacheBytes -= existing.sizeBytes
      this.cache.delete(key)
    }

    // Evicção LRU: remove do início do Map (mais antigas) enquanto exceder limites
    while (
      this.cache.size > 0 &&
      (this.currentCacheBytes + entry.sizeBytes > this.maxCacheBytes ||
        this.cache.size >= this.maxCacheEntries)
    ) {
      const oldestKey = this.cache.keys().next().value!
      const oldestEntry = this.cache.get(oldestKey)
      if (oldestEntry) {
        this.currentCacheBytes -= oldestEntry.sizeBytes
      }
      this.cache.delete(oldestKey)
    }

    this.cache.set(key, entry)
    this.currentCacheBytes += entry.sizeBytes
  }

  /**
   * Atualiza a recenticidade de uso da entrada, movendo-a para o final do Map (LRU).
   */
  touch(key: string): void {
    const entry = this.cache.get(key)
    if (entry) {
      entry.lastAccessed = Date.now()
      this.cache.delete(key)
      this.cache.set(key, entry)
    }
  }

  /**
   * Remove uma entrada específica do cache.
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key)
    if (entry) {
      this.currentCacheBytes -= entry.sizeBytes
      return this.cache.delete(key)
    }
    return false
  }

  /**
   * Limpa todo o cache em memória.
   */
  clear(): void {
    this.cache.clear()
    this.currentCacheBytes = 0
  }

  /**
   * Total de bytes ocupados pelo conteúdo comprimido no cache.
   */
  get sizeBytes(): number {
    return this.currentCacheBytes
  }

  /**
   * Quantidade de entradas armazenadas no cache.
   */
  get count(): number {
    return this.cache.size
  }

  /**
   * Alias de conveniência para count (compatibilidade).
   */
  get size(): number {
    return this.cache.size
  }

  /**
   * Iterador das chaves presentes no cache.
   */
  keys(): IterableIterator<string> {
    return this.cache.keys()
  }

  /**
   * Iterador dos valores presentes no cache.
   */
  values(): IterableIterator<CacheEntry> {
    return this.cache.values()
  }
}
