// @vitest-environment jsdom
/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Validar a renderização da lista compacta FileView e seu cabeçalho fixo.
2. Validar o disparo de onRowAction para toggle, tagInteraction e actionInteraction.
3. Validar o comportamento de estado vazio (mantendo o cabeçalho visível).
4. Validar colunas redimensionáveis com persistência por projeto.

Mapa de Relacionamentos do Script

1. FileView.tsx
   - Tipo: Dependência Direta
   - Relação: Componente sob teste.
   - Criticidade: Alta

2. @testing-library/react
   - Tipo: Dependência Direta
   - Relação: Fornece render, screen, fireEvent e cleanup para asserções de DOM.
   - Criticidade: Alta

Invariantes do Script

1. Os mocks de requestAnimationFrame e cancelAnimationFrame são restaurados em afterAll.
2. O cabeçalho fixo mantém seus rótulos mesmo quando a lista estiver vazia.
3. Testes de anchorRefs (registro/limpeza) removidos: funcionalidade eliminada na Sprint 2.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React from 'react'
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { FileView } from './FileView'
import type { FileCardFile } from './types'
import { FileViewLayoutObserver } from './controllers/FileViewLayoutObserver'
import type { TagRenderData } from './models/FileRowModel'
import { Tag } from '../../../../shared/types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const prefsState = vi.hoisted(() => ({
  preferences: {} as Record<string, unknown>,
  updateFileViewColumnWidths: vi.fn()
}))

vi.mock('../shared/ColumnResizer/ColumnResizer', () => ({
  ColumnResizer: ({ onDrag, onDragEnd }: any) => (
    <span>
      <button data-testid="crs-drag" onClick={() => onDrag(40)} />
      <button data-testid="crs-drag-neg" onClick={() => onDrag(-2000)} />
      <button data-testid="crs-end" onClick={() => onDragEnd()} />
    </span>
  )
}))

vi.mock('../../hooks/useProjectPreferences', () => ({
  useProjectPreferences: () => ({
    preferences: prefsState.preferences,
    updateFileViewColumnWidths: prefsState.updateFileViewColumnWidths
  })
}))

// ── Fixtures ──────────────────────────────────────────────────────────────────

const sampleFiles: FileCardFile[] = [
  { relativePath: 'src/a.ts', name: 'a.ts', tokenEstimate: 100 },
  { relativePath: 'src/b.ts', name: 'b.ts', tokenEstimate: 200 },
  { relativePath: 'src/c.ts', name: 'c.ts', tokenEstimate: 300 }
]

const sampleTags: Tag[] = [{ id: 'tag1', name: 'UI', color: '#ff0000' }]

/** Cria TagRenderData para popular o tagsByFile nos testes. */
const tagRender = (id: string, name: string): TagRenderData => ({
  id,
  name,
  background: '#123456',
  text: '#ffffff'
})

const baseProps = (overrides: Partial<React.ComponentProps<typeof FileView>> = {}) => ({
  files: sampleFiles,
  tagsByFile: new Map<string, readonly TagRenderData[]>(),
  isSelected: () => false,
  onRowAction: vi.fn(),
  ...overrides
})

// ── Suite principal ────────────────────────────────────────────────────────────

