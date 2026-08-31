/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Declarar a interface ContextProvider como contrato abstrato entre o orquestrador Code Dash e os provedores de conteúdo.
2. Definir os tipos de opções de execução e resultados estruturados de provedores.

Mapa de Relacionamentos do Script

1. src/shared/types/dash-types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome DashPlannedItem para tipar os itens entregues a cada provedor.
   - Criticidade: Alta

2. src/main/core/dash/dash-service.ts
   - Tipo: Contrato / Interface
   - Relação: O orquestrador interage com provedores através da interface ContextProvider.
   - Criticidade: Alta

Invariantes do Script

1. Conter estritamente definições de tipos e interfaces sem código executável ou efeitos colaterais.
2. Toda implementação de ContextProvider deve retornar um mapa indexado pela posição original do item no request.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type { DashPlannedItem } from '../../../../shared/types/dash-types'

export interface DashExecutionOptions {
  repoPath: string
  signal?: AbortSignal
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
