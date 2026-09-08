// @vitest-environment jsdom
/*
-T ---
*/

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
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

  // PA-R01 — TagPopover permanece aberto ao alternar tag (contrato de multi-seleção).
  // Regressão: o orquestrador fechava a interação em handleTagsChanged, encerrando
  // o popover após a primeira tag selecionada.
  it('10. mantém o popover aberto ao clicar em uma tag, permitindo multi-seleção', async () => {
    const tags: Tag[] = [
      { id: 'tag-1', name: 'Importante', color: '#ff0000' },
      { id: 'tag-2', name: 'Revisar', color: '#00ff00' },
      { id: 'tag-3', name: 'Bug', color: '#0000ff' }
    ]
    const fileTagsMap: Record<string, string[]> = { 'src/file.ts': [] }
    const onClose = vi.fn()
    const onTagsChanged = vi.fn()

    const anchor = document.createElement('button')
    Object.defineProperty(anchor, 'isConnected', { value: true })
    document.body.appendChild(anchor)

    const setFileTag = vi.fn().mockResolvedValue({ success: true })
    ;(window as any).codeAwareness = {
      ...(window as any).codeAwareness,
      setFileTag,
      removeFileTag: vi.fn().mockResolvedValue({ success: true })
    }

    render(
      <ActivePopover
        activeInteraction={{ type: 'tagPopover', relativePath: 'src/file.ts', anchor }}
        onClose={onClose}
        allTags={tags}
        fileTagsMap={fileTagsMap}
        onTagsChanged={onTagsChanged}
        repoPath="/repo"
      />
    )

    // Popover aberto antes da interação
    expect(screen.getByPlaceholderText('Buscar tag...')).toBeTruthy()

    // Clica na primeira tag — persiste via IPC e notifica, sem fechar
    fireEvent.click(screen.getByText('Importante'))
    await waitFor(() => {
      expect(setFileTag).toHaveBeenCalledWith('/repo', 'src/file.ts', 'tag-1')
    })
    expect(onTagsChanged).toHaveBeenCalled()

    // CONTRATO: onClose NÃO deve ser chamado após selecionar tag
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('Buscar tag...')).toBeTruthy()

    document.body.removeChild(anchor)
  })
})
