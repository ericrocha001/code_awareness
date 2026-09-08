/*
-T ---
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
