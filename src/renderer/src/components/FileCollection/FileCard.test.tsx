// @vitest-environment jsdom
/*
-T ---
*/

import React from 'react'
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { FileCard, FileCardProps } from '../FileCard/FileCard'
import type { FileCardFile } from './types'
import { Tag } from '../../../../shared/types'

// Mock parcial de lucide-react: cada ícone renderiza um svg com testid distinto,
// permitindo provar qual glifo (horizontal vs vertical) é renderizado (R-B5).
// O mock é hoisted por arquivo de teste e não vaza entre suítes.
vi.mock('lucide-react', () => {
  const make = (name: string) => {
    const Comp = () =>
      React.createElement('svg', { 'data-testid': `lucide-${String(name)}` })
    Comp.displayName = String(name)
    return Comp
  }
  return {
    MoreHorizontal: make('MoreHorizontal'),
    MoreVertical: make('MoreVertical'),
    Plus: make('Plus')
  }
})

// TagChip usa useTheme que chama matchMedia internamente no jsdom
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  })
})

afterEach(() => {
  cleanup()
})

describe('FileCard', () => {
  const sampleFile: FileCardFile = {
    relativePath: 'src/components/Button.tsx',
    name: 'Button.tsx',
    tokenEstimate: 1200,
    changeType: 'modified'
  }

  const sampleTags: Tag[] = [
    { id: 'tag1', name: 'UI', color: '#ff0000' },
    { id: 'tag2', name: 'Core', color: '#00ff00' }
  ]

  it('1. Renderiza nome, caminho e tokens', () => {
    render(
      <FileCard
        file={sampleFile}
        allTags={sampleTags}
        fileTagIds={['tag1']}
        isSelected={false}
        onToggle={vi.fn()}
        onTagInteraction={vi.fn()}
        onActionInteraction={vi.fn()}
      />
    )

    expect(screen.getByText('Button.tsx')).toBeDefined()
    expect(screen.getByText('src/components/')).toBeDefined()
    // TokenBadge renderiza count e label em spans separados
    expect(screen.getByText('1.200')).toBeDefined()
    expect(screen.getByText('tokens')).toBeDefined()
    expect(screen.getByText('M')).toBeDefined()
  })

  it('2. onToggle é chamado ao clicar no toggle', () => {
    const onToggle = vi.fn()
    render(
      <FileCard
        file={sampleFile}
        allTags={sampleTags}
        fileTagIds={[]}
        isSelected={false}
        onToggle={onToggle}
        onTagInteraction={vi.fn()}
        onActionInteraction={vi.fn()}
      />
    )

    const toggle = screen.getByRole('switch')
    fireEvent.click(toggle)

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('3. onTagInteraction é chamado ao clicar na área de tags', () => {
    const onTagInteraction = vi.fn()
    render(
      <FileCard
        file={sampleFile}
        allTags={sampleTags}
        fileTagIds={['tag1']}
        isSelected={false}
        onToggle={vi.fn()}
        onTagInteraction={onTagInteraction}
        onActionInteraction={vi.fn()}
      />
    )

    const tagsContainer = screen.getByTestId('file-card-tags')
    fireEvent.click(tagsContainer)

    expect(onTagInteraction).toHaveBeenCalledTimes(1)
    expect(onTagInteraction).toHaveBeenCalledWith(tagsContainer)
  })

  it('4. onActionInteraction é chamado ao clicar no botão de ações com o elemento clicado', () => {
    const onActionInteraction = vi.fn()
    render(
      <FileCard
        file={sampleFile}
        allTags={sampleTags}
        fileTagIds={[]}
        isSelected={false}
        onToggle={vi.fn()}
        onTagInteraction={vi.fn()}
        onActionInteraction={onActionInteraction}
      />
    )

    const actionButton = screen.getByRole('button', { name: /ações do arquivo/i })
    fireEvent.click(actionButton)

    expect(onActionInteraction).toHaveBeenCalledTimes(1)
    expect(onActionInteraction).toHaveBeenCalledWith(actionButton)
  })

  it('5. Não renderiza Popover nem TagPopover no DOM', () => {
    const { container } = render(
      <FileCard
        file={sampleFile}
        allTags={sampleTags}
        fileTagIds={['tag1']}
        isSelected={false}
        onToggle={vi.fn()}
        onTagInteraction={vi.fn()}
        onActionInteraction={vi.fn()}
      />
    )

    expect(container.querySelector('.pop-root')).toBeNull()
    expect(container.querySelector('.tp-popover')).toBeNull()
    expect(document.querySelector('.pop-root')).toBeNull()
    expect(document.querySelector('.tp-popover')).toBeNull()
  })

  it('6. Resolve tags via fileTagIds + allTags quando tags não é fornecido', () => {
    render(
      <FileCard
        file={sampleFile}
        allTags={[{ id: 'tag1', name: 'UI', color: '#ff0000' }]}
        fileTagIds={['tag1']}
        isSelected={false}
        onToggle={vi.fn()}
        onTagInteraction={vi.fn()}
        onActionInteraction={vi.fn()}
      />
    )

    expect(screen.getByText('UI')).toBeDefined()
  })

  it('7. Usa tags legado quando fornecido (compatibilidade)', () => {
    render(
      <FileCard
        file={sampleFile}
        tags={[{ id: 't1', name: 'Legacy', color: '#0000ff' }]}
        allTags={[]}
        isSelected={false}
        onToggle={vi.fn()}
        onTagInteraction={vi.fn()}
        onActionInteraction={vi.fn()}
      />
    )

    expect(screen.getByText('Legacy')).toBeDefined()
  })

  it('8. React.memo: não re-renderiza com props inalteradas', () => {
    const onRender = vi.fn()
    const onToggle = vi.fn()
    const onTagInteraction = vi.fn()
    const onActionInteraction = vi.fn()

    const initialProps: FileCardProps = {
      file: sampleFile,
      allTags: sampleTags,
      fileTagIds: ['tag1'],
      isSelected: false,
      onToggle,
      onTagInteraction,
      onActionInteraction,
      onRender
    }

    const { rerender } = render(<FileCard {...initialProps} />)
    expect(onRender).toHaveBeenCalledTimes(1)

    // Re-renderiza com as mesmas referências de props
    rerender(<FileCard {...initialProps} />)
    expect(onRender).toHaveBeenCalledTimes(1)
  })

  it('9. React.memo: re-renderiza quando isSelected muda', () => {
    const onRender = vi.fn()
    const onToggle = vi.fn()
    const onTagInteraction = vi.fn()
    const onActionInteraction = vi.fn()

    const props: FileCardProps = {
      file: sampleFile,
      allTags: sampleTags,
      fileTagIds: ['tag1'],
      isSelected: false,
      onToggle,
      onTagInteraction,
      onActionInteraction,
      onRender
    }

    const { rerender } = render(<FileCard {...props} />)
    expect(onRender).toHaveBeenCalledTimes(1)

    rerender(<FileCard {...props} isSelected={true} />)
    expect(onRender).toHaveBeenCalledTimes(2)
  })

  it('10. React.memo: re-renderiza quando fileTagIds muda', () => {
    const onRender = vi.fn()
    const onToggle = vi.fn()
    const onTagInteraction = vi.fn()
    const onActionInteraction = vi.fn()

    const initialTagIds = ['tag1']
    const newTagIds = ['tag1', 'tag2']

    const props: FileCardProps = {
      file: sampleFile,
      allTags: sampleTags,
      fileTagIds: initialTagIds,
      isSelected: false,
      onToggle,
      onTagInteraction,
      onActionInteraction,
      onRender
    }

    const { rerender } = render(<FileCard {...props} />)
    expect(onRender).toHaveBeenCalledTimes(1)

    rerender(<FileCard {...props} fileTagIds={newTagIds} />)
    expect(onRender).toHaveBeenCalledTimes(2)
  })

  it('11. R-B5: renderiza o glifo HORIZONTAL de ações e nunca o vertical', () => {
    const { container } = render(
      <FileCard
        file={sampleFile}
        allTags={sampleTags}
        fileTagIds={['tag1']}
        isSelected={false}
        onToggle={vi.fn()}
        onTagInteraction={vi.fn()}
        onActionInteraction={vi.fn()}
      />
    )

    // Universalidade do glifo: mesmo estilo da mesma ação no FileRow
    const actionBtn = screen.getByRole('button', { name: /ações do arquivo/i })
    expect(actionBtn.querySelector('[data-testid="lucide-MoreHorizontal"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="lucide-MoreVertical"]')).toBeNull()
  })
})

/*
 * Sprint 2.2 — Contrato de overflow de tags no card (eixo vertical).
 *
 * jsdom não executa layout: a medição do componente lê offsetTop/offsetHeight dos
 * chips e clientHeight do container. Em vez de mockar o layout, instalamos getters
 * determinísticos no protótipo de HTMLElement que derivam a geometria de um mapa
 * configurável por teste (chave = nome da tag; container identificado pela classe).
 * Sem o mock instalado (ambiente jsdom padrão), toda leitura retorna 0 ⇒ container
 * sem geometria ⇒ zero ocultas ⇒ nunca um "+N" falso.
 */
describe('FileCard — overflow de tags (+N e tooltip)', () => {
  type ChipGeom = { start: number; size: number }

  let mockChipGeometry: Record<string, ChipGeom> = {}
  let mockTagsContainerSize = 0
  const originalDescriptors: Array<[string, PropertyDescriptor | undefined]> = []

  const installOverflowGeometry = (): void => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>
    const defineGetter = (prop: string, get: () => number): void => {
      originalDescriptors.push([prop, Object.getOwnPropertyDescriptor(proto, prop)])
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get
      })
    }

    const chipGeomOf = (el: HTMLElement): ChipGeom | undefined =>
      mockChipGeometry[(el.textContent ?? '').trim()]

    defineGetter('offsetTop', function (this: HTMLElement) {
      return chipGeomOf(this)?.start ?? 0
    })
    defineGetter('offsetHeight', function (this: HTMLElement) {
      return chipGeomOf(this)?.size ?? 0
    })
    defineGetter('offsetLeft', function (this: HTMLElement) {
      return chipGeomOf(this)?.start ?? 0
    })
    defineGetter('offsetWidth', function (this: HTMLElement) {
      return chipGeomOf(this)?.size ?? 0
    })
    defineGetter('clientHeight', function (this: HTMLElement) {
      return this.classList.contains('file-card-tags') ? mockTagsContainerSize : 0
    })
    defineGetter('clientWidth', function (this: HTMLElement) {
      return this.classList.contains('file-card-tags') ? mockTagsContainerSize : 0
    })
  }

  const restoreGeometry = (): void => {
    for (const [prop, descriptor] of originalDescriptors.reverse()) {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, prop, descriptor)
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]
      }
    }
    originalDescriptors.length = 0
  }

  afterEach(() => {
    restoreGeometry()
    mockChipGeometry = {}
    mockTagsContainerSize = 0
  })

  const overflowFile: FileCardFile = {
    relativePath: 'src/components/Button.tsx',
    name: 'Button.tsx',
    tokenEstimate: 1200,
    changeType: 'modified'
  }

  const threeTagProps = {
    file: overflowFile,
    allTags: [
      { id: 'a', name: 'UI', color: '#ff0000' },
      { id: 'b', name: 'Core', color: '#00ff00' },
      { id: 'c', name: 'Parser', color: '#0000ff' }
    ] as Tag[],
    fileTagIds: ['a', 'b', 'c'],
    isSelected: false,
    onToggle: vi.fn(),
    onTagInteraction: vi.fn(),
    onActionInteraction: vi.fn()
  }

  it('12. Com 3ª tag abaixo do teto (2 linhas), renderiza "+1" e tooltip com as 3 tags', () => {
    installOverflowGeometry()
    mockTagsContainerSize = 40
    mockChipGeometry = {
      UI: { start: 0, size: 18 },
      Core: { start: 22, size: 18 },
      Parser: { start: 44, size: 18 }
    }

    const { container } = render(<FileCard {...threeTagProps} />)

    expect(screen.getByTestId('file-card-tags-more').textContent).toBe('+1')
    const tagsArea = screen.getByTestId('file-card-tags')
    expect(tagsArea.getAttribute('title')).toBe('UI, Core, Parser')
    // Consultabilidade: todas as tags permanecem no DOM mesmo clipadas
    expect(container.textContent).toContain('Parser')
  })

  it('13. Todas as tags dentro do teto ⇒ sem "+N"', () => {
    installOverflowGeometry()
    mockTagsContainerSize = 100
    mockChipGeometry = {
      UI: { start: 0, size: 18 },
      Core: { start: 22, size: 18 },
      Parser: { start: 44, size: 18 }
    }

    render(<FileCard {...threeTagProps} />)

    expect(screen.queryByTestId('file-card-tags-more')).toBeNull()
    expect(screen.getByTestId('file-card-tags').getAttribute('title')).toBe('UI, Core, Parser')
  })

  it('14. Ambiente sem geometria (jsdom padrão) ⇒ zero ocultas, sem "+N" falso', () => {
    render(<FileCard {...threeTagProps} />)

    expect(screen.queryByText(/\+\d+/)).toBeNull()
    expect(screen.queryByTestId('file-card-tags-more')).toBeNull()
  })
})

