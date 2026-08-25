/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Renderizar a representação em lista compacta de arquivos (FileView), montando as FileRows de forma incremental no DOM via lazy mount acumulativo (lotes de 80, nunca desmontam).
2. Fornecer cabeçalho sticky dentro da superfície de scroll bidirecional única, com alinhamento rigoroso às colunas de FileRow.
3. Fornecer a FileViewMeasurementSurface concreta que desacopla o FileViewLayoutObserver da estrutura DOM.
4. Injetar tags pré-resolvidas (tagsByFile) nas FileRows — preparadas pelo useFileCollectionData.

Mapa de Relacionamentos do Script

1. types.ts
   - Tipo: Contrato / Interface
   - Relação: Importa FileCardFile e RowActionType.
   - Criticidade: Alta

2. FileRow.tsx
   - Tipo: Dependência Direta
   - Relação: Componente atômico renderizado em cada linha da lista.
   - Criticidade: Alta

3. controllers/useFileViewLazyMount.ts
   - Tipo: Dependência Direta
   - Relação: Hook que fornece mountedCount, sentinelRef e hasMore para o lazy mount acumulativo.
   - Criticidade: Alta

4. controllers/FileViewLayoutObserver.ts
   - Tipo: Dependência Direta
   - Relação: Observer de layout consumindo a FileViewMeasurementSurface implementada aqui.
   - Criticidade: Alta

5. useFileCollectionData.ts
   - Tipo: Dependência Inversa
   - Relação: Produz tagsByFile injetado como prop.
   - Criticidade: Alta

Invariantes do Script

1. O cabeçalho (FileViewHeader) é o primeiro filho da superfície de scroll bidirecional (.fv-scroll-container), sticky no topo.
2. Quando a lista de arquivos estiver vazia, exibe mensagem de estado vazio mantendo o cabeçalho visível.
3. O evento `window.resize` despacha `fv-columns-changed` no `.fv-container` com coalescência por rAF.
4. onRowAction chega estável do pai e é repassado diretamente ao FileRow — preserva o React.memo.
5. O FileViewLayoutObserver é re-medido sempre que a lista de arquivos muda e sempre que novas rows são montadas via lazy mount (efeito próprio observando mountedCount).
6. measurementSurface é memoizada com deps [] — referência permanente evita re-instanciação do observer.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileRow } from './FileRow'
import { ColumnResizer } from '../shared/ColumnResizer/ColumnResizer'
import {
  buildFileViewTemplate,
  sanitizeColumnWidths,
  FILE_VIEW_RESIZABLE_COLUMNS,
  FileViewColumnKey
} from './fileViewColumns'
import { useProjectPreferences } from '../../hooks/useProjectPreferences'
import {
  FileViewLayoutObserver,
  type FileViewMeasurementSurface,
  type OverflowMeasurement
} from './controllers/FileViewLayoutObserver'
import { useFileViewLazyMount } from './controllers/useFileViewLazyMount'
import type { TagRenderData } from './models/FileRowModel'
import type { FileCardFile, RowActionType } from './types'
import './FileView.css'

export interface FileViewProps {
  files: FileCardFile[]
  /** Tags pré-resolvidas por relativePath (produzidas pelo useFileCollectionData). */
  tagsByFile: Map<string, readonly TagRenderData[]>
  isSelected: (relativePath: string) => boolean
  /** Callback consolidado de interações da row — repassado diretamente ao FileRow. */
  onRowAction: (type: RowActionType, relativePath: string, anchor?: HTMLElement) => void
  /** Projeto ativo — habilita carregar/persistir larguras de coluna por projeto. */
  repoPath?: string
}

/** Referência estável para arquivos sem tags — preserva o comparador do FileRow. */
const EMPTY_TAGS: readonly TagRenderData[] = []

interface FileViewHeaderProps {
  onColumnDrag: (key: FileViewColumnKey, delta: number) => void
  onDragEnd: () => void
}

const RESIZER_BY_COLUMN: Record<FileViewColumnKey, string> = {
  toggle: 'fv-col-toggle',
  identity: 'fv-col-identity',
  path: 'fv-col-path',
  tags: 'fv-col-tags',
  tokens: 'fv-col-tokens'
}

