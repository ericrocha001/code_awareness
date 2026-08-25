/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir o contrato estável de compressão (CompressionPort) consumido pelos orquestradores de alto nível (CodeMapService).
2. Re-exportar a constante COMPRESSION_TOTAL_FAILURE_MARKER a partir de compression-constants.ts, fonte única de verdade.

Mapa de Relacionamentos do Script

1. compression-constants.ts
   - Tipo: Dependência Direta
   - Relação: Re-exporta COMPRESSION_TOTAL_FAILURE_MARKER para consumidores da porta.
   - Criticidade: Alta

2. code-map-service.ts
   - Tipo: Dependência Inversa
   - Relação: Consome CompressionPort como única dependência de compressão; a implementação concreta (CompressionService) é injetada pelo bootstrap.
   - Criticidade: Alta

3. compression-service.ts
   - Tipo: Contrato / Interface
   - Relação: Implementa CompressionPort formalizando o contrato em tempo de compilação.
   - Criticidade: Alta

Invariantes do Script

1. A porta é uma interface pura — não importa nem referencia CompressionService.
2. A assinatura de generateCompressionMarkdown espelha exatamente o que os orquestradores consomem, sem métodos adicionais.
3. COMPRESSION_TOTAL_FAILURE_MARKER é re-exportada, nunca redeclarada — compression-constants.ts permanece a fonte única de verdade.

--- FIM ARQUITETURA DO SCRIPT ---
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
