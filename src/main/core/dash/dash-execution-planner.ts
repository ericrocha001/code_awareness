/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Planejar a execução de montagem de contexto a partir de requisições validadas e relatórios de resolução.
2. Preservar estritamente a ordem original dos itens do pedido descartando itens que falharam.

Mapa de Relacionamentos do Script

1. src/shared/types/dash-types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome DashRequest, DashResolutionReport, DashContextPlan e DashPlannedItem.
   - Criticidade: Alta

2. src/main/core/dash/dash-context-assembler.ts
   - Tipo: Fluxo de Dados
   - Relação: Fornece o plano gerado DashContextPlan para composição do documento final.
   - Criticidade: Alta

Invariantes do Script

1. Operar como função pura sem efeitos colaterais, acessos a filesystem ou mutações de estado.
2. A ordenação dos itens em plannedItems deve coincidir estritamente com as posições originais no request.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type {
  DashContextPlan,
  DashPlannedItem,
  DashRequest,
  DashResolutionReport
} from '../../../shared/types/dash-types'

/**
 * Transforma uma requisição validada e seu relatório de resolução em um plano de execução determinístico.
 */
export function planExecution(
  request: DashRequest,
  resolution: DashResolutionReport
): DashContextPlan {
  const failedIndices = new Set(resolution.failures.map((f) => f.index))
  const resolvedList = resolution.request?.items ?? []
  let resolvedCursor = 0

  const plannedItems: DashPlannedItem[] = []

  for (let i = 0; i < request.items.length; i++) {
    if (failedIndices.has(i)) {
      continue
    }

    const originalItem = request.items[i]
    const resolvedItem = resolvedList[resolvedCursor]
    resolvedCursor++

    const plannedPath = resolvedItem?.path ?? originalItem.path

    plannedItems.push({
      index: i,
      path: plannedPath,
      representation: originalItem.representation
    })
  }

  return {
    metadata: {
      requestedCount: request.items.length,
      resolvedCount: plannedItems.length,
      failedCount: resolution.failures.length
    },
    plannedItems,
    failures: resolution.failures
  }
}
