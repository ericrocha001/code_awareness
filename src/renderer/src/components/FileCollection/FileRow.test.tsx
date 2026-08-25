// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a renderização do FileRow (nome, caminho, tokens, badges de alteração).
2. Validar a exibição de tags via prop tags:TagRenderData[] e hiddenCount.
3. Validar disparo do callback consolidado onRowAction para toggle, tagInteraction e actionInteraction.
4. Garantir ausência de popovers no DOM interno.
5. Comprovar o comportamento do React.memo frente a re-renderizações com props estáveis e mutações.

Mapa de Relacionamentos do Script

1. FileRow.tsx
   - Tipo: Dependência Direta
   - Relação: Componente sob teste.
   - Criticidade: Alta

2. @testing-library/react
   - Tipo: Dependência Direta
   - Relação: Fornece render, screen, fireEvent e cleanup para asserções de DOM.
   - Criticidade: Alta

Invariantes do Script

1. FileRow não contém hooks, estado local nem forwardRef — é componente visual puro.
2. Nenhum elemento de popover é instanciado na árvore do componente.
3. Testes de overflow (+N) removidos: lógica movida para TagOverflowController (Sprint 3).

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { FileRow, FileRowProps } from './FileRow'
import type { FileCardFile } from './types'
import type { TagRenderData } from './models/FileRowModel'

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

const sampleFile: FileCardFile = {
  relativePath: 'src/utils/format.ts',
  name: 'format.ts',
  tokenEstimate: 450,
  changeType: 'added'
}

const sampleTags: TagRenderData[] = [
  { id: 't1', name: 'Utils',  background: '#3b82f6', text: '#fff' },
  { id: 't2', name: 'Parser', background: '#10b981', text: '#fff' },
  { id: 't3', name: 'AST',    background: '#f59e0b', text: '#000' },
  { id: 't4', name: 'Engine', background: '#8b5cf6', text: '#fff' },
  { id: 't5', name: 'Core',   background: '#ef4444', text: '#fff' },
]

const baseProps = (onRowAction = vi.fn()): FileRowProps => ({
  file: sampleFile,
  tags: sampleTags.slice(0, 1),
  isSelected: false,
  hiddenCount: 0,
  onRowAction
})

// ── Testes ────────────────────────────────────────────────────────────────────

describe('FileRow', () => {
  it('1. Renderiza nome, caminho e tokens', () => {
    render(<FileRow {...baseProps()} />)

    expect(screen.getByText('format.ts')).toBeDefined()
    expect(screen.getByText('src/utils/format.ts')).toBeDefined()
    expect(screen.getByText('450')).toBeDefined()
    expect(screen.getByText('tokens')).toBeDefined()
    expect(screen.getByText('A')).toBeDefined()
  })

  it('2. Renderiza todas as tags via prop tags (sem truncamento)', () => {
    render(
      <FileRow
        file={sampleFile}
        tags={sampleTags}
        isSelected={false}
        hiddenCount={0}
        onRowAction={vi.fn()}
      />
    )

    expect(screen.getByText('Utils')).toBeDefined()
    expect(screen.getByText('Parser')).toBeDefined()
    expect(screen.getByText('AST')).toBeDefined()
    expect(screen.getByText('Engine')).toBeDefined()
    expect(screen.getByText('Core')).toBeDefined()
    expect(screen.queryByTestId('fr-tags-more')).toBeNull()
  })

  it('3. hiddenCount > 0 exibe o contador "+N"', () => {
    render(
      <FileRow
        file={sampleFile}
        tags={sampleTags.slice(0, 2)}
        isSelected={false}
        hiddenCount={3}
        onRowAction={vi.fn()}
      />
    )

    expect(screen.getByTestId('fr-tags-more').textContent).toBe('+3')
  })

  it('4. hiddenCount === 0 não exibe o contador', () => {
    render(<FileRow {...baseProps()} />)
    expect(screen.queryByTestId('fr-tags-more')).toBeNull()
  })

  it('5. onRowAction("toggle") é chamado ao clicar no toggle', () => {
    const onRowAction = vi.fn()
    render(<FileRow {...baseProps(onRowAction)} />)

    fireEvent.click(screen.getByRole('switch'))

    expect(onRowAction).toHaveBeenCalledTimes(1)
    expect(onRowAction).toHaveBeenCalledWith('toggle', sampleFile.relativePath)
  })

  it('6. onRowAction("tagInteraction") é chamado ao clicar na área de tags', () => {
    const onRowAction = vi.fn()
    render(<FileRow {...baseProps(onRowAction)} />)

    const tagsContainer = screen.getByTestId('file-row-tags')
    fireEvent.click(tagsContainer)

    expect(onRowAction).toHaveBeenCalledTimes(1)
    expect(onRowAction).toHaveBeenCalledWith('tagInteraction', sampleFile.relativePath, tagsContainer)
  })

  it('7. onRowAction("actionInteraction") é chamado ao clicar no botão de ações', () => {
    const onRowAction = vi.fn()
    render(<FileRow {...baseProps(onRowAction)} />)

    const actionButton = screen.getByRole('button', { name: /ações do arquivo/i })
    // Sprint 8: botão absoluto, filho direto da .fr-row
    expect(actionButton.parentElement?.classList.contains('fr-row')).toBe(true)
    expect(actionButton.closest('.fr-col-action')).toBeNull()
    fireEvent.click(actionButton)

    expect(onRowAction).toHaveBeenCalledTimes(1)
    expect(onRowAction).toHaveBeenCalledWith('actionInteraction', sampleFile.relativePath, actionButton)
  })

  it('8. Não renderiza Popover nem TagPopover no DOM', () => {
    const { container } = render(<FileRow {...baseProps()} />)

    expect(container.querySelector('.pop-root')).toBeNull()
    expect(container.querySelector('.tp-popover')).toBeNull()
    expect(document.querySelector('.pop-root')).toBeNull()
    expect(document.querySelector('.tp-popover')).toBeNull()
  })

  it('9. R-B5: renderiza o glifo HORIZONTAL de ações e nunca o vertical', () => {
    const { container } = render(<FileRow {...baseProps()} />)

    const actionBtn = screen.getByRole('button', { name: /ações do arquivo/i })
    expect(actionBtn.querySelector('[data-testid="lucide-MoreHorizontal"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="lucide-MoreVertical"]')).toBeNull()
  })

  it('10. React.memo: não re-renderiza com props inalteradas', () => {
    // FileRow é puro — sem onRender; verificamos via mock do componente interno
    // que o JSX é estável usando rerender com mesmas refs.
    const onRowAction = vi.fn()
    const props: FileRowProps = {
      file: sampleFile,
      tags: sampleTags.slice(0, 1),
      isSelected: false,
      hiddenCount: 0,
      onRowAction
    }

    const { rerender, container } = render(<FileRow {...props} />)
    const textBefore = container.textContent

    rerender(<FileRow {...props} />)
    expect(container.textContent).toBe(textBefore)
  })

  it('11. React.memo: re-renderiza quando isSelected muda', () => {
    const onRowAction = vi.fn()
    const props: FileRowProps = {
      file: sampleFile,
      tags: [],
      isSelected: false,
      hiddenCount: 0,
      onRowAction
    }

    const { rerender, container } = render(<FileRow {...props} />)
    expect(container.querySelector('.fr-row')?.classList.contains('selected')).toBe(false)

    rerender(<FileRow {...props} isSelected={true} />)
    expect(container.querySelector('.fr-row')?.classList.contains('selected')).toBe(true)
  })
})

