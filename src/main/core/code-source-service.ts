/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Orquestrar a geração seletiva com perfil do Code Source (generateWithProfile), normalizando entrada, delegando ao adapter com suporte opcional a AbortSignal, calculando tokens sobre a saída final e preservando erros tipados de cancelamento.

Mapa de Relacionamentos do Script

1. repomix-output-adapter.ts
   - Tipo: Dependência Direta
   - Relação: Delega a execução da CLI do Repomix.
   - Criticidade: Alta

2. generation-errors.ts
   - Tipo: Dependência Direta
   - Relação: Importa isGenerationCancelledError para preservar erros de cancelamento sem mascarar como falha genérica.
   - Criticidade: Alta

3. shared/utils/source-profile.ts
   - Tipo: Dependência Direta
   - Relação: Normaliza defensivamente SourceProfile e SourceOutputFormat.
   - Criticidade: Alta

4. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece SourceProfile e SourceOutputFormat.
   - Criticidade: Alta

Invariantes do Script

1. generateWithProfile nunca escreve artefato no disco.
2. Erros de cancelamento (GenerationCancelledError) são preservados e relançados, permitindo que coordenadores distingam cancelamento de falha real.
3. Falhas reais de execução retornam resultado estruturado com { success: false, error }.
4. A contagem de tokens é calculada sobre a saída final gerada.
5. O parâmetro signal é estritamente opcional em GenerateWithProfileInput.
6. O serviço possui generateWithProfile como único método público de geração.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { RepomixOutputAdapter } from './repomix-output-adapter'
import { isGenerationCancelledError } from './generation-errors'
import type { SourceOutputFormat, SourceProfile } from '../../shared/types'
import {
  normalizeSourceProfile,
  normalizeSourceOutputFormat,
  DEFAULT_SOURCE_PROFILE,
  DEFAULT_SOURCE_OUTPUT_FORMAT
} from '../../shared/utils/source-profile'

/** Entrada da geração seletiva com perfil: dados possivelmente não confiáveis vindos do renderer. */
export interface GenerateWithProfileInput {
  repoPath: string
  selectedFiles: string[]
  format?: unknown
  profile?: unknown
  signal?: AbortSignal
}

/** Resultado estruturado da geração seletiva com perfil. */
export interface GenerateWithProfileResult {
  success: boolean
  content?: string
  tokenCount?: number
  error?: string
}

export class CodeSourceService {
  private repomix: RepomixOutputAdapter

  // Injeção opcional do adapter para testabilidade; produção usa a instância real.
  constructor(repomix?: RepomixOutputAdapter) {
    this.repomix = repomix ?? new RepomixOutputAdapter()
  }

  /**
   * Fluxo principal e único de geração seletiva do Code Source.
   * Normaliza defensivamente perfil e formato, valida entrada e delega ao adapter.
   * Suporta cancelamento via AbortSignal.
   * NÃO escreve artefato no repositório — o conteúdo é retornado para cópia/exportação.
   */
  async generateWithProfile(input: GenerateWithProfileInput): Promise<GenerateWithProfileResult> {
    try {
      // Validação de entrada (camada de defesa antes do adapter).
      if (!input || typeof input.repoPath !== 'string' || input.repoPath.trim() === '') {
        return { success: false, error: 'repoPath é obrigatório e deve ser uma string não vazia.' }
      }
      if (!Array.isArray(input.selectedFiles)) {
        return { success: false, error: 'selectedFiles deve ser um array de caminhos.' }
      }
      if (input.selectedFiles.length === 0) {
        return { success: false, error: 'Nenhum arquivo selecionado para geração seletiva.' }
      }

      // Normalização defensiva: configuração antiga/corrompida nunca quebra o fluxo.
      const profile: SourceProfile = normalizeSourceProfile(input.profile ?? DEFAULT_SOURCE_PROFILE)
      const format: SourceOutputFormat = normalizeSourceOutputFormat(
        input.format ?? DEFAULT_SOURCE_OUTPUT_FORMAT
      )

      const content = input.signal
        ? await this.repomix.generateSelectiveSource(
            input.repoPath,
            input.selectedFiles,
            format,
            profile,
            input.signal
          )
        : await this.repomix.generateSelectiveSource(
            input.repoPath,
            input.selectedFiles,
            format,
            profile
          )

      // Tokens calculados sobre a SAÍDA FINAL (o documento que será copiado/exportado).
      const tokenCount = Math.ceil(content.length / 4)

      return { success: true, content, tokenCount }
    } catch (error: any) {
      if (isGenerationCancelledError(error)) {
        throw error
      }
      return {
        success: false,
        error: error?.message || 'Erro desconhecido ao gerar Code Source via Repomix.'
      }
    }
  }
}
