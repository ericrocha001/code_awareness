/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Exportar funções puras de cálculo e formatação reutilizadas pelos componentes da aba Code Checkpoints.
2. Exportar a lógica de determinação dos IDs de comparação (getCompareIds).
3. Exportar a função de formatação de data relativa (getRelativeDate).

Mapa de Relacionamentos do Script

1. CheckpointDrawer.tsx
   - Tipo: Dependência Direta
   - Relação: Consome estimateDiffTokens, formatTokens e calculateTokens.
   - Criticidade: Alta

2. CodeJourneyView.tsx
   - Tipo: Dependência Direta
   - Relação: Consome getCompareIds, estimateDiffTokens e formatTokens.
   - Criticidade: Alta

3. CheckpointTimeline.tsx
   - Tipo: Dependência Direta
   - Relação: Consome getRelativeDate para exibir datas relativas na timeline.
   - Criticidade: Média

Invariantes do Script

1. Todas as funções exportadas são puras — sem side effects nem estado global.
2. estimateDiffTokens nunca deve retornar valor negativo.
3. getRelativeDate nunca deve retornar string vazia.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { CheckpointDiffFile, CheckpointSummary, CampaignStatus } from '../../../../shared/types'

/**
 * Formata uma string ISO para data/hora legível em português (dd/mm/aaaa hh:mm).
 */
export function formatDate(isoDate: string): string {
  const d = new Date(isoDate)
  if (isNaN(d.getTime())) return 'data desconhecida'
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * Calcula estimativa de tokens de uma string.
 * Usa a heurística: 1 token ≈ 4 caracteres (média para código-fonte).
 */
export const calculateTokens = (content: string): number => {
  return Math.ceil(content.length / 4)
}

/**
 * Estima tokens do diff baseado nos arquivos alterados selecionados.
 * Usa os hunks de diff dos changedFiles para calcular sem gerar markdown completo.
 * Função pura: não depende de estado ou props.
 */
export function estimateDiffTokens(files: CheckpointDiffFile[], selectedPaths: Set<string>): number {
  let totalChars = 0

  for (const file of files) {
    if (!selectedPaths.has(file.relativePath)) continue

    // Cabeçalho do arquivo no markdown
    totalChars += `## 📄 \`${file.relativePath}\` (${file.changeType})\n\n`.length

    // Para cada hunk, estima o conteúdo
    for (const hunk of file.hunks) {
      totalChars += `### 🔍 Hunk (Linhas ${hunk.oldStart}-${hunk.oldStart + hunk.oldLines})\n\n`.length
      totalChars += '#### 🟥 [Removido]\n```diff\n'.length
      totalChars += hunk.removedLines.join('\n').length + hunk.removedLines.length
      totalChars += '```\n\n'.length

      totalChars += '#### 🟩 [Adicionado]\n```diff\n'.length
      totalChars += hunk.addedLines.join('\n').length + hunk.addedLines.length
      totalChars += '```\n\n'.length
    }
  }

  return Math.ceil(totalChars / 4)
}

/**
 * Formata contagem de tokens como "1.2k" para valores >= 1000.
 */
export function formatTokens(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  return String(count)
}

/**
 * Determina os IDs de checkpoint para comparação na ordem correta.
 * Retorna { fromCheckpointId, toCheckpointId } onde:
 * - fromCheckpointId = checkpoint mais antigo (origem)
 * - toCheckpointId = checkpoint mais recente (destino)
 *
 * Casos:
 * 1. Primeiro checkpoint (mais antigo): compara com disco
 *    - Retorna { fromCheckpointId: selected, toCheckpointId: selected }
 * 2. Demais checkpoints: compara com checkpoint anterior
 *    - Retorna { fromCheckpointId: anterior, toCheckpointId: selecionado }
 */
export function getCompareIds(
  checkpoints: CheckpointSummary[],
  selectedCheckpointId: string
): { fromCheckpointId: string; toCheckpointId: string } {
  const selectedIndex = checkpoints.findIndex(cp => cp.id === selectedCheckpointId)

  if (selectedIndex === checkpoints.length - 1) {
    // Primeiro checkpoint (mais antigo) — comparar com disco
    return {
      fromCheckpointId: selectedCheckpointId,
      toCheckpointId: selectedCheckpointId
    }
  }

  // Demais — comparar com anterior (mais antigo)
  return {
    fromCheckpointId: checkpoints[selectedIndex + 1].id,
    toCheckpointId: selectedCheckpointId
  }
}

/**
 * Converte um timestamp ISO em label de data relativa legível.
 * Retorna strings em português: HOJE, ONTEM, X DIAS ATRÁS, etc.
 *
 * Função pura: depende apenas do parâmetro de entrada e do clock atual.
 *
 * @param createdAt - String ISO de data (ex: "2026-07-24T20:17:35.000Z")
 * @returns Label relativo em português
 */
export function getRelativeDate(createdAt: string): string {
  const now = new Date()
  const date = new Date(createdAt)
  // BUGFIX: Proteção contra datas inválidas ou futuras (clock skew/dados corrompidos)
  if (isNaN(date.getTime()) || date.getTime() > now.getTime()) return 'HOJE'

  // Normaliza ambas as datas para meia-noite local (dias de calendário)
  // para evitar divergências causadas por janelas de 24 horas
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  const diffMs = today.getTime() - targetDay.getTime()
  // Math.round em vez de Math.floor para lidar corretamente com transições
  // de horário de verão (diferenças de 23h ou 25h em vez de 24h exatas)
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays <= 0) return 'HOJE'
  if (diffDays === 1) return 'ONTEM'
  if (diffDays < 7) return `${diffDays} DIAS ATRÁS`
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7)
    return weeks === 1 ? '1 SEMANA ATRÁS' : `${weeks} SEMANAS ATRÁS`
  }
  if (diffDays < 365) {
    const months = Math.floor(diffDays / 30)
    return months === 1 ? '1 MÊS ATRÁS' : `${months} MESES ATRÁS`
  }
  const years = Math.floor(diffDays / 365)
  return years === 1 ? '1 ANO ATRÁS' : `${years} ANOS ATRÁS`
}

/**
 * Retorna a cor da campanha baseada no status.
 */
export function getCampaignColor(status: CampaignStatus): string {
  return status === 'completed' ? '#4ade80' : '#fbbf24'
}

