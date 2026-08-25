# Sprint 9 — Core: Geometria de Row Autónoma e Coalescência de Resize

## Tasks

- [x] 1. CSS: Geometria autónoma em `.fr-row` e `.fv-header`
  - Adicionar `width: max-content` e `min-width: 100%` ao bloco `.fr-row` em `FileRow.css`
  - Adicionar `width: max-content` e `min-width: 100%` ao bloco `.fv-header` em `FileView.css`
  - **Files:** `src/renderer/src/components/FileCollection/FileRow.css`, `src/renderer/src/components/FileCollection/FileView.css`

- [x] 2. FileRow.tsx: Remover ResizeObserver, manter medição orientada a eventos
  - Remover instanciação de `new ResizeObserver(...)` e `observer.observe(container)`
  - Remover função `debouncedMeasure` (debounce de 150ms do ResizeObserver)
  - Manter `measure()`, `scheduledMeasure()`, listener de `fv-columns-changed`, cleanup
  - Atualizar cabeçalho arquitetural: invariante 7 (medição orientada a eventos) e adicionar invariante 10 (largura autónoma)
  - **Files:** `src/renderer/src/components/FileCollection/FileRow.tsx`

- [x] 3. FileView.tsx: Listener de `window.resize` com rAF e despacho de `fv-columns-changed`
  - Adicionar `useEffect` que escuta `window.resize` e despacha `fv-columns-changed` com coalescência por rAF
  - Não alterar nenhuma outra lógica
  - **Files:** `src/renderer/src/components/FileCollection/FileView.tsx`

- [x] 4. ColumnResizer.tsx: Coalescência de `onDrag` por `requestAnimationFrame`
  - Declarar `pendingDelta = useRef(0)` e `rafId = useRef<number | null>(null)`
  - Acumular delta no mousemove, agendar rAF para chamar `onDrag` uma vez por frame
  - Flush do delta acumulado no drag end antes de chamar `onDragEnd`
  - Cancelar rAF no cleanup do effect
  - Atualizar cabeçalho arquitetural
  - **Files:** `src/renderer/src/components/shared/ColumnResizer/ColumnResizer.tsx`

- [x] 5. layout-contracts.test.ts: Contratos R-B13
  - Adicionar `describe('R-B13: geometria de row autónoma (Sprint 9)')` com R-B13.1 e R-B13.2
  - Não alterar contratos R-B1 a R-B12
  - **Files:** `src/renderer/src/components/FileCollection/layout-contracts.test.ts`

- [x] 6. FileRow.test.tsx: Atualizar testes para nova arquitetura sem ResizeObserver
  - Remover testes que verificam criação ou comportamento do ResizeObserver
  - Manter testes de overflow de tags (10, 11, 12) e testes de `fv-columns-changed`
  - **Files:** `src/renderer/src/components/FileCollection/FileRow.test.tsx`

- [x] 7. FileView.test.tsx: Teste de despacho de `fv-columns-changed` no resize de janela
  - Adicionar teste: renderizar FileView, simular `window.resize`, verificar que `fv-columns-changed` foi despachado
  - Manter todos os testes existentes
  - **Files:** `src/renderer/src/components/FileCollection/FileView.test.tsx`

- [x] 8. ColumnResizer.test.tsx: Criar testes para coalescência por rAF
  - Criar arquivo de teste para ColumnResizer
  - Testar coalescência: múltiplos mousemove, `onDrag` chamado no máximo uma vez por frame
  - Testar flush no drag end: delta acumulado aplicado antes de `onDragEnd`
  - Testar cleanup: rAF pendente cancelado no unmount
  - **Files:** `src/renderer/src/components/shared/ColumnResizer/ColumnResizer.test.tsx`
