/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Derivar o status de cada checkpoint (active, restored, reverted) a partir da lista de sumários com restoredAt.
2. Determinar os IDs de comparação de diff com ciência de restauração, usando o ponto de restauração como base para o primeiro checkpoint pós-restauração.
3. Montar o documento de auditoria em quatro níveis (Prompt + Diff, Resultado + Prompt + Diff, Instruções + Prompt + Diff, Auditoria Completa).
4. Concentrar toda a lógica pura de cálculo da restauração no renderer, isolada em um único arquivo removível.

Mapa de Relacionamentos do Script

1. ../../../../shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece os tipos CheckpointStatus e CheckpointSummary.
   - Criticidade: Alta

2. ./checkpointUtils.ts
   - Tipo: Dependência Direta
   - Relação: Consome getCompareIds como fallback quando não há ponto de restauração.
   - Criticidade: Alta

Invariantes do Script

1. Todas as funções exportadas são puras — sem side effects, sem estado global, sem IPC.
2. A derivação de status usa duas datas (createdAt e restoredAt) — trabalho criado após a ação de restaurar é active, nunca reverted.
3. getRestoreAwareCompareIds delega ao getCompareIds original quando não há ponto de restauração, produzindo resultado idêntico.
4. Campos opcionais ausentes na auditoria (instruções, resultado) são tratados com aviso explícito, nunca omitidos silenciosamente.
5. buildAuditDocument nunca lança erro para entradas válidas.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { CheckpointStatus, CheckpointSummary } from '../../../../shared/types'
import { getCompareIds } from './checkpointUtils'

// ─── Tipo do nível de cópia/exportação ──────────────────────────────────

/** Fonte única de verdade dos níveis de cópia/exportação do documento de auditoria. */
export type AuditCopyLevel = 1 | 2 | 3 | 4

// ─── Constantes compartilhadas ──────────────────────────────────────────

/** Rótulos dos quatro níveis de cópia/exportação do documento de auditoria. Fonte única de verdade. */
export const COPY_LEVELS: Array<{ level: AuditCopyLevel; label: string }> = [
  { level: 1, label: 'Prompt + Diffs' },
  { level: 2, label: 'Resultado + Prompt + Diffs' },
  { level: 3, label: 'Instruções + Prompt + Diffs' },
  { level: 4, label: 'Auditoria Completa' }
]

// ─── Tipos internos (isolados neste arquivo) ─────────────────────────────

export interface CheckpointStatusInfo {
  status: CheckpointStatus
  statusAt: string
}

export interface AuditDocumentInput {
  name: string
  createdAt: string
  instructions?: string
  agentSummary?: string
  status?: CheckpointStatusInfo
  auditPrompt: string
  diffMarkdown: string
}

// ─── Utilitários Privados ────────────────────────────────────────────────

/**
 * Localiza o ponto de restauração mais recente na lista de sumários.
 * Se houver múltiplos checkpoints com restoredAt (dados corrompidos),
 * retorna o mais recente (restoredAt mais alto) como defesa em profundidade.
 * Retorna null se não houver nenhum.
 */
function findRestorePoint(summaries: CheckpointSummary[]): CheckpointSummary | null {
  const restoredSummaries = summaries
    .filter(cp => cp.restoredAt !== null && cp.restoredAt !== undefined)
    .sort((a, b) => new Date(b.restoredAt!).getTime() - new Date(a.restoredAt!).getTime())

  return restoredSummaries.length > 0 ? restoredSummaries[0] : null
}

// ─── Derivação de Status ─────────────────────────────────────────────────

/**
 * Deriva o status de cada checkpoint a partir da lista de sumários.
 *
 * Regras:
 * - Se não há ponto de restauração: todos são active.
 * - Se há ponto de restauração R, para cada checkpoint X:
 *   - X é o próprio R → restored
 *   - R.createdAt < X.createdAt < R.restoredAt → reverted
 *   - X.createdAt >= R.restoredAt → active (trabalho novo pós-restauração)
 *   - X.createdAt < R.createdAt → active
 *
 * Função pura e determinística: depende apenas dos dados de entrada.
 */
export function deriveCheckpointStatuses(
  summaries: CheckpointSummary[]
): Record<string, CheckpointStatusInfo> {
  const result: Record<string, CheckpointStatusInfo> = {}

  if (summaries.length === 0) {
    return result
  }

  const restorePoint = findRestorePoint(summaries)

  // Se não há ponto de restauração, todos são active
  if (!restorePoint) {
    for (const cp of summaries) {
      result[cp.id] = { status: 'active', statusAt: cp.createdAt }
    }
    return result
  }

  const rCreatedAt = new Date(restorePoint.createdAt).getTime()
  const rRestoredAt = new Date(restorePoint.restoredAt!).getTime()

  for (const cp of summaries) {
    const xCreatedAt = new Date(cp.createdAt).getTime()

    if (cp.id === restorePoint.id) {
      // O próprio ponto de restauração
      result[cp.id] = { status: 'restored', statusAt: restorePoint.restoredAt! }
    } else if (xCreatedAt > rCreatedAt && xCreatedAt < rRestoredAt) {
      // Criado depois do checkpoint de restauração mas antes da ação de restaurar → reverted
      result[cp.id] = { status: 'reverted', statusAt: restorePoint.restoredAt! }
    } else {
      // Criado antes do ponto OU depois da ação de restaurar → active
      result[cp.id] = { status: 'active', statusAt: cp.createdAt }
    }
  }

  return result
}