/*
 * Sprint 3 — Gatilho universal "+" de tags (paridade com FileRow).
 */
describe('FileCard — gatilho universal "+" de tags (Sprint 3)', () => {
  const cardPropsWith = (onTagInteraction: ReturnType<typeof vi.fn>) => ({
    file: {
      relativePath: 'src/components/Button.tsx',
      name: 'Button.tsx',
      tokenEstimate: 1200,
      changeType: 'modified'
    } as FileCardFile,
    allTags: [{ id: 'tag1', name: 'UI', color: '#ff0000' }] as Tag[],
    fileTagIds: ['tag1'] as string[],
    isSelected: false,
    onToggle: vi.fn(),
    onTagInteraction,
    onActionInteraction: vi.fn()
  })

  it('15. Botão "+" está sempre visível na área de tags do card (inclusive com zero tags)', () => {
    render(
      <FileCard
        {...cardPropsWith(vi.fn())}
        fileTagIds={[]}
        allTags={[]}
      />
    )

    expect(screen.getByRole('button', { name: /adicionar tag/i })).toBeDefined()
  })

  it('16. Clique no "+" chama onTagInteraction com o PRÓPRIO BOTÃO como âncora', () => {
    const onTagInteraction = vi.fn()
    render(<FileCard {...cardPropsWith(onTagInteraction)} />)

    const addBtn = screen.getByRole('button', { name: /adicionar tag/i })
    fireEvent.click(addBtn)

    expect(onTagInteraction).toHaveBeenCalledTimes(1)
    expect(onTagInteraction).toHaveBeenCalledWith(addBtn)
  })

  it('17. Clique na área de tags continua ancorando no container de tags (regressão)', () => {
    const onTagInteraction = vi.fn()
    render(<FileCard {...cardPropsWith(onTagInteraction)} />)

    fireEvent.click(screen.getByTestId('file-card-tags'))

    expect(onTagInteraction).toHaveBeenCalledTimes(1)
    expect(onTagInteraction).toHaveBeenCalledWith(screen.getByTestId('file-card-tags'))
  })
})
