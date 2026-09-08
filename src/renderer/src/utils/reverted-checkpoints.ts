/*
-T ---
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
