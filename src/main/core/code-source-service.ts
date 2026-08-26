// Responsabilidades do Script
//
// 1. Orquestrar a geração do Markdown completo ou seletivo de um repositório via RepomixOutputAdapter.
// 2. Salvar o arquivo gerado dentro da pasta 'code_awareness' no próprio repositório (apenas no fluxo antigo, mantido por compatibilidade).
// 3. Orquestrar a geração seletiva com perfil do Code Source (generateWithProfile), normalizando entrada, delegando ao adapter e calculando tokens sobre a saída final — sem escrever artefato.

import { join, basename } from 'path'
import { promises as fs } from 'fs'
import { RepomixOutputAdapter } from './repomix-output-adapter'
import { CodefetchResult } from '../../shared/types'
import type { SourceOutputFormat, SourceProfile } from '../../shared/types'
import {
  normalizeSourceProfile,
  normalizeSourceOutputFormat,
  DEFAULT_SOURCE_PROFILE,
  DEFAULT_SOURCE_OUTPUT_FORMAT
} from '../../shared/utils/source-profile'

// Opções aceitas pelo generateCodeSource para controlar o comportamento da geração
interface CodeSourceOptions {
  selectedFiles?: string[]
  format?: 'markdown' | 'xml'
}

// Resultado estendido com contagem de tokens (opcional — ausente no modo completo)
export interface CodeSourceResult extends CodefetchResult {
  tokenCount?: number
}

/** Entrada opcional da geração seletiva com perfil: dados possivelmente não confiáveis vindos do renderer. */
export interface GenerateWithProfileInput {
  repoPath: string
  selectedFiles: string[]
  format?: unknown
  profile?: unknown
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
   * Fluxo principal de geração seletiva do Code Source.
   * Normaliza defensivamente perfil e formato, valida entrada e delega ao adapter.
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

      const content = await this.repomix.generateSelectiveSource(input.repoPath, input.selectedFiles, format, profile)

      // Tokens calculados sobre a SAÍDA FINAL (o documento que será copiado/exportado).
      const tokenCount = Math.ceil(content.length / 4)

      return { success: true, content, tokenCount }
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || 'Erro desconhecido ao gerar Code Source via Repomix.'
      }
    }
  }

  async generateCodeSource(repoPath: string, options?: CodeSourceOptions): Promise<CodeSourceResult> {
    try {
      let markdown: string
      let tokenCount: number | undefined

      // Modo seletivo: gera apenas os arquivos escolhidos e obtém contagem de tokens
      if (options?.selectedFiles && options.selectedFiles.length > 0) {
        const result = await this.repomix.generateSelectiveMarkdown(
          repoPath,
          options.selectedFiles,
          options.format ?? 'markdown'
        )
        markdown = result.content
        tokenCount = result.tokenCount
      } else {
        // Modo completo: comportamento da Sprint 1 — repositório inteiro, sem contagem
        markdown = await this.repomix.generateFullRepositoryMarkdown(repoPath)
      }

      const repoName = basename(repoPath)
      const codeAwarenessDir = join(repoPath, 'code_awareness')

      // Cria o diretório de destino se ainda não existir
      try {
        await fs.access(codeAwarenessDir)
      } catch {
        await fs.mkdir(codeAwarenessDir, { recursive: true })
      }

      const filePath = join(codeAwarenessDir, `${repoName}.md`)
      await fs.writeFile(filePath, markdown, 'utf-8')

      return {
        success: true,
        markdown,
        ...(tokenCount !== undefined && { tokenCount })
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Erro desconhecido ao gerar Code Source via Repomix.'
      }
    }
  }
}
