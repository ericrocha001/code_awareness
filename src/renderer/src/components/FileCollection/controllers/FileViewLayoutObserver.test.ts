// @vitest-environment jsdom
/*
-T ---
*/

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  FileViewLayoutObserver,
  type FileViewMeasurementSurface,
  type OverflowMeasurement
} from './FileViewLayoutObserver'

// ── Setup global ──────────────────────────────────────────────────────────────

// rAF síncrono — executa callback imediatamente (duplo incluso)
const immediateRaf = vi.fn((cb: FrameRequestCallback): number => { cb(0); return 0 })
const noopCaf = vi.fn()

// Mock de ResizeObserver controlável
class MockResizeObserver {
  static instance: MockResizeObserver | null = null
  callback: ResizeObserverCallback
  observed: Element[] = []
  private disconnected = false
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb
    MockResizeObserver.instance = this
  }
  observe(el: Element) { this.observed.push(el) }
  unobserve(el: Element) { this.observed = this.observed.filter(e => e !== el) }
  // Semântica real: após disconnect(), nenhuma notificação é mais entregue.
  disconnect() { this.observed = []; this.disconnected = true }
  trigger() { if (!this.disconnected) this.callback([], this) }
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', immediateRaf)
  vi.stubGlobal('cancelAnimationFrame', noopCaf)
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  MockResizeObserver.instance = null
  immediateRaf.mockClear()
  noopCaf.mockClear()
})

// ── Helpers de surface mock ───────────────────────────────────────────────────

let CONTAINER_WIDTH = 100

interface MockChip { start: number; width: number }

/** Cria um elemento chip com geometria mockada. */
function makeChip(chip: MockChip): HTMLElement {
  const span = document.createElement('span')
  span.className = 'tag-chip'
  Object.defineProperty(span, 'offsetLeft',  { configurable: true, get: () => chip.start })
  Object.defineProperty(span, 'offsetWidth', { configurable: true, get: () => chip.width })
  return span
}

/** Cria um container de tags com clientWidth mockado e os chips fornecidos. */
function makeTagsContainer(chips: MockChip[]): HTMLElement {
  const tags = document.createElement('div')
  tags.className = 'fr-tags'
  Object.defineProperty(tags, 'clientWidth', { configurable: true, get: () => CONTAINER_WIDTH })
  for (const chip of chips) tags.appendChild(makeChip(chip))
  return tags
}

interface MockRow {
  path: string
  chips: MockChip[]
  /** Quando false, a surface entrega tagsContainer null. */
  withContainer?: boolean
}

/** Cria uma FileViewMeasurementSurface mock a partir de rows simuladas. */
function makeSurface(rows: MockRow[]): {
  surface: FileViewMeasurementSurface
  scroll: HTMLElement
  eventTarget: HTMLElement
} {
  const scroll = document.createElement('div')
  const eventTarget = document.createElement('div')

  return {
    surface: {
      getScrollContainer: () => scroll,
      getEventTarget: () => eventTarget,
      // Simula o contrato real: entrega apenas rows VISÍVEIS na viewport.
      // Cada chamada reconstrói chips com geometria determinística.
      getVisibleRows: () =>
        rows.map((row) => ({
          relativePath: row.path,
          tagsContainer: row.withContainer === false ? null : makeTagsContainer(row.chips),
          chips: row.withContainer === false ? [] : row.chips.map((c) => makeChip(c))
        }))
    },
    scroll,
    eventTarget
  }
}

const lastCall = (onMeasured: ReturnType<typeof vi.fn>): OverflowMeasurement[] =>
  onMeasured.mock.calls[onMeasured.mock.calls.length - 1][0]

// ── Suíte principal ───────────────────────────────────────────────────────────

