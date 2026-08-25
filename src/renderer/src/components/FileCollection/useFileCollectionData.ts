/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Pré-resolver a paleta de cores das tags da coleção (tagRenderMap) uma vez por tema/coleção.
2. Pré-resolver as tags de cada arquivo (tagsByFile), mapeando relativePath → TagRenderData[].
3. Pré-computar o mapa de tokens por arquivo (tokenEstimateMap).

Mapa de Relacionamentos do Script

1. FileCollectionView.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome o hook e repassa tagsByFile ao FileView e tokenEstimateMap para métricas.
   - Criticidade: Alta

2. models/FileRowModel.ts
   - Tipo: Contrato / Interface
   - Relação: Produz TagRenderData[] consumido pelo FileRow via prop tags.
   - Criticidade: Alta

3. ../../utils/color-utils.ts
   - Tipo: Dependência Direta
   - Relação: resolveTagPalette resolve background/text por tema.
   - Criticidade: Alta

Invariantes do Script

1. tagsByFile.get(path) retorna referência estável entre renders para o mesmo conteúdo — arquivos sem tags retornam EMPTY_TAGS (referência constante), preservando o comparador do FileRow.
2. tagRenderMap é memoizado por [allTags, effectiveTheme]; tagsByFile por [files, fileTagsMap, tagRenderMap]; tokenEstimateMap por [files].

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { useMemo } from 'react'
import type { Tag } from '../../../../shared/types'
import { resolveTagPalette } from '../../utils/color-utils'
import type { TagRenderData } from './models/FileRowModel'
import type { FileCardFile } from './types'

export interface UseFileCollectionDataParams {
  files: FileCardFile[]
  allTags: Tag[]
  fileTagsMap: Record<string, string[]>
  effectiveTheme: 'light' | 'dark'
}

export interface UseFileCollectionDataResult {
  /** Paleta pré-resolvida por id de tag. */
  tagRenderMap: Map<string, TagRenderData>
  /** Tags pré-resolvidas por relativePath — prontas para injeção no FileRow. */
  tagsByFile: Map<string, readonly TagRenderData[]>
  /** Tokens por relativePath. */
  tokenEstimateMap: Map<string, number>
}

/** Referência estável para arquivos sem tags — preserva o comparador do FileRow. */
const EMPTY_TAGS: readonly TagRenderData[] = []

/**
 * Hook centralizador da preparação de dados da coleção: paleta de tags,
 * tags por arquivo e tokens por arquivo — eliminando resolução inline
 * no render do FileView e lógica de dados do selection hook.
 */
export function useFileCollectionData({
  files,
  allTags,
  fileTagsMap,
  effectiveTheme
}: UseFileCollectionDataParams): UseFileCollectionDataResult {
  // Paleta de cada tag resolvida UMA VEZ por coleção/tema.
  // Com 10 tags e 200 arquivos, são 10 chamadas em vez de 2000.
  const tagRenderMap = useMemo(() => {
    const map = new Map<string, TagRenderData>()
    for (const tag of allTags) {
      const palette = resolveTagPalette(tag.color, effectiveTheme)
      map.set(tag.id, {
        id: tag.id,
        name: tag.name,
        background: palette.background,
        text: palette.text,
      })
    }
    return map
  }, [allTags, effectiveTheme])

  const tagsByFile = useMemo(() => {
    const map = new Map<string, readonly TagRenderData[]>()
    for (const file of files) {
      const ids = fileTagsMap[file.relativePath]
      if (!ids || ids.length === 0) {
        map.set(file.relativePath, EMPTY_TAGS)
        continue
      }
      const resolved = ids
        .map((id) => tagRenderMap.get(id))
        .filter((t): t is TagRenderData => !!t)
      map.set(file.relativePath, resolved.length > 0 ? resolved : EMPTY_TAGS)
    }
    return map
  }, [files, fileTagsMap, tagRenderMap])

  const tokenEstimateMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const file of files) {
      map.set(file.relativePath, file.tokenEstimate ?? 0)
    }
    return map
  }, [files])

  return { tagRenderMap, tagsByFile, tokenEstimateMap }
}