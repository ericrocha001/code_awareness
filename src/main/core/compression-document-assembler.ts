/*
-T ---
*/

import { basename } from 'path'
import { COMPRESSION_TOTAL_FAILURE_MARKER } from './compression-constants'
import type { EnrichmentSections } from './context-enrichment-service'

export interface AssemblyInput {
  repoPath: string
  selectedFiles: string[]                // Ordem original a ser preservada
  results: Record<string, string>        // relativePath → compressedContent
  errors: string[]                       // relativePaths que falharam
  errorReasons: Record<string, string>   // relativePath → motivo
  enrichmentSections: EnrichmentSections // Seções formatadas de Context Enrichment
}

/**
 * Transforma os resultados de compressão por arquivo e seções de enriquecimento no documento Markdown final.
 */
export function assembleCompressionDocument(input: AssemblyInput): string {
  const { repoPath, selectedFiles, results, errors, errorReasons, enrichmentSections } = input
  const repoName = basename(repoPath) || 'Repository'
  const dateStr = new Date().toLocaleString('pt-BR')

  let markdown = ''
  let markdownStarted = false
  const errorsInOrder: string[] = []

  for (const relativePath of selectedFiles) {
    const compressedContent = results[relativePath]

    if (compressedContent && compressedContent.trim().length > 0) {
      if (!markdownStarted) {
        markdown += `# Code Compression — [${repoName}] (${dateStr})\n\n`
        markdown += `> Este documento contém o esqueleto estrutural (Code Compression) dos arquivos solicitados.\n\n`
        // Context Enrichment: header e instruções logo após o cabeçalho do documento
        if (enrichmentSections.header) markdown += `${enrichmentSections.header}\n`
        if (enrichmentSections.instruction) markdown += `${enrichmentSections.instruction}\n`
        markdownStarted = true
      }
      markdown += `---\n\n## 📄 \`${relativePath}\`\n\n\`\`\`plain\n${compressedContent}\n\`\`\`\n\n`
    } else {
      errorsInOrder.push(relativePath)
    }
  }

  // Context Enrichment pós-código: diffs e logs (antes da seção de falhas)
  if (enrichmentSections.diffs) markdown += `\n${enrichmentSections.diffs}\n`
  if (enrichmentSections.logs) markdown += `\n${enrichmentSections.logs}\n`

  const allErrors = [...new Set([...errors, ...errorsInOrder])]

  if (!markdownStarted && allErrors.length > 0) {
    return `${COMPRESSION_TOTAL_FAILURE_MARKER}\n\nNenhum dos ${allErrors.length} arquivo(s) selecionado(s) pôde ser comprimido.`
  }

  if (allErrors.length > 0) {
    markdown += `## ⚠️ Falhas na Compressão\n\nOs seguintes arquivos não puderam ser comprimidos:\n\n`
    for (const errPath of allErrors) {
      const reason = errorReasons[errPath]
      markdown += reason
        ? `- \`${errPath}\` — ${reason}\n`
        : `- \`${errPath}\`\n`
    }
    markdown += '\n'
  }

  return markdown
}