const COLUMN_LABELS: Record<FileViewColumnKey, string> = {
  toggle: 'Seleção',
  identity: 'Arquivo',
  path: 'Caminho',
  tags: 'Tags',
  tokens: 'Tokens'
}

const FileViewHeader = React.forwardRef<HTMLDivElement, FileViewHeaderProps>(
  ({ onColumnDrag, onDragEnd }, ref) => (
    <div ref={ref} className="fv-header">
      {FILE_VIEW_RESIZABLE_COLUMNS.map((key) => (
        <div key={key} className={RESIZER_BY_COLUMN[key]}>
          {COLUMN_LABELS[key]}
          <span data-testid={`resizer-${key}`} className="fv-resizer-slot">
            <ColumnResizer onDrag={(delta) => onColumnDrag(key, delta)} onDragEnd={onDragEnd} />
          </span>
        </div>
      ))}
    </div>
  )
)
FileViewHeader.displayName = 'FileViewHeader'

const FileViewInner: React.FC<FileViewProps> = ({
  files,
  tagsByFile,
  isSelected,
  onRowAction,
  repoPath
}) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)

  const { preferences, updateFileViewColumnWidths } = useProjectPreferences(repoPath ?? null)
  const [widths, setWidths] = useState<Partial<Record<FileViewColumnKey, number>>>(() =>
    sanitizeColumnWidths(preferences?.fileViewColumnWidths)
  )
  const widthsRef = useRef(widths)

  // hiddenCountMap: keyed por relativePath, atualizado pelo FileViewLayoutObserver.
  // Apenas rows cujo hiddenCount mudou re-renderizam (memo custom do FileRow).
  const [hiddenCountMap, setHiddenCountMap] = useState<Record<string, number>>({})

  // Sprint 4 — lazy mount acumulativo: controla quantas FileRows estão montadas.
  // Deve ser chamado antes de qualquer lógica que dependa de mountedCount.
  const { mountedCount, sentinelRef, hasMore } = useFileViewLazyMount({ totalCount: files.length })

  // Callback estável (deps=[]) — setHiddenCountMap tem referência estável do useState.
  // Evita re-instanciação do controller a cada render do FileView.
  // Otimização: não cria novo objeto quando nenhum valor mudou (preserva referência).
  const handleOverflowMeasured = useCallback((measurements: OverflowMeasurement[]) => {
    setHiddenCountMap((prev) => {
      let changed = false
      const next = { ...prev }
      for (const m of measurements) {
        if (next[m.relativePath] !== m.hiddenCount) {
          next[m.relativePath] = m.hiddenCount
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const controllerRef = useRef<FileViewLayoutObserver | null>(null)

  // Sprint 6 — FileViewMeasurementSurface concreta: isola o FileViewLayoutObserver
  // da estrutura DOM da FileView (o observer não conhece seletores concretos).
  // Memoizada com deps [] — referência permanente evita re-instanciação.
  const measurementSurface = useMemo<FileViewMeasurementSurface>(
    () => ({
      getScrollContainer: () =>
        rootRef.current?.querySelector<HTMLElement>('.fv-scroll-container') ?? null,
      // O evento fv-columns-changed é despachado no .fv-container (root).
      getEventTarget: () => rootRef.current,
      // Retorna apenas rows visíveis na viewport do scroll container — com
      // content-visibility: auto, rows fora dela têm geometria inválida (zeros).
      getVisibleRows: () => {
        const root = rootRef.current
        if (!root) return []
        const scroll = root.querySelector<HTMLElement>('.fv-scroll-container')
        const containerRect = scroll?.getBoundingClientRect() ?? null
        const rowEls = root.querySelectorAll<HTMLElement>('.fr-row[data-relative-path]')
        if (rowEls.length === 0) return []

        const rows: ReturnType<FileViewMeasurementSurface['getVisibleRows']> = []
        rowEls.forEach((row) => {
          if (containerRect) {
            const rowRect = row.getBoundingClientRect()
            const isVisible =
              rowRect.bottom >= containerRect.top && rowRect.top <= containerRect.bottom
            if (!isVisible) return
          }
          rows.push({
            relativePath: row.dataset.relativePath!,
            tagsContainer: row.querySelector<HTMLElement>('.fr-tags'),
            chips: Array.from(row.querySelectorAll<HTMLElement>('.tag-chip'))
          })
        })
        return rows
      }
    }),
    []
  )

  // Sincroniza com preferências carregadas async (load inicial / troca de projeto)
  useEffect(() => {
    const sanitized = sanitizeColumnWidths(preferences?.fileViewColumnWidths)
    widthsRef.current = sanitized
    setWidths(sanitized)
    rootRef.current?.style.setProperty('--fv-grid-template', buildFileViewTemplate(sanitized))
  }, [preferences?.fileViewColumnWidths])

  const DEFAULT_INITIAL_WIDTHS: Record<FileViewColumnKey, number> = {
    toggle: 48,
    identity: 180,
    path: 120,
    tags: 200,
    tokens: 120
  }

  const handleColumnDrag = useCallback((key: FileViewColumnKey, delta: number) => {
    const current = widthsRef.current[key] ?? DEFAULT_INITIAL_WIDTHS[key]
    const nextWidth = Math.max(0, Math.round(current + delta))
    const next = { ...widthsRef.current, [key]: nextWidth }
    widthsRef.current = next
    rootRef.current?.style.setProperty('--fv-grid-template', buildFileViewTemplate(next))
  }, [])

  // Sprint 9: escuta window.resize e despacha 'fv-columns-changed' no .fv-container
  // com coalescência por rAF, para que as FileRows re-meçam tags após resize de janela.
  useEffect(() => {
    let rafId: number | null = null
    const handleResize = (): void => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rootRef.current?.dispatchEvent(new CustomEvent('fv-columns-changed', { bubbles: true }))
        rafId = null
      })
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [])

  const handleDragEnd = useCallback(() => {
    setWidths(widthsRef.current)
    updateFileViewColumnWidths(widthsRef.current)
    rootRef.current?.dispatchEvent(new CustomEvent('fv-columns-changed', { bubbles: true }))
  }, [setWidths, updateFileViewColumnWidths])

  // Instancia o FileViewLayoutObserver ao montar e o dispose ao desmontar.
  // handleOverflowMeasured e measurementSurface são estáveis (useCallback/useMemo
  // com deps=[]), então este effect só executa uma vez por montagem do FileView.
  useEffect(() => {
    if (!rootRef.current) return
    const observer = new FileViewLayoutObserver(measurementSurface, handleOverflowMeasured)
    controllerRef.current = observer
    observer.mount()
    return () => {
      observer.dispose()
      controllerRef.current = null
    }
  }, [handleOverflowMeasured, measurementSurface])

  // Re-mede quando a lista de arquivos muda (novas rows montadas, rows removidas).
  // O React garante que o DOM já foi atualizado antes deste efeito rodar.
  useEffect(() => {
    controllerRef.current?.remeasure()
  }, [files])

  // Re-mede quando novas rows são montadas via lazy mount.
  // O controller precisa medir overflow das rows recém-adicionadas ao DOM.
  useEffect(() => {
    controllerRef.current?.remeasure()
  }, [mountedCount])

  if (files.length === 0) {
    return (
      <div ref={rootRef} className="fv-container">
        <div className="fv-scroll-container">
          <FileViewHeader
            ref={headerRef}
            onColumnDrag={handleColumnDrag}
            onDragEnd={handleDragEnd}
          />
          <div className="fv-empty">Nenhum arquivo encontrado</div>
        </div>
      </div>
    )
  }

  return (
    <div ref={rootRef} className="fv-container">
      <div className="fv-scroll-container">
        <FileViewHeader
          ref={headerRef}
          onColumnDrag={handleColumnDrag}
          onDragEnd={handleDragEnd}
        />
        {/* tagsByFile.get() já retorna EMPTY_TAGS (referência estável) para
            arquivos sem tags — preparado pelo useFileCollectionData. */}
        {files.slice(0, mountedCount).map((file) => (
          <FileRow
            key={file.relativePath}
            file={file}
            tags={tagsByFile.get(file.relativePath) ?? EMPTY_TAGS}
            isSelected={isSelected(file.relativePath)}
            hiddenCount={hiddenCountMap[file.relativePath] ?? 0}
            onRowAction={onRowAction}
          />
        ))}
        {hasMore && (
          <div
            ref={sentinelRef}
            className="fv-sentinel"
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  )
}

export const FileView = React.memo(FileViewInner)
