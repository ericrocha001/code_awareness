/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Fornecer funções puras e seguras para leitura e persistência das últimas campanhas selecionadas por repositório no localStorage.

Mapa de Relacionamentos do Script

1. src/renderer/src/components/CodeJourneyView/hooks/useJourneyCreation.ts
   - Tipo: Dependência Inversa
   - Relação: Importa getLastCampaigns e setLastCampaigns para manter persistência da seleção.
   - Criticidade: Média

Invariantes do Script

1. A chave do localStorage deve ser estritamente "codeAwareness:lastCampaign:<repoPath>".
2. Erros de parse no JSON retido no localStorage devem ser capturados sem interromper a aplicação, retornando array vazio.

--- FIM ARQUITETURA DO SCRIPT ---
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
