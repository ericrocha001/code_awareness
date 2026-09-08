/*
-T ---
*/

import type { CompressionProfile, OutputFormat, ContextEnrichment } from '../../shared/types'
import { COMPRESSION_TOTAL_FAILURE_MARKER } from './compression-constants'

/**
 * Porta de compressão: contrato mínimo que orquestradores de alto nível precisam
 * para gerar o Markdown de compressão de arquivos selecionados. A implementação
 * concreta (CompressionService) é um detalhe de infraestrutura injetado pelo bootstrap.
 */
export interface CompressionPort {
  generateCompressionMarkdown(
    repoPath: string,
    selectedFiles: string[],
    profile?: CompressionProfile,
    outputFormat?: OutputFormat,
    enrichment?: ContextEnrichment
  ): Promise<string>
}

// Re-export da constante de falha total — fonte única de verdade permanece em compression-constants.ts.
export { COMPRESSION_TOTAL_FAILURE_MARKER }
