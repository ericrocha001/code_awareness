/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Montar o documento Markdown final consolidando os arquivos comprimidos na ordem estrita de selectedFiles.
2. Inserir as seções de Context Enrichment (header, instruções, diffs e logs) nos pontos especificados do documento.
3. Formatar a seção de avisos para falhas parciais de compressão com os motivos informados.
4. Retornar o marcador de falha total quando nenhum dos arquivos solicitados puder ser comprimido.

Mapa de Relacionamentos do Script

1. compression-constants.ts
   - Tipo: Dependência Direta
   - Relação: Consome COMPRESSION_TOTAL_FAILURE_MARKER.
   - Criticidade: Alta

2. context-enrichment-service.ts
   - Tipo: Contrato / Interface
   - Relação: Consome o tipo EnrichmentSections para inserção das seções adicionais.
   - Criticidade: Alta

Invariantes do Script

1. A ordem dos blocos de arquivo no Markdown final segue rigorosamente a ordem do array selectedFiles original.
2. Context Enrichment é aplicado apenas na montagem final, sem introduzir efeitos colaterais.
3. Se todos os arquivos falharem ou results estiver vazio para todos os itens, retorna COMPRESSION_TOTAL_FAILURE_MARKER.

--- FIM ARQUITETURA DO SCRIPT ---
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