describe('FileView', () => {
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
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    cleanup()
  })

  it('1. Renderiza FileRows para os arquivos fornecidos', () => {
    render(<FileView {...baseProps()} />)

    expect(screen.getByText('a.ts')).toBeDefined()
    expect(screen.getByText('b.ts')).toBeDefined()
    expect(screen.getByText('c.ts')).toBeDefined()
  })

  it('2. Renderiza o header fixo com rótulos corretos', () => {
    render(<FileView {...baseProps()} />)

    expect(screen.getByText('Seleção')).toBeDefined()
    expect(screen.getByText('Arquivo')).toBeDefined()
    expect(screen.getByText('Caminho')).toBeDefined()
    expect(screen.getByText('Tags')).toBeDefined()
    expect(screen.getByText('Tokens')).toBeDefined()
    expect(screen.queryByText('Ações')).toBeNull()
  })

  it('3. isSelected é chamado com o relativePath correto', () => {
    const isSelected = vi.fn((path: string) => path === 'src/a.ts')
    const { container } = render(<FileView {...baseProps({ isSelected, files: sampleFiles.slice(0, 2) })} />)

    expect(isSelected).toHaveBeenCalledWith('src/a.ts')
    expect(isSelected).toHaveBeenCalledWith('src/b.ts')

    const rows = container.querySelectorAll('.fr-row')
    expect(rows[0].classList.contains('selected')).toBe(true)
    expect(rows[1].classList.contains('selected')).toBe(false)
  })

  it('4. onRowAction("toggle") é disparado ao clicar no toggle de uma row', () => {
    const onRowAction = vi.fn()
    render(<FileView {...baseProps({ files: [sampleFiles[0]], onRowAction })} />)

    fireEvent.click(screen.getByRole('switch'))

    expect(onRowAction).toHaveBeenCalledTimes(1)
    expect(onRowAction).toHaveBeenCalledWith('toggle', 'src/a.ts')
  })

  it('5. onRowAction("tagInteraction") é disparado ao clicar na área de tags', () => {
    const onRowAction = vi.fn()
    render(
      <FileView
        {...baseProps({
          files: [sampleFiles[0]],
          tagsByFile: new Map([['src/a.ts', [tagRender('tag1', 'UI')]]]),
          onRowAction
        })}
      />
    )

    const tagsContainer = screen.getByTestId('file-row-tags')
    fireEvent.click(tagsContainer)

    expect(onRowAction).toHaveBeenCalledTimes(1)
    expect(onRowAction).toHaveBeenCalledWith('tagInteraction', 'src/a.ts', tagsContainer)
  })

  it('6. onRowAction("actionInteraction") é disparado ao clicar no botão de ações', () => {
    const onRowAction = vi.fn()
    render(<FileView {...baseProps({ files: [sampleFiles[0]], onRowAction })} />)

    const actionButton = screen.getByRole('button', { name: /ações do arquivo/i })
    fireEvent.click(actionButton)

    expect(onRowAction).toHaveBeenCalledTimes(1)
    expect(onRowAction).toHaveBeenCalledWith('actionInteraction', 'src/a.ts', actionButton)
  })

  it('7. Renderiza estado vazio quando não há arquivos', () => {
    const { container } = render(<FileView {...baseProps({ files: [] })} />)

    expect(screen.getByText('Nenhum arquivo encontrado')).toBeDefined()
    expect(screen.getByText('Seleção')).toBeDefined()
    expect(container.querySelector('.fr-row')).toBeNull()
  })

  it('8. Header é o primeiro filho do scroll container (sticky funcional)', () => {
    const { container } = render(<FileView {...baseProps({ files: [sampleFiles[0]] })} />)

    const scroll = container.querySelector('.fv-scroll-container')!
    expect(Array.from(scroll.children)[0].classList.contains('fv-header')).toBe(true)
  })

  it('9. Estado vazio também tem o header dentro do scroll container', () => {
    const { container } = render(<FileView {...baseProps({ files: [] })} />)

    const scroll = container.querySelector('.fv-scroll-container')!
    const children = Array.from(scroll.children) as HTMLElement[]
    expect(children[0].classList.contains('fv-header')).toBe(true)
    expect(children[1].classList.contains('fv-empty')).toBe(true)
  })

  it('10. Header renderiza exatamente cinco células na ordem contratada', () => {
    const { container } = render(<FileView {...baseProps({ files: [sampleFiles[0]] })} />)

    const header = container.querySelector('.fv-header')!
    const cells = Array.from(header.children) as HTMLElement[]
    expect(cells.length).toBe(5)
    // Sprint 8: coluna de ações removida do grid
    expect(cells.map((c) => c.textContent)).toEqual([
      'Seleção', 'Arquivo', 'Caminho', 'Tags', 'Tokens'
    ])
  })
})

// ── Colunas redimensionáveis ───────────────────────────────────────────────────

