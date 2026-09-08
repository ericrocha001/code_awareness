// @vitest-environment jsdom
/*
-T ---
*/

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFileCollectionSelection, UseFileCollectionSelectionParams } from './useFileCollectionSelection'
import type { FileCardFile } from './types'

describe('useFileCollectionSelection', () => {
  const sampleFiles: FileCardFile[] = [
    { relativePath: 'src/a.ts', name: 'a.ts', tokenEstimate: 100 },
    { relativePath: 'src/b.ts', name: 'b.ts', tokenEstimate: 200 },
    { relativePath: 'src/c.ts', name: 'c.ts', tokenEstimate: 300 }
  ]

  it('1. toggleFile adiciona um path não selecionado', () => {
    const onSelectionChange = vi.fn()
    const { result } = renderHook(() =>
      useFileCollectionSelection({
        selectedFiles: new Set<string>(),
        onSelectionChange,
        files: sampleFiles
      })
    )

    act(() => {
      result.current.toggleFile('src/a.ts')
    })

    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['src/a.ts']))
  })

  it('2. toggleFile remove um path já selecionado', () => {
    const onSelectionChange = vi.fn()
    const { result } = renderHook(() =>
      useFileCollectionSelection({
        selectedFiles: new Set(['src/a.ts']),
        onSelectionChange,
        files: sampleFiles
      })
    )

    act(() => {
      result.current.toggleFile('src/a.ts')
    })

    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    expect(onSelectionChange).toHaveBeenCalledWith(new Set())
  })

  it('3. toggleMaster seleciona todos quando nenhum está selecionado', () => {
    const onSelectionChange = vi.fn()
    const { result } = renderHook(() =>
      useFileCollectionSelection({
        selectedFiles: new Set<string>(),
        onSelectionChange,
        files: sampleFiles
      })
    )

    act(() => {
      result.current.toggleMaster()
    })

    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    expect(onSelectionChange).toHaveBeenCalledWith(
      new Set(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    )
  })

  it('4. toggleMaster desseleciona todos quando todos estão selecionados', () => {
    const onSelectionChange = vi.fn()
    const { result } = renderHook(() =>
      useFileCollectionSelection({
        selectedFiles: new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']),
        onSelectionChange,
        files: sampleFiles
      })
    )

    act(() => {
      result.current.toggleMaster()
    })

    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    expect(onSelectionChange).toHaveBeenCalledWith(new Set())
  })

  it('5. clearSelection limpa a seleção', () => {
    const onSelectionChange = vi.fn()
    const { result } = renderHook(() =>
      useFileCollectionSelection({
        selectedFiles: new Set(['src/a.ts', 'src/b.ts']),
        onSelectionChange,
        files: sampleFiles
      })
    )

    act(() => {
      result.current.clearSelection()
    })

    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    expect(onSelectionChange).toHaveBeenCalledWith(new Set())
  })

  it('6. isAllSelected retorna true quando todos estão selecionados', () => {
    const twoFiles: FileCardFile[] = [
      { relativePath: 'src/a.ts', name: 'a.ts' },
      { relativePath: 'src/b.ts', name: 'b.ts' }
    ]
    const { result } = renderHook(() =>
      useFileCollectionSelection({
        selectedFiles: new Set(['src/a.ts', 'src/b.ts']),
        onSelectionChange: vi.fn(),
        files: twoFiles
      })
    )

    expect(result.current.isAllSelected).toBe(true)
  })

  it('7. isAllSelected retorna false quando a lista está vazia', () => {
    const { result } = renderHook(() =>
      useFileCollectionSelection({
        selectedFiles: new Set(),
        onSelectionChange: vi.fn(),
        files: []
      })
    )

    expect(result.current.isAllSelected).toBe(false)
  })

  it('8. selectedCount retorna a contagem correta', () => {
    const { result } = renderHook(() =>
      useFileCollectionSelection({
        selectedFiles: new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']),
        onSelectionChange: vi.fn(),
        files: sampleFiles
      })
    )

    expect(result.current.selectedCount).toBe(3)
  })

  it('11. toggleFile mantém referência estável entre renders', () => {
    const onSelectionChange = vi.fn()
    const { result, rerender } = renderHook(
      (props: UseFileCollectionSelectionParams) => useFileCollectionSelection(props),
      {
        initialProps: {
          selectedFiles: new Set<string>(['src/a.ts']),
          onSelectionChange,
          files: sampleFiles
        }
      }
    )

    const initialToggleFile = result.current.toggleFile

    rerender({
      selectedFiles: new Set<string>(['src/b.ts', 'src/c.ts']),
      onSelectionChange,
      files: sampleFiles
    })

    expect(result.current.toggleFile).toBe(initialToggleFile)
  })

  it('12. toggleMaster mantém referência estável entre renders', () => {
    const onSelectionChange = vi.fn()
    const { result, rerender } = renderHook(
      (props: UseFileCollectionSelectionParams) => useFileCollectionSelection(props),
      {
        initialProps: {
          selectedFiles: new Set<string>(['src/a.ts']),
          onSelectionChange,
          files: sampleFiles
        }
      }
    )

    const initialToggleMaster = result.current.toggleMaster

    rerender({
      selectedFiles: new Set<string>(['src/b.ts']),
      onSelectionChange,
      files: sampleFiles
    })

    expect(result.current.toggleMaster).toBe(initialToggleMaster)
  })

  it('13. clearSelection mantém referência estável entre renders', () => {
    const onSelectionChange = vi.fn()
    const { result, rerender } = renderHook(
      (props: UseFileCollectionSelectionParams) => useFileCollectionSelection(props),
      {
        initialProps: {
          selectedFiles: new Set<string>(['src/a.ts']),
          onSelectionChange,
          files: sampleFiles
        }
      }
    )

    const initialClearSelection = result.current.clearSelection

    rerender({
      selectedFiles: new Set<string>(['src/a.ts', 'src/b.ts', 'src/c.ts']),
      onSelectionChange,
      files: sampleFiles
    })

    expect(result.current.clearSelection).toBe(initialClearSelection)
  })
})
