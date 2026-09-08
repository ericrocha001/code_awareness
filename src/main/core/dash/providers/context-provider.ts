/*
-T ---
*/

import type { DashPlannedItem } from '../../../../shared/types/dash-types'
import type { DashSettings } from '../../../../shared/types'

export interface DashExecutionOptions {
  repoPath: string
  signal?: AbortSignal
  /** Configurações globais de economia aplicadas como merge nos providers (opcional). */
  settings?: DashSettings
}

export interface DashProviderFailure {
  index: number
  reason: string
}

export interface DashProviderResult {
  contents: Map<number, string>
  failures: DashProviderFailure[]
}

export interface ContextProvider {
  provide(
    items: DashPlannedItem[],
    options: DashExecutionOptions
  ): Promise<DashProviderResult>
}