describe('FileView — colunas redimensionáveis (Sprint 3)', () => {
  const file: FileCardFile = { relativePath: 'src/a.ts', name: 'a.ts', tokenEstimate: 100 }
  const colProps = {
    files: [file],
    tagsByFile: new Map<string, readonly TagRenderData[]>(),
    isSelected: () => false,
    onRowAction: vi.fn()
  }

  beforeEach(() => {
    prefsState.preferences = {}
    prefsState.updateFileViewColumnWidths.mockClear()
  })

  afterEach(() => { cleanup() })

  it('11. Renderiza 5 alças de redimensionamento no header', () => {
    const { container } = render(<FileView {...colProps} />)

    for (const key of ['toggle', 'identity', 'path', 'tags', 'tokens']) {
      expect(container.querySelector(`[data-testid="resizer-${key}"]`)).not.toBeNull()
    }
  })

  it('12. onDrag em tags aplica track px à custom property no .fv-container; dragEnd persiste uma vez', () => {
    const { container } = render(<FileView {...colProps} />)

    const tagsZone = container.querySelector('[data-testid="resizer-tags"]')!
    fireEvent.click(tagsZone.querySelector('[data-testid="crs-drag"]')!)

    const root = container.querySelector('.fv-container') as HTMLElement
    expect(root.style.getPropertyValue('--fv-grid-template')).toContain('240px')

    fireEvent.click(tagsZone.querySelector('[data-testid="crs-end"]')!)
    expect(prefsState.updateFileViewColumnWidths).toHaveBeenCalledTimes(1)
    expect(prefsState.updateFileViewColumnWidths).toHaveBeenCalledWith(
      expect.objectContaining({ tags: 240 })
    )
  })

  it('12a. dragEnd despacha fv-columns-changed no .fv-container', () => {
    const { container } = render(<FileView {...colProps} />)
    const root = container.querySelector('.fv-container')!

    let dispatched = false
    root.addEventListener('fv-columns-changed', () => { dispatched = true })

    const tagsZone = container.querySelector('[data-testid="resizer-tags"]')!
    fireEvent.click(tagsZone.querySelector('[data-testid="crs-drag"]')!)
    fireEvent.click(tagsZone.querySelector('[data-testid="crs-end"]')!)

    expect(dispatched).toBe(true)
  })

  it('12b. onDrag em toggle aplica track px na primeira posição (48 + 40 ⇒ 88px)', () => {
    const { container } = render(<FileView {...colProps} />)

    const toggleZone = container.querySelector('[data-testid="resizer-toggle"]')!
    fireEvent.click(toggleZone.querySelector('[data-testid="crs-drag"]')!)

    const root = container.querySelector('.fv-container') as HTMLElement
    const template = root.style.getPropertyValue('--fv-grid-template')
    expect(template).toContain('88px')
    expect(template.startsWith('88px')).toBe(true)
  })

  it('13. Delta negativo excessivo é clampado em 0 antes de persistir', () => {
    const { container } = render(<FileView {...colProps} />)

    const tagsZone = container.querySelector('[data-testid="resizer-tags"]')!
    fireEvent.click(tagsZone.querySelector('[data-testid="crs-drag-neg"]')!)
    fireEvent.click(tagsZone.querySelector('[data-testid="crs-end"]')!)

    expect(prefsState.updateFileViewColumnWidths).toHaveBeenCalledWith(
      expect.objectContaining({ tags: 0 })
    )
  })

  it('14. Preferências persistidas inválidas são sanitizadas sem quebrar o render', () => {
    prefsState.preferences = { fileViewColumnWidths: { tags: 50, path: 'abc', foo: 10 } }

    const { container } = render(<FileView {...colProps} />)

    const root = container.querySelector('.fv-container') as HTMLElement
    const template = root.style.getPropertyValue('--fv-grid-template')
    expect(template).toContain('50px')
    expect(template).not.toContain('abc')
  })

  it('14b. window.resize despacha fv-columns-changed no .fv-container (Sprint 9)', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const { container } = render(<FileView {...colProps} />)
    const root = container.querySelector('.fv-container')!

    let dispatched = false
    root.addEventListener('fv-columns-changed', () => { dispatched = true })

    fireEvent(window, new Event('resize'))
    expect(dispatched).toBe(true)

    vi.unstubAllGlobals()
  })
})