describe('FileViewLayoutObserver', () => {
  it('mount agenda medição inicial via rAF duplo e reporta ao callback', () => {
    CONTAINER_WIDTH = 60
    const { surface } = makeSurface([
      { path: 'src/a.ts', chips: [{ start: 0, width: 40 }, { start: 44, width: 50 }] }
    ])
    const onMeasured = vi.fn()
    const observer = new FileViewLayoutObserver(surface, onMeasured)

    observer.mount()

    expect(immediateRaf).toHaveBeenCalledTimes(2)
    expect(onMeasured).toHaveBeenCalledTimes(1)
    expect(onMeasured).toHaveBeenCalledWith([{ relativePath: 'src/a.ts', hiddenCount: 1 }])
    observer.dispose()
  })

  it('getVisibleRows vazio → nenhuma medição reportada', () => {
    const { surface } = makeSurface([])
    const onMeasured = vi.fn()
    const observer = new FileViewLayoutObserver(surface, onMeasured)
    observer.mount()

    expect(onMeasured).not.toHaveBeenCalled()
    observer.dispose()
  })

  it('row sem tagsContainer reporta hiddenCount: 0', () => {
    const { surface } = makeSurface([{ path: 'src/a.ts', chips: [], withContainer: false }])
    const onMeasured = vi.fn()
    const observer = new FileViewLayoutObserver(surface, onMeasured)
    observer.mount()

    expect(onMeasured).toHaveBeenCalledWith([{ relativePath: 'src/a.ts', hiddenCount: 0 }])
    observer.dispose()
  })

  it('row com container sem chips reporta hiddenCount: 0', () => {
    const { surface } = makeSurface([{ path: 'src/a.ts', chips: [] }])
    const onMeasured = vi.fn()
    const observer = new FileViewLayoutObserver(surface, onMeasured)
    observer.mount()

    expect(onMeasured).toHaveBeenCalledWith([{ relativePath: 'src/a.ts', hiddenCount: 0 }])
    observer.dispose()
  })

  it('todos os chips cabem → hiddenCount: 0', () => {
    CONTAINER_WIDTH = 200
    const { surface } = makeSurface([
      { path: 'src/a.ts', chips: [{ start: 0, width: 40 }, { start: 44, width: 50 }] }
    ])
    const onMeasured = vi.fn()
    const observer = new FileViewLayoutObserver(surface, onMeasured)
    observer.mount()

    expect(onMeasured).toHaveBeenCalledWith([{ relativePath: 'src/a.ts', hiddenCount: 0 }])
    observer.dispose()
  })

  it('chips transbordam → hiddenCount correto', () => {
    CONTAINER_WIDTH = 60
    const { surface } = makeSurface([
      {
        path: 'src/a.ts',
        chips: [
          { start: 0, width: 40 },  // end=40  ✓
          { start: 44, width: 50 }, // end=94  ✗ (>60)
          { start: 98, width: 30 }, // end=128 ✗
        ]
      }
    ])
    const onMeasured = vi.fn()
    const observer = new FileViewLayoutObserver(surface, onMeasured)
    observer.mount()

    expect(onMeasured).toHaveBeenCalledWith([{ relativePath: 'src/a.ts', hiddenCount: 2 }])
    observer.dispose()
  })

  it('múltiplas rows — medição agrupada em uma única chamada ao callback', () => {
    CONTAINER_WIDTH = 60
    const { surface } = makeSurface([
      { path: 'src/a.ts', chips: [{ start: 0, width: 40 }, { start: 44, width: 50 }] },
      { path: 'src/b.ts', chips: [{ start: 0, width: 30 }] }
    ])
    const onMeasured = vi.fn()
    const observer = new FileViewLayoutObserver(surface, onMeasured)
    observer.mount()

    expect(onMeasured).toHaveBeenCalledTimes(1)
    const measurements = lastCall(onMeasured)
    expect(measurements).toHaveLength(2)
    expect(measurements.find((m) => m.relativePath === 'src/a.ts')?.hiddenCount).toBe(1)
    expect(measurements.find((m) => m.relativePath === 'src/b.ts')?.hiddenCount).toBe(0)
    observer.dispose()
  })

  it('fv-columns-changed no event target da surface dispara re-medição', () => {
    CONTAINER_WIDTH = 60
    const { surface, eventTarget } = makeSurface([
      { path: 'src/a.ts', chips: [{ start: 0, width: 40 }, { start: 44, width: 50 }] }
    ])
    const onMeasured = vi.fn()
    const observer = new FileViewLayoutObserver(surface, onMeasured)
    observer.mount()

    const callsAfterMount = onMeasured.mock.calls.length
    eventTarget.dispatchEvent(new CustomEvent('fv-columns-changed'))

    expect(onMeasured.mock.calls.length).toBeGreaterThan(callsAfterMount)
    observer.dispose()
  })

  it('scroll no scroll container da surface agenda re-medição', () => {
    CONTAINER_WIDTH = 60
    const { surface, scroll } = makeSurface([
      { path: 'src/a.ts', chips: [{ start: 0, width: 40 }, { start: 44, width: 50 }] }
    ])
    const onMeasured = vi.fn()
    const observer = new FileViewLayoutObserver(surface, onMeasured)
    observer.mount()

    const callsAfterMount = onMeasured.mock.calls.length
    scroll.dispatchEvent(new Event('scroll'))

    expect(onMeasured.mock.calls.length).toBeGreaterThan(callsAfterMount)
    observer.dispose()
  })

  it('ResizeObserver trigger dispara re-medição observando o scroll container da surface', () => {
    const { surface } = makeSurface([{ path: 'src/a.ts', chips: [] }])
    const onMeasured = vi.fn()
    const observer = new FileViewLayoutObserver(surface, onMeasured)
    observer.mount()

    const callsAfterMount = onMeasured.mock.calls.length
    MockResizeObserver.instance!.trigger()

    expect(onMeasured.mock.calls.length).toBeGreaterThan(callsAfterMount)
    observer.dispose()
  })

  it('dispose remove listeners — scroll não dispara mais re-medição', () => {
    const { surface, scroll } = makeSurface([{ path: 'src/a.ts', chips: [] }])
    const onMeasured = vi.fn()
    const observer = new FileViewLayoutObserver(surface, onMeasured)
    observer.mount()
    observer.dispose()

    const callsBefore = onMeasured.mock.calls.length
    scroll.dispatchEvent(new Event('scroll'))
    MockResizeObserver.instance!.trigger()

    expect(onMeasured.mock.calls.length).toBe(callsBefore)
  })

  it('remeasure() força nova rodada de medição', () => {
    const { surface } = makeSurface([{ path: 'src/a.ts', chips: [] }])
    const onMeasured = vi.fn()
    const observer = new FileViewLayoutObserver(surface, onMeasured)
    observer.mount()

    const callsAfterMount = onMeasured.mock.calls.length
    observer.remeasure()

    expect(onMeasured.mock.calls.length).toBeGreaterThan(callsAfterMount)
    observer.dispose()
  })
})





