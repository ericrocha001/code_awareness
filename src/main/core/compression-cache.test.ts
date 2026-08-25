/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a política de evicção LRU por consumo de memória em bytes no CompressionCache.
2. Validar a política de evicção LRU por contagem máxima de entradas no CompressionCache.
3. Validar a atualização de recenticidade através do método touch no CompressionCache.
4. Validar o recálculo do saldo de memória em atualizações de chaves existentes.
5. Validar a rejeição de entradas individuais que excedam o limite de bytes, mesmo com cache vazio.

Mapa de Relacionamentos do Script

1. compression-cache.ts
   - Tipo: Dependência Direta
   - Relação: Testa a classe CompressionCache e a conformidade da interface CacheEntry.
   - Criticidade: Alta

Invariantes do Script

1. Testes puramente determinísticos em memória, sem acesso ao filesystem, spawn de processos ou estado externo.
2. O cálculo de sizeBytes é verificado fielmente através de Buffer.byteLength.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect } from 'vitest'
import { CompressionCache, CacheEntry } from './compression-cache'

function makeEntry(sizeInBytes: number, contentHash = 'hash-default'): CacheEntry {
  const content = 'x'.repeat(sizeInBytes)
  return {
    mtime: 1000,
    size: 500,
    contentHash,
    compressedContent: content,
    sizeBytes: Buffer.byteLength(content, 'utf-8'),
    lastAccessed: Date.now()
  }
}

describe('CompressionCache — Provas de Aceitação Isoladas', () => {
  // PA-C01 — Evicção por bytes
  describe('PA-C01 — Evicção por bytes', () => {
    it('evicção por bytes: insere 3 entradas de 100KB com limite de 250KB → mantém 2', () => {
      const cache = new CompressionCache(250 * 1024, 100) // 250KB, até 100 entradas
      cache.set('a', makeEntry(100 * 1024))
      cache.set('b', makeEntry(100 * 1024))
      cache.set('c', makeEntry(100 * 1024)) // 300KB > 250KB → deve evictar 'a'

      expect(cache.count).toBe(2)
      expect(cache.has('a')).toBe(false)
      expect(cache.has('b')).toBe(true)
      expect(cache.has('c')).toBe(true)
      expect(cache.sizeBytes).toBe(200 * 1024)
    })
  })

  // PA-C02 — Evicção por contagem
  describe('PA-C02 — Evicção por contagem', () => {
    it('evicção por contagem: insere 6 entradas com limite de 5 → mantém 5', () => {
      const cache = new CompressionCache(10 * 1024 * 1024, 5) // 10MB, até 5 entradas
      for (let i = 0; i < 6; i++) {
        cache.set(`key-${i}`, makeEntry(1024)) // 1KB cada
      }

      expect(cache.count).toBe(5)
      expect(cache.has('key-0')).toBe(false) // mais antiga evictada
      expect(cache.has('key-5')).toBe(true)  // mais recente presente
    })
  })

  // PA-C03 — Touch preserva entrada recente
  describe('PA-C03 — Touch preserva entrada recente', () => {
    it('touch preserva entrada recente: toca entrada antiga, insere nova, antiga permanece', () => {
      const cache = new CompressionCache(10 * 1024 * 1024, 3)
      cache.set('a', makeEntry(1024))
      cache.set('b', makeEntry(1024))
      cache.set('c', makeEntry(1024))

      cache.touch('a') // 'a' vira a mais recente

      cache.set('d', makeEntry(1024)) // deve evictar 'b' (agora a mais antiga)

      expect(cache.has('a')).toBe(true)  // preservada pelo touch
      expect(cache.has('b')).toBe(false) // evictada
      expect(cache.has('c')).toBe(true)
      expect(cache.has('d')).toBe(true)
    })
  })

  // PA-C04 — Atualização de chave existente recalcula bytes
  describe('PA-C04 — Atualização de chave existente recalcula bytes', () => {
    it('atualização de chave existente recalcula bytes: insere 100KB, atualiza para 50KB, sizeBytes correto', () => {
      const cache = new CompressionCache(10 * 1024 * 1024, 100)
      cache.set('a', makeEntry(100 * 1024)) // 100KB
      expect(cache.sizeBytes).toBe(100 * 1024)

      cache.set('a', makeEntry(50 * 1024)) // atualiza para 50KB
      expect(cache.sizeBytes).toBe(50 * 1024) // recalculado corretamente
      expect(cache.count).toBe(1) // não duplicou
    })
  })

  // PA-C05 — Rejeição de entrada maior que o limite com cache vazio
  describe('PA-C05 — Rejeição de entrada maior que o limite com cache vazio', () => {
    it('rejeita entrada de 150B em cache com limite 100B e mantém cache íntegro após inserção válida', () => {
      const cache = new CompressionCache(100, 10) // limite de 100 bytes

      cache.set('oversized', makeEntry(150)) // 150B > 100B → rejeitada
      expect(cache.count).toBe(0)
      expect(cache.sizeBytes).toBe(0)

      cache.set('valid', makeEntry(50)) // 50B → aceita
      expect(cache.count).toBe(1)
      expect(cache.sizeBytes).toBe(50)
    })
  })
})