/*
 * Sprint 3 — TagOverflowController integrado no FileView.
 *
 * Valida que hiddenCount é calculado pelo controller e injetado corretamente
 * em cada FileRow. A geometria é mockada via getters no protótipo de HTMLElement,
 * seguindo o mesmo padrão dos testes anteriores de overflow.
 */
describe('FileView — TagOverflowController (Sprint 3)', () => {
  type ChipGeom = { start: number; size: number }

  let mockChipGeometry: Record<string, ChipGeom> = {}
  let mockTagsContainerWidth = 0
  const originalDescriptors: Array<[string, PropertyDescriptor | undefined]> = []

  const immediateRaf = (cb: FrameRequestCallback): number => { cb(0); return 0 }

  const installGeometry = (): void => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>
    const def = (prop: string, get: () => number): void => {
      originalDescriptors.push([prop, Object.getOwnPropertyDescriptor(proto, prop)])
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get })
    }
    const geomOf = (el: HTMLElement): ChipGeom | undefined =>
      mockChipGeometry[(el.textContent ?? '').trim()]

    def('offsetLeft',  function (this: HTMLElement) { return geomOf(this)?.start ?? 0 })
    def('offsetWidth', function (this: HTMLElement) { return geomOf(this)?.size  ?? 0 })
    def('clientWidth', function (this: HTMLElement) {
      return this.classList.contains('fr-tags') ? mockTagsContainerWidth : 0
    })
  }

  const restoreGeometry = (): void => {
    for (const [prop, desc] of originalDescriptors.reverse()) {
      if (desc) Object.defineProperty(HTMLElement.prototype, prop, desc)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]
    }
    originalDescriptors.length = 0
  }

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', immediateRaf)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    prefsState.preferences = {}
    prefsState.updateFileViewColumnWidths.mockClear()
  })

  afterEach(() => {
    restoreGeometry()
    mockChipGeometry = {}
    mockTagsContainerWidth = 0
    cleanup()
    vi.unstubAllGlobals()
  })

  const overflowFile: FileCardFile = {
    relativePath: 'src/a.ts',
    name: 'a.ts',
    tokenEstimate: 100
  }

  it('15. hiddenCount correto quando tags transbordam o container', () => {
    installGeometry()
    mockTagsContainerWidth = 60
    mockChipGeometry = {
      UI: { start: 0, size: 40 },   // end=40 ✓
      Core: { start: 44, size: 50 }, // end=94 ✗
    }

    render(
      <FileView
        files={[overflowFile]}
        tagsByFile={new Map([['src/a.ts', [tagRender('t1', 'UI'), tagRender('t2', 'Core')]]])}
        isSelected={() => false}
        onRowAction={vi.fn()}
      />
    )

    expect(screen.getByTestId('fr-tags-more').textContent).toBe('+1')
  })

  it('16. hiddenCount=0 quando todos os chips cabem', () => {
    installGeometry()
    mockTagsContainerWidth = 200
    mockChipGeometry = {
      UI:   { start: 0,  size: 40 },
      Core: { start: 44, size: 50 },
    }

    render(
      <FileView
        files={[overflowFile]}
        tagsByFile={new Map([['src/a.ts', [tagRender('t1', 'UI'), tagRender('t2', 'Core')]]])}
        isSelected={() => false}
        onRowAction={vi.fn()}
      />
    )

    expect(screen.queryByTestId('fr-tags-more')).toBeNull()
  })

  it('17. .fr-row tem data-relative-path para identificação pelo controller', () => {
    const { container } = render(
      <FileView
        files={[overflowFile]}
        tagsByFile={new Map()}
        isSelected={() => false}
        onRowAction={vi.fn()}
      />
    )

    const row = container.querySelector('.fr-row')
    expect(row?.getAttribute('data-relative-path')).toBe('src/a.ts')
  })
})

/*
 * Sprint 4 — Lazy Mount Acumulativo.
 *
 * Valida que o FileView monta apenas as primeiras rows (lote inicial de 80) e
 * monta lotes adicionais quando o sentinel dispara o IntersectionObserver.
 * jsdom não implementa IntersectionObserver — o mock controlável permite
 * simular isIntersecting: true para o disparo do loadMore.
 */
