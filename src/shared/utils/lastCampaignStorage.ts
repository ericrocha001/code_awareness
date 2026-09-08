/*
-T ---
*/

const STORAGE_PREFIX = 'codeAwareness:lastCampaign:'

/**
 * Lê do localStorage as IDs das últimas campanhas selecionadas para um determinado repositório.
 * Aceita null para tolerar ausência de projeto ativo (retorna array vazio).
 */
export function getLastCampaigns(repoPath: string | null): string[] {
  if (!repoPath) return []
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${repoPath}`)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Persiste no localStorage as IDs das últimas campanhas selecionadas para um determinado repositório.
 * Aceita null para tolerar ausência de projeto ativo (no-op silencioso).
 */
export function setLastCampaigns(repoPath: string | null, ids: string[]): void {
  if (!repoPath) return
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${repoPath}`, JSON.stringify(ids))
  } catch {
    // Silencioso em falhas de quota do localStorage
  }
}
