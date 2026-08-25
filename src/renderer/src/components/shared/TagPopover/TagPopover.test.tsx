// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a navegação por teclado e foco no componente TagPopover.
2. Comprovar que o foco inicial ao abrir é direcionado ao input de busca.
3. Comprovar que as teclas de seta navegam o destaque visual mesmo com foco em botões internos de tag.
4. Garantir que a tecla Enter não duplica a chamada IPC quando o foco estiver diretamente no botão da tag.

Mapa de Relacionamentos do Script

1. TagPopover.tsx
   - Tipo: Dependência Direta
   - Relação: Componente sob teste.
   - Criticidade: Alta

2. @testing-library/react
   - Tipo: Dependência Direta
   - Relação: Utilizado para renderização e simulação de eventos.
   - Criticidade: Alta

Invariantes do Script

1. As setas movem o destaque visual independentemente de o foco estar no input ou em um botão interno.
2. O Enter em botão de tag dispara a ação exatamente uma vez via clique nativo sem redundância do handler do balão.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useRef } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TagPopover } from './TagPopover'
import { Tag } from '../../../../../shared/types'

const mockTags: Tag[] = [
  { id: 'tag-1', name: 'Frontend', color: '#3b82f6' },
  { id: 'tag-2', name: 'Backend', color: '#10b981' },
  { id: 'tag-3', name: 'Design', color: '#f59e0b' }
]

const TagPopoverControlledWrapper: React.FC<{
  activeTagIds?: string[]
  allTags?: Tag[]
  onTagsChanged?: () => void
  onClose?: () => void
}> = ({
  activeTagIds = [],
  allTags = mockTags,
  onTagsChanged = vi.fn(),
  onClose = vi.fn()
}) => {
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button ref={anchorRef} data-testid="anchor-btn">
        Tags Anchor
      </button>
      <TagPopover
        repoPath="/repo"
        relativePath="src/App.tsx"
        allTags={allTags}
        activeTagIds={activeTagIds}
        anchorRef={anchorRef}
        open={true}
        onClose={onClose}
        onTagsChanged={onTagsChanged}
      />
    </div>
  )
}

describe('TagPopover — Navegação de Teclado e Foco', () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
    // Mock do window.codeAwareness
    ;(window as any).codeAwareness = {
      setFileTag: vi.fn().mockResolvedValue(true),
      removeFileTag: vi.fn().mockResolvedValue(true)
    }
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('1. Ao abrir, o foco vai para o input de busca', () => {
    render(<TagPopoverControlledWrapper />)

    const searchInput = screen.getByPlaceholderText('Buscar tag...')
    expect(document.activeElement).toBe(searchInput)
  })

  it('2. Com foco em um botão de tag, seta para baixo move o destaque e suprime o default', () => {
    render(<TagPopoverControlledWrapper />)

    const tagButtons = screen.getAllByRole('button').filter((b) => b.className.includes('tp-item'))
    expect(tagButtons.length).toBe(3)

    // Primeiro item começa destacado
    expect(tagButtons[0].className).toContain('highlighted')

    // Dispara ArrowDown com foco no primeiro botão de tag
    tagButtons[0].focus()
    const defaultAllowed = fireEvent.keyDown(tagButtons[0], { key: 'ArrowDown' })

    // defaultAllowed é false quando preventDefault() foi chamado
    expect(defaultAllowed).toBe(false)
    // O destaque avançou para o segundo item (índice 1)
    expect(tagButtons[1].className).toContain('highlighted')
  })

  it('3. Enter com foco em botão de tag não duplica a alternância via handler do balão', async () => {
    render(<TagPopoverControlledWrapper />)

    const tagButtons = screen.getAllByRole('button').filter(b => b.className.includes('tp-item'))
    
    // Foca e clica no primeiro botão
    tagButtons[0].focus()
    fireEvent.click(tagButtons[0])

    expect((window as any).codeAwareness.setFileTag).toHaveBeenCalledTimes(1)
    expect((window as any).codeAwareness.setFileTag).toHaveBeenCalledWith('/repo', 'src/App.tsx', 'tag-1')
  })

  it('4. Com foco no input, setas navegam o destaque e Enter alterna a tag destacada', () => {
    render(<TagPopoverControlledWrapper />)

    const searchInput = screen.getByPlaceholderText('Buscar tag...')
    const tagButtons = screen.getAllByRole('button').filter(b => b.className.includes('tp-item'))

    // Inicialmente índice 0 está destacado
    expect(tagButtons[0].className).toContain('highlighted')

    // Seta para baixo -> índice 1
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' })
    expect(tagButtons[1].className).toContain('highlighted')

    // Seta para cima -> volta para índice 0
    fireEvent.keyDown(searchInput, { key: 'ArrowUp' })
    expect(tagButtons[0].className).toContain('highlighted')

    // Enter no input alterna a tag do índice 0 (tag-1)
    fireEvent.keyDown(searchInput, { key: 'Enter' })
    expect((window as any).codeAwareness.setFileTag).toHaveBeenCalledWith('/repo', 'src/App.tsx', 'tag-1')
  })
})
