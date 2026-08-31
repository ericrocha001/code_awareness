/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir a interface StructuredCompressionPort como contrato abstrato para obtenção de resultados estruturados de compressão por arquivo.
2. Definir o tipo StructuredCompressionResult encapsulando o mapeamento de conteúdos comprimidos, falhas e razões de erro.

Mapa de Relacionamentos do Script

1. src/shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome CompressionProfile e OutputFormat para tipagem dos parâmetros do método.
   - Criticidade: Alta

2. src/main/core/compression-service.ts
   - Tipo: Dependência Inversa
   - Relação: CompressionService implementa esta porta para expor o pipeline interno antes da montagem de Markdown.
   - Criticidade: Alta

Invariantes do Script

1. O script contém exclusivamente declarações de tipos e interfaces TypeScript, sem código executável ou efeitos colaterais.
2. results mapeia o caminho relativo de cada arquivo com sucesso ao seu conteúdo comprimido individual.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type { CompressionProfile, OutputFormat } from '../../shared/types'

export interface StructuredCompressionResult {
  results: Record<string, string>
  errors: string[]
  errorReasons: Record<string, string>
}

export interface StructuredCompressionPort {
  compressFilesStructured(
    repoPath: string,
    selectedFiles: string[],
    profile?: CompressionProfile,
    outputFormat?: OutputFormat
  ): Promise<StructuredCompressionResult>
}
