/*
-T ---
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
