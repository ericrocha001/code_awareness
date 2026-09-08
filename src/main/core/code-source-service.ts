/*
-T ---
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
