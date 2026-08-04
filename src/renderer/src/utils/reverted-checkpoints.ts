/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Função pura utilitária para calcular o nome das implementações que serão revertidas por um ponto de restauração.

Mapa de Relacionamentos do Script

1. ../components/CodeJourneyView/hooks/useJourneyRestore.ts
   - Tipo: Dependência Inversa
   - Relação: Consome getRevertedCheckpointNames no memo de restauração.
   - Criticidade: Média

Invariantes do Script

1. Função pura e determinística.
2. Retorna array ordenado de forma ascendente por data de criação das implementações mais recentes que o alvo.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { CheckpointSummary } from '../../../shared/types'

/**
 * Calcula os nomes dos checkpoints criados após o targetId (excluindo-o), ordenando da mais antiga para a mais recente.
 */
export function getRevertedCheckpointNames(checkpoints: CheckpointSummary[], targetId: string | null): string[] {
  if (!targetId) return []
  const targetCp = checkpoints.find(c => c.id === targetId)
  if (!targetCp) return []

  const targetTime = new Date(targetCp.createdAt).getTime()
  return checkpoints
    .filter(c => c.id !== targetId && new Date(c.createdAt).getTime() > targetTime)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map(c => c.name)
}
