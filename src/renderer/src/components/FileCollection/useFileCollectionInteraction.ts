/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerenciar o estado da interação contextual ativa (TagPopover ou ActionMenu) na coleção de arquivos.
2. Garantir o padrão de interação única ativa (single active interaction), substituindo qualquer interação anterior ao abrir uma nova.
3. Fornecer callbacks estáveis para abertura e fechamento de interações.

Mapa de Relacionamentos do Script

1. types.ts
   - Tipo: Contrato / Interface
   - Relação: Importa ActiveInteraction e FileCollectionInteractionResult.
   - Criticidade: Alta

2. FileGrid / FileDense / ActivePopover (componentes consumidores)
   - Tipo: Dependência Inversa
   - Relação: Consomem o hook para coordenar a abertura e fechamento exclusivo de popovers e menus contextuais.
   - Criticidade: Alta

Invariantes do Script

1. No máximo uma interação pode estar ativa por vez (activeInteraction é um único objeto ou null).
2. Os callbacks openTagPopover, openActionMenu e closeInteraction possuem referências permanentemente estáveis entre renders.

--- FIM ARQUITETURA DO SCRIPT ---
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
