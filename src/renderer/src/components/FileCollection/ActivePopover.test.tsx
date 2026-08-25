// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a renderização condicional sob demanda de TagPopover e ActionMenu pelo ActivePopover.
2. Validar que quando activeInteraction for null, nenhum elemento é renderizado no DOM.
3. Validar o auto-fechamento (disparo de onClose) quando o anchor é null ou está desconectado do DOM.
4. Validar os disparos de ações contextuais (onHideFile, onRevealInExplorer, onCopyPath, onCopyName).

Mapa de Relacionamentos do Script

1. ActivePopover.tsx
   - Tipo: Dependência Direta
   - Relação: Componente sob teste.
   - Criticidade: Alta

2. @testing-library/react
   - Tipo: Dependência Direta
   - Relação: Fornece render, screen, fireEvent e cleanup para asserções de DOM.
   - Criticidade: Alta

Invariantes do Script

1. anchorRefs foi eliminado (Sprint 2) — o anchor vem exclusivamente de activeInteraction.anchor.
2. Cada ação do menu dispara o respectivo callback e em seguida invoca onClose.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ActivePopover, ActivePopoverProps } from './ActivePopover'
import { Tag } from '../../../../shared/types'

afterEach(() => {
  cleanup()
})

describe('ActivePopover', () => {
  const sampleTags: Tag[] = [
    { id: 'tag1', name: 'UI',   color: '#ff0000' },
    { id: 'tag2', name: 'Core', color: '#00ff00' }
  ]

  it('1. Não renderiza nada quando activeInteraction é null', () => {
    const { container } = render(
      <ActivePopover
        activeInteraction={null}
        onClose={vi.fn()}
        allTags={sampleTags}
        fileTagsMap={{}}
      />
    )

    expect(container.firstChild).toBeNull()
    expect(document.body.querySelector('.pop-root')).toBeNull()
  })

  it('2. Renderiza TagPopover quando activeInteraction.type === "tagPopover"', () => {
    const mockAnchor = document.createElement('div')
    document.body.appendChild(mockAnchor)

    render(
      <ActivePopover
        activeInteraction={{ type: 'tagPopover', relativePath: 'src/a.ts', anchor: mockAnchor }}
        onClose={vi.fn()}
        allTags={sampleTags}
        fileTagsMap={{ 'src/a.ts': ['tag1'] }}
      />
    )

    expect(document.querySelector('.tp-popover')).toBeDefined()
    expect(screen.getByPlaceholderText('Buscar tag...')).toBeDefined()
    expect(screen.getByText('UI')).toBeDefined()
  })

  it('3. Renderiza ActionMenu quando activeInteraction.type === "actionMenu"', () => {
    const mockAnchor = document.createElement('div')
    document.body.appendChild(mockAnchor)

    render(
      <ActivePopover
        activeInteraction={{ type: 'actionMenu', relativePath: 'src/a.ts', anchor: mockAnchor }}
        onClose={vi.fn()}
        allTags={sampleTags}
        fileTagsMap={{}}
        onHideFile={vi.fn()}
        onRevealInExplorer={vi.fn()}
        onCopyPath={vi.fn()}
        onCopyName={vi.fn()}
      />
    )

    expect(screen.getByRole('menu')).toBeDefined()
    expect(screen.getByRole('menuitem', { name: /ocultar/i })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: /revelar no sistema/i })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: /copiar caminho/i })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: /copiar nome/i })).toBeDefined()
  })

  it('4. Chama onClose quando o anchor é null (sem anchor na interação)', () => {
    const onClose = vi.fn()

    render(
      <ActivePopover
        activeInteraction={{ type: 'actionMenu', relativePath: 'src/missing.ts' }}
        onClose={onClose}
        allTags={sampleTags}
        fileTagsMap={{}}
      />
    )

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('5. onHideFile é chamado com o relativePath correto', () => {
    const mockAnchor = document.createElement('div')
    document.body.appendChild(mockAnchor)
    const onHideFile = vi.fn()
    const onClose = vi.fn()

    render(
      <ActivePopover
        activeInteraction={{ type: 'actionMenu', relativePath: 'src/a.ts', anchor: mockAnchor }}
        onClose={onClose}
        allTags={sampleTags}
        fileTagsMap={{}}
        onHideFile={onHideFile}
      />
    )

    fireEvent.click(screen.getByRole('menuitem', { name: /ocultar/i }))

    expect(onHideFile).toHaveBeenCalledWith('src/a.ts')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('6. onCopyPath é chamado com o relativePath correto', () => {
    const mockAnchor = document.createElement('div')
    document.body.appendChild(mockAnchor)
    const onCopyPath = vi.fn()
    const onClose = vi.fn()

    render(
      <ActivePopover
        activeInteraction={{ type: 'actionMenu', relativePath: 'src/utils/format.ts', anchor: mockAnchor }}
        onClose={onClose}
        allTags={sampleTags}
        fileTagsMap={{}}
        onCopyPath={onCopyPath}
      />
    )

    fireEvent.click(screen.getByRole('menuitem', { name: /copiar caminho/i }))

    expect(onCopyPath).toHaveBeenCalledWith('src/utils/format.ts')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('7. onCopyName é chamado com o nome do arquivo (basename)', () => {
    const mockAnchor = document.createElement('div')
    document.body.appendChild(mockAnchor)
    const onCopyName = vi.fn()
    const onClose = vi.fn()

    render(
      <ActivePopover
        activeInteraction={{ type: 'actionMenu', relativePath: 'src/components/Button.tsx', anchor: mockAnchor }}
        onClose={onClose}
        allTags={sampleTags}
        fileTagsMap={{}}
        onCopyName={onCopyName}
      />
    )

    fireEvent.click(screen.getByRole('menuitem', { name: /copiar nome/i }))

    expect(onCopyName).toHaveBeenCalledWith('Button.tsx')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('8. onClose é chamado após ação de revelar no sistema', () => {
    const mockAnchor = document.createElement('div')
    document.body.appendChild(mockAnchor)
    const onRevealInExplorer = vi.fn()
    const onClose = vi.fn()

    render(
      <ActivePopover
        activeInteraction={{ type: 'actionMenu', relativePath: 'src/a.ts', anchor: mockAnchor }}
        onClose={onClose}
        allTags={sampleTags}
        fileTagsMap={{}}
        onRevealInExplorer={onRevealInExplorer}
      />
    )

    fireEvent.click(screen.getByRole('menuitem', { name: /revelar no sistema/i }))

    expect(onRevealInExplorer).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('9. Chama onClose quando o anchor está desconectado do DOM', () => {
    // Elemento criado mas não adicionado ao document.body → isConnected === false
    const disconnectedAnchor = document.createElement('div')
    const onClose = vi.fn()

    render(
      <ActivePopover
        activeInteraction={{ type: 'actionMenu', relativePath: 'src/a.ts', anchor: disconnectedAnchor }}
        onClose={onClose}
        allTags={sampleTags}
        fileTagsMap={{}}
      />
    )

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
