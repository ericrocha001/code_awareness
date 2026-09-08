/*
-T ---
*/

import { useState, useEffect, useRef, useCallback } from 'react'
import type { RefObject } from 'react'

/** Quantidade inicial de rows montadas na primeira renderização. */
const INITIAL_BATCH = 80

/** Quantidade de rows adicionadas a cada disparo do sentinel. */
const BATCH_SIZE = 80

export interface UseFileViewLazyMountParams {
  /** Quantidade total de arquivos na coleção. */
  totalCount: number
}

export interface UseFileViewLazyMountResult {
  /** Quantidade de rows atualmente montadas no DOM. */
  mountedCount: number
  /** Ref para o elemento sentinel que dispara o carregamento do próximo lote. */
  sentinelRef: RefObject<HTMLDivElement | null>
  /** Se ainda há rows a serem montadas. */
  hasMore: boolean
}

/**
 * Hook de lazy mount acumulativo para a FileView.
 *
 * Comportamento:
 * - Monta inicialmente até INITIAL_BATCH rows (ou todas, se totalCount < INITIAL_BATCH).
 * - Quando o sentinel entra na viewport (com rootMargin de 800px), monta o próximo lote de BATCH_SIZE.
 * - Lotes anteriores nunca desmontam — a rolagem rápida permanece suave.
 * - Quando totalCount muda (novo projeto, filtro, busca), reseta para min(INITIAL_BATCH, totalCount).
 *
 * Decisão arquitetural: implementado como hook (não classe) porque o padrão
 * React idiomático (state + IntersectionObserver) se expressa naturalmente assim.
 */
export function useFileViewLazyMount({
  totalCount,
}: UseFileViewLazyMountParams): UseFileViewLazyMountResult {
  const [mountedCount, setMountedCount] = useState(() => Math.min(INITIAL_BATCH, totalCount))
  const sentinelRef = useRef<HTMLDivElement>(null)
  // Sprint 5: ref espelha totalCount para eliminar stale closures no handleLoadMore.
  // Atualizado a cada render; lido no momento da chamada, não na criação.
  const totalCountRef = useRef(totalCount)
  totalCountRef.current = totalCount

  // Reset quando totalCount muda (novo projeto, filtro, busca)
  useEffect(() => {
    setMountedCount(Math.min(INITIAL_BATCH, totalCount))
  }, [totalCount])

  const hasMore = mountedCount < totalCount

  // Sprint 5: deps vazias — referência permanente. Lê totalCount via ref para usar
  // o valor mais recente. Com handleLoadMore estável, o useEffect do observer
  // [hasMore, handleLoadMore] só é recriado quando hasMore muda, eliminando a
  // recriação dupla do observer causada por mudanças de totalCount.
  const handleLoadMore = useCallback(() => {
    setMountedCount((prev) => Math.min(prev + BATCH_SIZE, totalCountRef.current))
  }, [])

  // IntersectionObserver no sentinel com rootMargin de 800px para pré-carregamento
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          handleLoadMore()
        }
      },
      { rootMargin: '800px 0px' }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, handleLoadMore])

  return { mountedCount, sentinelRef, hasMore }
}