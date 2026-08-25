/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Centralizar a montagem sob demanda de TagPopover e ActionMenu para toda a coleção de arquivos.
2. Posicionar o balão ativo utilizando o elemento âncora registrado no mapa de refs.
3. Executar o auto-fechamento da interação quando o item associado sair do viewport ou não possuir nó DOM válido.

Mapa de Relacionamentos do Script

1. types.ts
   - Tipo: Contrato / Interface
   - Relação: Importa a interface ActiveInteraction.
   - Criticidade: Alta

2. ../shared/Popover/Popover.tsx
   - Tipo: Dependência Direta
   - Relação: Utilizado para posicionamento em portal do menu de ações sob demanda.
   - Criticidade: Alta

3. ../shared/TagPopover/TagPopover.tsx
   - Tipo: Dependência Direta
   - Relação: Renderizado em modo controlado quando activeInteraction for do tipo 'tagPopover'.
   - Criticidade: Alta

4. ActivePopover.css
   - Tipo: Relação de UI
   - Relação: Fornece estilização para o menu de ações do popover.
   - Criticidade: Média

Invariantes do Script

1. Quando activeInteraction for null, nada é renderizado no DOM (retorna null).
2. Apenas uma única interação (TagPopover ou ActionMenu) é montada por vez.
3. Se o elemento âncora do item ativo não existir no mapa de refs, onClose é disparado automaticamente para evitar popovers órfãos.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useEffect } from 'react'
import { EyeOff, FolderOpen, Copy } from 'lucide-react'
import { Tag } from '../../../../shared/types'
import { Popover } from '../shared/Popover/Popover'
import { TagPopover } from '../shared/TagPopover/TagPopover'
import type { ActiveInteraction } from './types'
import './ActivePopover.css'

export interface ActivePopoverProps {
  activeInteraction: ActiveInteraction | null
  onClose: () => void

  // Props repassadas para TagPopover
  allTags: Tag[]
  fileTagsMap: Record<string, string[]>
  onTagsChanged?: () => void
  onOpenTagManager?: () => void
  repoPath?: string

  // Props repassadas para ActionMenu items
  onHideFile?: (relativePath: string) => void
  onRevealInExplorer?: (relativePath: string) => void
  onCopyPath?: (relativePath: string) => void
  onCopyName?: (name: string) => void
}

export const ActivePopover: React.FC<ActivePopoverProps> = ({
  activeInteraction,
  onClose,
  allTags,
  fileTagsMap,
  onTagsChanged,
  onOpenTagManager,
  repoPath,
  onHideFile,
  onRevealInExplorer,
  onCopyPath,
  onCopyName
}) => {
  const anchorElement = activeInteraction?.anchor ?? null

  // Auto-fechamento quando o anchor não existe no DOM ou está desconectado do DOM (ex.: item saiu do viewport)
  useEffect(() => {
    if (activeInteraction) {
      if (!anchorElement || !anchorElement.isConnected) {
        onClose()
      }
    }
  }, [activeInteraction, anchorElement, onClose])

  if (!activeInteraction || !anchorElement || !anchorElement.isConnected) {
    return null
  }

  const anchorRef: React.RefObject<HTMLElement> = { current: anchorElement }

  if (activeInteraction.type === 'tagPopover') {
    return (
      <TagPopover
        repoPath={repoPath}
        relativePath={activeInteraction.relativePath}
        allTags={allTags}
        activeTagIds={fileTagsMap[activeInteraction.relativePath] ?? []}
        onTagsChanged={onTagsChanged}
        onOpenTagManager={onOpenTagManager}
        anchorRef={anchorRef}
        onClose={onClose}
      />
    )
  }

  if (activeInteraction.type === 'actionMenu') {
    const normalizedPath = activeInteraction.relativePath.replace(/\\/g, '/')
    const fileName = normalizedPath.split('/').pop() ?? ''

    return (
      <Popover
        open={true}
        anchorRef={anchorRef}
        onClose={onClose}
        placement="auto-end"
      >
        <div className="active-popover-menu" role="menu" aria-label="Opções do arquivo">
          {onHideFile && (
            <button
              onClick={() => {
                onHideFile(activeInteraction.relativePath)
                onClose()
              }}
              role="menuitem"
            >
              <EyeOff size={14} strokeWidth={2} /> Ocultar
            </button>
          )}
          {onRevealInExplorer && (
            <button
              onClick={() => {
                onRevealInExplorer(activeInteraction.relativePath)
                onClose()
              }}
              role="menuitem"
            >
              <FolderOpen size={14} strokeWidth={2} /> Revelar no Sistema
            </button>
          )}
          {onCopyPath && (
            <button
              onClick={() => {
                onCopyPath(activeInteraction.relativePath)
                onClose()
              }}
              role="menuitem"
            >
              <Copy size={14} strokeWidth={2} /> Copiar Caminho
            </button>
          )}
          {onCopyName && (
            <button
              onClick={() => {
                onCopyName(fileName)
                onClose()
              }}
              role="menuitem"
            >
              <Copy size={14} strokeWidth={2} /> Copiar Nome
            </button>
          )}
        </div>
      </Popover>
    )
  }

  return null
}