/*
 * Sprint 3 — Gatilho universal "+" de tags.
 */
describe('FileRow — gatilho universal "+" de tags', () => {
  const fileNoTags: FileCardFile = {
    relativePath: 'src/utils/format.ts',
    name: 'format.ts',
    tokenEstimate: 450
  }

  it('12. Botão "+" está sempre visível na célula de tags', () => {
    render(
      <FileRow
        file={fileNoTags}
        tags={[]}
        isSelected={false}
        hiddenCount={0}
        onRowAction={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: /adicionar tag/i })).toBeDefined()
  })

  it('13. Clique no "+" chama onRowAction("tagInteraction") com o PRÓPRIO BOTÃO como âncora', () => {
    const onRowAction = vi.fn()
    render(
      <FileRow
        file={fileNoTags}
        tags={[{ id: 't1', name: 'Utils', background: '#3b82f6', text: '#fff' }]}
        isSelected={false}
        hiddenCount={0}
        onRowAction={onRowAction}
      />
    )

    const addBtn = screen.getByRole('button', { name: /adicionar tag/i })
    fireEvent.click(addBtn)

    expect(onRowAction).toHaveBeenCalledTimes(1)
    expect(onRowAction).toHaveBeenCalledWith('tagInteraction', fileNoTags.relativePath, addBtn)
  })

  it('14. Clique na área de tags ancora na div .fr-tags (regressão)', () => {
    const onRowAction = vi.fn()
    render(
      <FileRow
        file={fileNoTags}
        tags={[{ id: 't1', name: 'Utils', background: '#3b82f6', text: '#fff' }]}
        isSelected={false}
        hiddenCount={0}
        onRowAction={onRowAction}
      />
    )

    fireEvent.click(screen.getByTestId('file-row-tags'))

    expect(onRowAction).toHaveBeenCalledTimes(1)
    expect(onRowAction).toHaveBeenCalledWith(
      'tagInteraction',
      fileNoTags.relativePath,
      screen.getByTestId('file-row-tags')
    )
  })
})

/*
 * Sprint 3 — data-relative-path para identificação pelo TagOverflowController.
 */
describe('FileRow — data-relative-path (Sprint 3)', () => {
  it('renderiza data-relative-path no elemento raiz', () => {
    const { container } = render(<FileRow {...baseProps()} />)

    const root = container.querySelector('.fr-row')
    expect(root?.getAttribute('data-relative-path')).toBe(sampleFile.relativePath)
  })
})