// ─── Comparação ciente de restauração ────────────────────────────────────

/**
 * Determina os IDs de comparação para diff com ciência de restauração.
 *
 * Se há um ponto de restauração R e o checkpoint selecionado X é o primeiro
 * trabalho pós-restauração (X.createdAt > R.restoredAt e o anterior imediato P
 * tem P.createdAt <= R.restoredAt), retorna { fromCheckpointId: R.id, toCheckpointId: X.id }
 * para que o diff mostre apenas o trabalho novo desde a restauração.
 *
 * Caso contrário, delega ao getCompareIds original.
 */
export function getRestoreAwareCompareIds(
  checkpoints: CheckpointSummary[],
  selectedCheckpointId: string
): { fromCheckpointId: string; toCheckpointId: string } {
  const restorePoint = findRestorePoint(checkpoints)

  // Se não há ponto de restauração, delega ao comportamento original
  if (!restorePoint) {
    return getCompareIds(checkpoints, selectedCheckpointId)
  }

  const selected = checkpoints.find(cp => cp.id === selectedCheckpointId)
  if (!selected) {
    return getCompareIds(checkpoints, selectedCheckpointId)
  }

  const rRestoredAt = new Date(restorePoint.restoredAt!).getTime()
  const xCreatedAt = new Date(selected.createdAt).getTime()

  // Verifica se o selecionado é o primeiro checkpoint pós-restauração
  if (xCreatedAt > rRestoredAt) {
    const selectedIndex = checkpoints.findIndex(cp => cp.id === selectedCheckpointId)

    // O anterior imediato (índice + 1, pois a lista é decrescente por data)
    const previousCp = selectedIndex >= 0 && selectedIndex + 1 < checkpoints.length
      ? checkpoints[selectedIndex + 1]
      : null

    if (previousCp) {
      const pCreatedAt = new Date(previousCp.createdAt).getTime()

      // Se o anterior foi criado antes ou no momento da restauração,
      // este é o primeiro pós-restauração
      if (pCreatedAt <= rRestoredAt) {
        return {
          fromCheckpointId: restorePoint.id,
          toCheckpointId: selectedCheckpointId
        }
      }
    }
  }

  // Caso contrário, delega ao comportamento original
  return getCompareIds(checkpoints, selectedCheckpointId)
}

// ─── Documento de Auditoria ──────────────────────────────────────────────

/**
 * Traduz um status + statusAt para um rótulo legível em português.
 */
function formatStatusLabel(status: CheckpointStatus, statusAt: string): string {
  switch (status) {
    case 'restored':
      return `Restaurado em ${formatDate(statusAt)}`
    case 'reverted':
      return `Revertido em ${formatDate(statusAt)}`
    case 'active':
      return `Implementado desde ${formatDate(statusAt)}`
  }
}

/**
 * Formata uma string ISO para data legível em português (dd/mm/aaaa hh:mm).
 */
function formatDate(isoDate: string): string {
  const d = new Date(isoDate)
  // BUGFIX: Proteção contra datas inválidas
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
 * Monta o documento de auditoria em Markdown.
 *
 * Nível 1 — Prompt + Diffs: prompt de auditoria + markdown do diff.
 * Nível 2 — Resultado + Prompt + Diffs: resultado do agente + prompt de auditoria + markdown do diff.
 * Nível 3 — Instruções + Prompt + Diffs: instruções + prompt de auditoria + markdown do diff.
 * Nível 4 — Auditoria Completa: nome da ação com data → instruções → resultado do agente → status com data → prompt de auditoria → separador → markdown do diff.
 *
 * Função pura: não tem side effects nem estado.
 */
export function buildAuditDocument(input: AuditDocumentInput, level: AuditCopyLevel): string {
  const { name, createdAt, instructions, agentSummary, status, auditPrompt, diffMarkdown } = input

  const dateLabel = formatDate(createdAt)

  // Monta as seções comuns
  const sections: string[] = []

  if (level === 4) {
    // Nível 4 — Auditoria Completa: começa com nome + data
    sections.push(`# 📋 Implementação: "${name}"`)
    sections.push(`**Data:** ${dateLabel}`)
    sections.push('')
  }

  // Instruções (Nível 3 e 4)
  if (level >= 3) {
    const instructionsText = instructions && instructions.trim().length > 0
      ? instructions
      : '*Sem instruções registradas.*'
    sections.push(`# 📝 Instrução`)
    sections.push(instructionsText)
    sections.push('')
  }

  // Resultado do agente (Nível 2 e 4)
  if (level === 2 || level === 4) {
    const agentSummaryText = agentSummary && agentSummary.trim().length > 0
      ? agentSummary
      : '*Sem resumo do agente registrado.*'
    sections.push(`# 🤖 Resultado`)
    sections.push(agentSummaryText)
    sections.push('')
  }

  // Status (apenas Nível 4)
  if (level === 4 && status) {
    sections.push(`# 📌 Status`)
    sections.push(formatStatusLabel(status.status, status.statusAt))
    sections.push('')
  }

  // Prompt de auditoria (todos os níveis)
  sections.push(`# 🔍 Prompt de Auditoria`)
  sections.push(auditPrompt || '*Nenhum prompt de auditoria fornecido.*')
  sections.push('')

  // Separador (apenas Nível 4)
  if (level === 4) {
    sections.push(`---`)
    sections.push('')
  }

  // Diff (todos os níveis)
  sections.push(`# 📊 Diff Semântico`)
  sections.push(diffMarkdown || '*Nenhum diff disponível.*')

  return sections.join('\n')
}