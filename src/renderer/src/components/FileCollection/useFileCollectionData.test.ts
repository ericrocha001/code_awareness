// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a preparação de dados do hook useFileCollectionData (tagRenderMap, tagsByFile, tokenEstimateMap).
2. Validar a resolução de paleta por tema e o fallback EMPTY_TAGS (referência estável) para arquivos sem tags.
3. Validar memoização: mudanças em allTags/tema reconstroem a paleta; arquivos não afetados mantêm referência.

Mapa de Relacionamentos do Script

1. useFileCollectionData.ts
   - Tipo: Dependência Direta
   - Relação: Hook sob teste.
   - Criticidade: Alta

2. @testing-library/react
   - Tipo: Dependência Direta
   - Relação: renderHook e cleanup para exercitar o hook em ambiente jsdom.
   - Criticidade: Alta

Invariantes do Script

1. tagsByFile.get(path) retorna a MESMA referência entre renders quando as dependências não mudam — preserva o comparador do FileRow.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useFileCollectionData } from './useFileCollectionData'
import type { FileCardFile } from './types'
import type { Tag } from '../../../../shared/types'

describe('useFileCollectionData', () => {
  const files: FileCardFile[] = [
    { relativePath: 'src/a.ts', name: 'a.ts', tokenEstimate: 100 },
    { relativePath: 'src/b.ts', name: 'b.ts' }
  ]

  const allTags: Tag[] = [
    { id: 't1', name: 'UI', color: '#ff0000' },
    { id: 't2', name: 'Core', color: '#00ff00' }
  ]

  const baseParams = {
    files,
    allTags,
    fileTagsMap: { 'src/a.ts': ['t1', 'desconhecida'] } as Record<string, string[]>,
    effectiveTheme: 'dark' as const
  }

  it('1. tagRenderMap resolve paleta de todas as tags', () => {
    const { result } = renderHook(() => useFileCollectionData(baseParams))

    expect(result.current.tagRenderMap.size).toBe(2)
    const ui = result.current.tagRenderMap.get('t1')!
    expect(ui.id).toBe('t1')
    expect(ui.name).toBe('UI')
    expect(ui.background).toBeTruthy()
    expect(ui.text).toBeTruthy()
  })

  it('2. tagsByFile resolve apenas ids existentes no tagRenderMap', () => {
    const { result } = renderHook(() => useFileCollectionData(baseParams))

    const resolved = result.current.tagsByFile.get('src/a.ts')!
    expect(resolved).toHaveLength(1)
    expect(resolved[0].id).toBe('t1')
  })

  it('3. arquivo sem tags recebe EMPTY_TAGS (referência estável)', () => {
    const { result, rerender } = renderHook(
      (params: typeof baseParams) => useFileCollectionData(params),
      { initialProps: baseParams }
    )

    const emptyA = result.current.tagsByFile.get('src/b.ts')!
    expect(emptyA).toHaveLength(0)

    rerender({ ...baseParams })
    // Mesmo conteúdo e mesma referência — preserva o comparador do FileRow.
    expect(result.current.tagsByFile.get('src/b.ts')).toBe(emptyA)
  })

  it('4. tokenEstimateMap mapeia relativePath → tokenEstimate com default 0', () => {
    const { result } = renderHook(() => useFileCollectionData(baseParams))

    expect(result.current.tokenEstimateMap.get('src/a.ts')).toBe(100)
    expect(result.current.tokenEstimateMap.get('src/b.ts')).toBe(0)
  })

  it('5. mudança de tema reconstrói tagRenderMap com nova paleta', () => {
    const { result, rerender } = renderHook(
      (params: typeof baseParams) => useFileCollectionData(params),
      { initialProps: baseParams }
    )

    const darkBg = result.current.tagRenderMap.get('t1')!.background
    rerender({ ...baseParams, effectiveTheme: 'light' })
    const lightBg = result.current.tagRenderMap.get('t1')!.background

    expect(lightBg).not.toBe(darkBg)
  })

  it('6. render sem mutação de deps preserva referências de tagsByFile', () => {
    const { result, rerender } = renderHook(
      (params: typeof baseParams) => useFileCollectionData(params),
      { initialProps: baseParams }
    )

    const before = result.current.tagsByFile.get('src/a.ts')
    rerender({ ...baseParams })

    expect(result.current.tagsByFile.get('src/a.ts')).toBe(before)
  })
})
