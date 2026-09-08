/*
-T ---
*/

import { computeTagOverflow, type ChipGeometry } from '../../../utils/tag-overflow'

/** Resultado de medição de overflow para uma única row. */
export interface OverflowMeasurement {
  relativePath: string
  hiddenCount: number
}

/** Callback invocado quando uma nova rodada de medições é concluída. */
export type OverflowMeasuredCallback = (measurements: OverflowMeasurement[]) => void

/**
 * Superfície de medição desacoplada da estrutura DOM da FileView.
 *
 * O FileViewLayoutObserver consome exclusivamente esta interface — não faz
 * queries CSS nem conhece classes concretas (.fv-scroll-container, .fr-row,
 * .fr-tags, .tag-chip). Testável com surfaces mock e reutilizável.
 */
export interface FileViewMeasurementSurface {
  /** Scroll container cujo resize/scroll disparam re-medição (ou null). */
  getScrollContainer(): HTMLElement | null
  /** Alvo do evento `fv-columns-changed` (ou null). */
  getEventTarget(): HTMLElement | null
  /**
   * Rows atualmente VISÍVEIS na viewport, já filtradas — com content-visibility:
   * auto, medir rows fora da viewport produziria geometria inválida (zeros).
   */
  getVisibleRows(): Array<{
    relativePath: string
    tagsContainer: HTMLElement | null
    chips: HTMLElement[]
  }>
}

/**
 * Observer centralizado de layout da FileView: coordena resize, scroll,
 * columns-changed e rAF duplo para medir overflow de tags em uma única
 * operação agrupada por frame.
 *
 * Substitui N useEffects individuais (um por FileRow) por uma única operação
 * coalescida. Com 200 arquivos, elimina 200 reflows simultâneos no dragEnd.
 */
export class FileViewLayoutObserver {
  private readonly surface: FileViewMeasurementSurface
  private readonly onMeasured: OverflowMeasuredCallback
  private resizeObserver: ResizeObserver | null = null
  private rafId: number | null = null
  private scrollHandler: (() => void) | null = null
  private readonly handleColumnsChanged: () => void

  constructor(surface: FileViewMeasurementSurface, onMeasured: OverflowMeasuredCallback) {
    this.surface = surface
    this.onMeasured = onMeasured
    // Bind estável — mesma referência usada em addEventListener e removeEventListener.
    this.handleColumnsChanged = () => this.scheduleMeasure()
  }

  /** Instala observers e agenda medição inicial. */
  mount(): void {
    const scrollContainer = this.surface.getScrollContainer()
    if (scrollContainer && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.scheduleMeasure())
      this.resizeObserver.observe(scrollContainer)
    }

    const eventTarget = this.surface.getEventTarget()
    if (eventTarget) {
      eventTarget.addEventListener('fv-columns-changed', this.handleColumnsChanged)
    }

    // Listener de scroll: quando novas rows entram na viewport, o browser as
    // renderiza (content-visibility: auto) e elas precisam ser medidas.
    // passive: true evita bloquear o scroll; scheduleMeasure coalesce via rAF duplo.
    if (scrollContainer) {
      this.scrollHandler = () => this.scheduleMeasure()
      scrollContainer.addEventListener('scroll', this.scrollHandler, { passive: true })
    }

    // Medição inicial após paint (rAF duplo para garantir geometria estável).
    this.scheduleMeasure()
  }

  /** Força nova rodada de medição. Chamado quando files/mountedCount mudam. */
  remeasure(): void {
    this.scheduleMeasure()
  }

  /** Remove todos os observers e cancela medições pendentes. */
  dispose(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    const eventTarget = this.surface.getEventTarget()
    if (eventTarget) {
      eventTarget.removeEventListener('fv-columns-changed', this.handleColumnsChanged)
    }
    if (this.scrollHandler) {
      this.surface.getScrollContainer()?.removeEventListener('scroll', this.scrollHandler)
      this.scrollHandler = null
    }
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  private scheduleMeasure(): void {
    // Cancela medição pendente antes de reagendar — coalesce múltiplos triggers
    // (ex: resize + fv-columns-changed no mesmo frame) em uma única medição.
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)

    // rAF duplo: o primeiro aguarda o próximo frame de composição, o segundo
    // garante que o paint do frame anterior foi concluído antes de ler offsetLeft
    // e offsetWidth (leituras de layout).
    this.rafId = requestAnimationFrame(() => {
      this.rafId = requestAnimationFrame(() => {
        this.measureAll()
        this.rafId = null
      })
    })
  }

  private measureAll(): void {
    const rows = this.surface.getVisibleRows()
    if (rows.length === 0) return

    const measurements: OverflowMeasurement[] = []

    for (const { relativePath, tagsContainer, chips } of rows) {
      if (!tagsContainer || chips.length === 0) {
        measurements.push({ relativePath, hiddenCount: 0 })
        continue
      }

      const geoms: ChipGeometry[] = chips.map((chip) => ({
        start: chip.offsetLeft,
        end: chip.offsetLeft + chip.offsetWidth,
      }))

      const { hiddenCount } = computeTagOverflow(geoms, tagsContainer.clientWidth)
      measurements.push({ relativePath, hiddenCount })
    }

    if (measurements.length > 0) {
      this.onMeasured(measurements)
    }
  }
}
