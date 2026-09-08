/*
-T ---
*/

import type { IntegrityReportInput, IntegrityIssue } from '../../../shared/types'

const TYPE_LABELS: Record<string, string> = {
  hash_mismatch: 'Hash Mismatch (Divergência no Conteúdo)',
  file_missing: 'File Missing (Arquivo Ausente no Disco)',
  file_unexpected: 'File Unexpected (Arquivo Novo Não Indexado)',
  orphan_element: 'Orphan Element (Elemento Sem Arquivo Pai)',
  invalid_relationship: 'Invalid Relationship (Relacionamento Quebrado)',
  database_inconsistency: 'Database Inconsistency (Inconsistência Interna)'
}

/** Agrupa issues por tipo para exibição estruturada. */
function groupIssuesByType(issues: IntegrityIssue[]): Map<string, IntegrityIssue[]> {
  const map = new Map<string, IntegrityIssue[]>()
  for (const issue of issues) {
    const list = map.get(issue.type) || []
    list.push(issue)
    map.set(issue.type, list)
  }
  return map
}

/** Formata data ISO para exibição legível em português do Brasil. */
function formatDate(isoDate: string): string {
  const date = new Date(isoDate)
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * Gera Markdown estruturado do relatório de integridade.
 *
 * Estrutura:
 * - Cabeçalho com projeto e data
 * - Resumo executivo (status, contagens, duração)
 * - Lista de inconsistências agrupadas por tipo
 * - Resultado da reparação (se executada)
 *
 * @param input Dados do relatório (resultado da verificação + reparação opcional)
 * @returns String Markdown formatada
 */
export function buildIntegrityReportMarkdown(input: IntegrityReportInput): string {
  const lines: string[] = []

  // Cabeçalho
  lines.push(`# Relatório de Integridade: ${input.projectName}`)
  lines.push('')
  lines.push(`- **Repositório:** \`${input.repoPath}\``)
  lines.push(`- **Gerado em:** ${formatDate(input.generatedAt)}`)
  lines.push(`- **Status:** ${input.checkResult.status === 'healthy' ? '✓ Íntegro' : '⚠️ Inconsistências encontradas'}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  // Resumo Executivo
  lines.push('## Resumo Executivo')
  lines.push('')
  lines.push(`- **Arquivos verificados:** ${input.checkResult.filesChecked}`)
  lines.push(`- **Hashes verificados:** ${input.checkResult.hashesChecked}`)
  lines.push(`- **Hashes divergentes:** ${input.checkResult.hashesMismatched}`)
  lines.push(`- **Arquivos ausentes:** ${input.checkResult.filesMissing}`)
  lines.push(`- **Arquivos inesperados:** ${input.checkResult.filesUnexpected}`)
  lines.push(`- **Elementos órfãos:** ${input.checkResult.orphanElements}`)
  lines.push(`- **Relacionamentos inválidos:** ${input.checkResult.invalidRelationships}`)
  lines.push(`- **Inconsistências de banco:** ${input.checkResult.databaseInconsistencies}`)
  lines.push(`- **Duração:** ${input.checkResult.durationMs}ms`)
  lines.push('')

  // Inconsistências Encontradas
  if (input.checkResult.details.length > 0) {
    lines.push('---')
    lines.push('')
    lines.push('## Inconsistências Encontradas')
    lines.push('')

    const grouped = groupIssuesByType(input.checkResult.details)

    for (const [type, issues] of grouped.entries()) {
      const label = TYPE_LABELS[type] || type
      lines.push(`### ${label} (${issues.length})`)
      lines.push('')

      for (const issue of issues) {
        lines.push(`- **${issue.target}**: ${issue.description}`)
      }
      lines.push('')
    }
  }

  // Resultado da Reparação
  if (input.repairResult) {
    lines.push('---')
    lines.push('')
    lines.push('## Resultado da Reparação')
    lines.push('')
    lines.push(`- **Status:** ${
      input.repairResult.status === 'success' ? '✓ Sucesso' :
      input.repairResult.status === 'partial' ? '⚠️ Parcial' : '✗ Falha'
    }`)
    lines.push(`- **Problemas corrigidos:** ${input.repairResult.issuesFixed}`)
    lines.push(`- **Problemas restantes:** ${input.repairResult.issuesRemaining}`)
    lines.push(`- **Duração:** ${input.repairResult.durationMs}ms`)
    lines.push('')

    if (input.repairResult.repairs.length > 0) {
      lines.push('### Detalhes das Reparações')
      lines.push('')

      for (const repair of input.repairResult.repairs) {
        const icon = repair.success ? '✓' : '✗'
        lines.push(`- ${icon} **${repair.target}**: ${repair.description}`)
        if (!repair.success && repair.error) {
          lines.push(`  - Erro: ${repair.error}`)
        }
      }
      lines.push('')
    }

    if (input.repairResult.revalidation) {
      lines.push('### Revalidação Pós-Reparação')
      lines.push('')
      lines.push(`- **Status:** ${input.repairResult.revalidation.status === 'healthy' ? '✓ Íntegro' : '⚠️ Ainda há inconsistências'}`)
      lines.push(`- **Hashes divergentes:** ${input.repairResult.revalidation.hashesMismatched}`)
      lines.push(`- **Elementos órfãos:** ${input.repairResult.revalidation.orphanElements}`)
      lines.push(`- **Relacionamentos inválidos:** ${input.repairResult.revalidation.invalidRelationships}`)
      lines.push('')
    }
  }

  return lines.join('\n')
}