describe('FileView — Lazy Mount (Sprint 4)', () => {
  class MockIntersectionObserver {
    static instance: MockIntersectionObserver | null = null
    callback: IntersectionObserverCallback
    observed: Element[] = []
    constructor(cb: IntersectionObserverCallback) {
      this.callback = cb
      MockIntersectionObserver.instance = this
    }
    observe(el: Element): void {
      this.observed.push(el)
    }
    unobserve(): void {
      /* no-op — cleanup usa disconnect abaixo */
    }
    disconnect(): void {
      this.observed = []
    }
    trigger(isIntersecting = true): void {
      this.callback(
        [{ isIntersecting } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver
      )
    }
  }

  const makeFiles = (count: number): FileCardFile[] =>
    Array.from({ length: count }, (_, i) => ({
      relativePath: `src/file-${i}.ts`,
      name: `file-${i}.ts`,
      tokenEstimate: 100
    }))

  const immediateRaf = (cb: FrameRequestCallback): number => {
    cb(0)
    return 0
  }

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', immediateRaf)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    MockIntersectionObserver.instance = null
    prefsState.updateFileViewColumnWidths.mockClear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  const baseLazyProps = (files: FileCardFile[]) => ({
    files,
    tagsByFile: new Map(),
    isSelected: () => false,
    onRowAction: vi.fn()
  })

  it('L1. Com 200 arquivos, renderiza inicialmente 80 FileRows + sentinel', () => {
    const { container } = render(<FileView {...baseLazyProps(makeFiles(200))} />)

    expect(container.querySelectorAll('.fr-row')).toHaveLength(80)

    const sentinel = container.querySelector('.fv-sentinel')
    expect(sentinel).not.toBeNull()
    expect(sentinel?.getAttribute('aria-hidden')).toBe('true')
  })

  it('L2. Sentinel observado pelo IntersectionObserver', () => {
    render(<FileView {...baseLazyProps(makeFiles(200))} />)

    expect(MockIntersectionObserver.instance).not.toBeNull()
    expect(MockIntersectionObserver.instance?.observed).toHaveLength(1)
  })

  it('L3. Disparo do sentinel monta mais 80 FileRows (total 160)', () => {
    const { container } = render(<FileView {...baseLazyProps(makeFiles(200))} />)
    expect(container.querySelectorAll('.fr-row')).toHaveLength(80)

    act(() => {
      MockIntersectionObserver.instance?.trigger()
    })

    expect(container.querySelectorAll('.fr-row')).toHaveLength(160)
  })

  it('L4. Com menos de 80 arquivos, renderiza todos e não renderiza sentinel', () => {
    const { container } = render(<FileView {...baseLazyProps(makeFiles(25))} />)

    expect(container.querySelectorAll('.fr-row')).toHaveLength(25)
    expect(container.querySelector('.fv-sentinel')).toBeNull()
  })

  it('L5. data-relative-path presente em todas as FileRows renderizadas', () => {
    const { container } = render(<FileView {...baseLazyProps(makeFiles(90))} />)

    const rows = Array.from(container.querySelectorAll('.fr-row'))
    expect(rows).toHaveLength(80)
    rows.forEach((row, i) => {
      expect(row.getAttribute('data-relative-path')).toBe(`src/file-${i}.ts`)
    })
  })

  it('L6. FileViewLayoutObserver é re-medido quando mountedCount muda (lazy mount)', () => {
    const remeasureSpy = vi.spyOn(FileViewLayoutObserver.prototype, 'remeasure')

    render(<FileView {...baseLazyProps(makeFiles(200))} />)

    const callsBefore = remeasureSpy.mock.calls.length

    act(() => {
      MockIntersectionObserver.instance?.trigger()
    })

    expect(callsBefore).toBeGreaterThan(0)
    expect(remeasureSpy.mock.calls.length).toBeGreaterThan(callsBefore)

    remeasureSpy.mockRestore()
  })
})
