/*
-T ---
*/

import { useState, useCallback } from 'react'
import type { ActiveInteraction, FileCollectionInteractionResult } from './types'

export function useFileCollectionInteraction(): FileCollectionInteractionResult {
  const [activeInteraction, setActiveInteraction] = useState<ActiveInteraction | null>(null)

  const openTagPopover = useCallback((relativePath: string, anchor?: HTMLElement) => {
    setActiveInteraction({ type: 'tagPopover', relativePath, anchor })
  }, [])

  const openActionMenu = useCallback((relativePath: string, anchor?: HTMLElement) => {
    setActiveInteraction({ type: 'actionMenu', relativePath, anchor })
  }, [])

  const closeInteraction = useCallback(() => {
    setActiveInteraction(null)
  }, [])

  return {
    activeInteraction,
    openTagPopover,
    openActionMenu,
    closeInteraction
  }
}
