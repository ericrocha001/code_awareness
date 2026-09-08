// @vitest-environment jsdom
/*
-T ---
*/

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { FileCollectionView } from './FileCollectionView'
import type { FileCardFile } from './types'
import { Tag } from '../../../../shared/types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn(), effectiveTheme: 'dark' })
}))

vi.mock('./FileView', () => ({
  FileView: ({ onRowAction, files }: any) => (
    <div data-testid="mock-file-view" data-files-count={files.length}>
      <button
        data-testid="mock-file-toggle"
        onClick={() => onRowAction('toggle', 'src/a.ts')}
      >
        toggle
      </button>
      <button
        data-testid="mock-file-tag"
        onClick={(e) => onRowAction('tagInteraction', 'src/a.ts', e.currentTarget)}
      >
        tag
      </button>
      <button
        data-testid="mock-file-action"
        onClick={(e) => onRowAction('actionInteraction', 'src/a.ts', e.currentTarget)}
      >
        action
      </button>
    </div>
  )
}))

vi.mock('./ActivePopover', () => ({
  ActivePopover: ({ activeInteraction }: any) =>
    activeInteraction ? (
      <div
        data-testid="mock-active-popover"
        data-type={activeInteraction.type}
        data-path={activeInteraction.relativePath}
        data-has-anchor={activeInteraction.anchor ? 'true' : 'false'}
      />
    ) : null
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const sampleFiles: FileCardFile[] = [
  { relativePath: 'src/a.ts', name: 'a.ts', tokenEstimate: 100 },
  { relativePath: 'src/b.ts', name: 'b.ts', tokenEstimate: 200 },
  { relativePath: 'src/c.ts', name: 'c.ts', tokenEstimate: 300 }
]

const sampleTags: Tag[] = [{ id: 'tag1', name: 'UI', color: '#ff0000' }]

afterEach(() => { cleanup() })

// ── Testes ────────────────────────────────────────────────────────────────────

describe('FileCollectionView', () => {
  it('1. Renderiza FileView por padrão (view única)', () => {
    render(
      <FileCollectionView
        files={sampleFiles}
        allTags={sampleTags}
        fileTagsMap={{}}
        selectedFiles={new Set()}
        onSelectionChange={vi.fn()}
        formatTokenCount={(c) => `${c}`}
      />
    )

    expect(screen.getByTestId('mock-file-view')).toBeDefined()
  })

  it('6. Master toggle seleciona todos', () => {
    const onSelectionChange = vi.fn()
    render(
      <FileCollectionView
        files={sampleFiles}
        allTags={sampleTags}
        fileTagsMap={{}}
        selectedFiles={new Set()}
        onSelectionChange={onSelectionChange}
        formatTokenCount={(c) => `${c}`}
      />
    )

    fireEvent.click(screen.getByRole('switch'))

    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    expect(onSelectionChange).toHaveBeenCalledWith(
      new Set(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    )
  })

  it('7. Master toggle desseleciona todos quando todos selecionados', () => {
    const onSelectionChange = vi.fn()
    render(
      <FileCollectionView
        files={sampleFiles}
        allTags={sampleTags}
        fileTagsMap={{}}
        selectedFiles={new Set(['src/a.ts', 'src/b.ts', 'src/c.ts'])}
        onSelectionChange={onSelectionChange}
        formatTokenCount={(c) => `${c}`}
      />
    )

    fireEvent.click(screen.getByRole('switch'))

    expect(onSelectionChange).toHaveBeenCalledWith(new Set())
  })

  it('8. Botão Limpar aparece quando há seleção e limpa ao clicar', () => {
    const onSelectionChange = vi.fn()
    render(
      <FileCollectionView
        files={sampleFiles}
        allTags={sampleTags}
        fileTagsMap={{}}
        selectedFiles={new Set(['src/a.ts'])}
        onSelectionChange={onSelectionChange}
        formatTokenCount={(c) => `${c}`}
      />
    )

    const clearBtn = screen.getByRole('button', { name: /limpar/i })
    expect(clearBtn).toBeDefined()
    fireEvent.click(clearBtn)
    expect(onSelectionChange).toHaveBeenCalledWith(new Set())
  })

  it('9. Botão Limpar não aparece quando seleção está vazia', () => {
    render(
      <FileCollectionView
        files={sampleFiles}
        allTags={sampleTags}
        fileTagsMap={{}}
        selectedFiles={new Set()}
        onSelectionChange={vi.fn()}
        formatTokenCount={(c) => `${c}`}
      />
    )

    expect(screen.queryByRole('button', { name: /limpar/i })).toBeNull()
  })

  it('10. Contagem exibe informação correta', () => {
    render(
      <FileCollectionView
        files={sampleFiles}
        allTags={sampleTags}
        fileTagsMap={{}}
        selectedFiles={new Set(['src/a.ts'])}
        onSelectionChange={vi.fn()}
        formatTokenCount={(c) => `${c} tokens`}
      />
    )

    expect(screen.getByText(/1 de 3 selecionados/)).toBeDefined()
  })

  it('11. ActivePopover é renderizado quando interação é aberta via tag', () => {
    render(
      <FileCollectionView
        files={sampleFiles}
        allTags={sampleTags}
        fileTagsMap={{}}
        selectedFiles={new Set()}
        onSelectionChange={vi.fn()}
        formatTokenCount={(c) => `${c}`}
      />
    )

    expect(screen.queryByTestId('mock-active-popover')).toBeNull()

    fireEvent.click(screen.getByTestId('mock-file-tag'))

    const activePopover = screen.getByTestId('mock-active-popover')
    expect(activePopover).toBeDefined()
    expect(activePopover.getAttribute('data-type')).toBe('tagPopover')
    expect(activePopover.getAttribute('data-path')).toBe('src/a.ts')
    expect(activePopover.getAttribute('data-has-anchor')).toBe('true')
  })

  it('12. Auto-fechamento: interação fecha quando item sai da lista', () => {
    const { rerender } = render(
      <FileCollectionView
        files={sampleFiles}
        allTags={sampleTags}
        fileTagsMap={{}}
        selectedFiles={new Set()}
        onSelectionChange={vi.fn()}
        formatTokenCount={(c) => `${c}`}
      />
    )

    fireEvent.click(screen.getByTestId('mock-file-tag'))
    expect(screen.getByTestId('mock-active-popover')).toBeDefined()

    rerender(
      <FileCollectionView
        files={sampleFiles.slice(1)} // src/a.ts removido
        allTags={sampleTags}
        fileTagsMap={{}}
        selectedFiles={new Set()}
        onSelectionChange={vi.fn()}
        formatTokenCount={(c) => `${c}`}
      />
    )

    expect(screen.queryByTestId('mock-active-popover')).toBeNull()
  })
})
