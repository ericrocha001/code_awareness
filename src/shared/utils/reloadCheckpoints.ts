/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Fornecer função utilitária para recarregar a lista de implementações via IPC e atualizar o estado do React.

Mapa de Relacionamentos do Script

1. src/renderer/src/components/CodeJourneyView/hooks/useJourneyLifecycle.ts
   - Tipo: Dependência Inversa
   - Relação: Executa o recarregamento padronizado após ações administrativas.
   - Criticidade: Alta

2. src/renderer/src/components/CodeJourneyView/hooks/useJourneyRestore.ts
   - Tipo: Dependência Inversa
   - Relação: Executa o recarregamento padronizado após restaurações.
   - Criticidade: Alta

Invariantes do Script

1. Retorna a lista recarregada apenas se a chamada IPC for bem-sucedida e contiver dados válidos; caso contrário, retorna null.
2. Não lança exceções para a chamada IPC.
3. O tipo do parâmetro setCheckpoints aceita tanto valores diretos quanto updaters do React.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { CheckpointSummary } from '../types'

/**
 * Recarrega a lista de implementações do projeto via IPC e atualiza o estado via setCheckpoints.
 * @returns A lista recarregada se a chamada IPC for bem-sucedida; caso contrário, null.
 */
export async function reloadCheckpoints(
  repoPath: string,
  setCheckpoints: (list: CheckpointSummary[]) => void
): Promise<CheckpointSummary[] | null> {
  try {
    const result = await window.codeAwareness.listCheckpoints(repoPath)
    if (result.success && result.data) {
      setCheckpoints(result.data)
      return result.data
    }
    return null
  } catch {
    return null
  }
}
