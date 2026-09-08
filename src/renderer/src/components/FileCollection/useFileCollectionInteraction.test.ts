// @vitest-environment jsdom
/*
-T ---
*/

import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFileCollectionInteraction } from './useFileCollectionInteraction'

describe('useFileCollectionInteraction', () => {
  it('1. Estado inicial é null', () => {
    const { result } = renderHook(() => useFileCollectionInteraction())
    expect(result.current.activeInteraction).toBeNull()
  })

  it('2. openTagPopover abre interação do tipo tagPopover com anchor opcional', () => {
    const { result } = renderHook(() => useFileCollectionInteraction())
    const fakeAnchor = document.createElement('div')

    act(() => {
      result.current.openTagPopover('src/a.ts', fakeAnchor)
    })

    expect(result.current.activeInteraction).toEqual({
      type: 'tagPopover',
      relativePath: 'src/a.ts',
      anchor: fakeAnchor
    })
  })

  it('3. openActionMenu abre interação do tipo actionMenu com anchor opcional', () => {
    const { result } = renderHook(() => useFileCollectionInteraction())
    const fakeAnchor = document.createElement('button')

    act(() => {
      result.current.openActionMenu('src/b.ts', fakeAnchor)
    })

    expect(result.current.activeInteraction).toEqual({
      type: 'actionMenu',
      relativePath: 'src/b.ts',
      anchor: fakeAnchor
    })
  })

  it('4. closeInteraction fecha a interação', () => {
    const { result } = renderHook(() => useFileCollectionInteraction())

    act(() => {
      result.current.openTagPopover('src/a.ts')
    })
    expect(result.current.activeInteraction).not.toBeNull()

    act(() => {
      result.current.closeInteraction()
    })
    expect(result.current.activeInteraction).toBeNull()
  })

  it('5. Abrir TagPopover substitui ActionMenu aberto', () => {
    const { result } = renderHook(() => useFileCollectionInteraction())

    act(() => {
      result.current.openActionMenu('src/a.ts')
    })
    expect(result.current.activeInteraction?.type).toBe('actionMenu')

    act(() => {
      result.current.openTagPopover('src/b.ts')
    })
    expect(result.current.activeInteraction).toEqual({
      type: 'tagPopover',
      relativePath: 'src/b.ts'
    })
  })

  it('6. Abrir ActionMenu substitui TagPopover aberto', () => {
    const { result } = renderHook(() => useFileCollectionInteraction())

    act(() => {
      result.current.openTagPopover('src/a.ts')
    })
    expect(result.current.activeInteraction?.type).toBe('tagPopover')

    act(() => {
      result.current.openActionMenu('src/b.ts')
    })
    expect(result.current.activeInteraction).toEqual({
      type: 'actionMenu',
      relativePath: 'src/b.ts'
    })
  })

  it('7. openTagPopover mantém referência estável entre renders', () => {
    const { result, rerender } = renderHook(() => useFileCollectionInteraction())
    const initialOpenTagPopover = result.current.openTagPopover

    rerender()
    expect(result.current.openTagPopover).toBe(initialOpenTagPopover)
  })

  it('8. openActionMenu mantém referência estável entre renders', () => {
    const { result, rerender } = renderHook(() => useFileCollectionInteraction())
    const initialOpenActionMenu = result.current.openActionMenu

    rerender()
    expect(result.current.openActionMenu).toBe(initialOpenActionMenu)
  })

  it('9. closeInteraction mantém referência estável entre renders', () => {
    const { result, rerender } = renderHook(() => useFileCollectionInteraction())
    const initialCloseInteraction = result.current.closeInteraction

    rerender()
    expect(result.current.closeInteraction).toBe(initialCloseInteraction)
  })
})
