// Responsabilidades do Script
//
// 1. Orquestrar a geração do Markdown completo ou seletivo de um repositório via RepomixOutputAdapter.
// 2. Salvar o arquivo gerado dentro da pasta 'code_awareness' no próprio repositório.

import { join, basename } from 'path'
import { promises as fs } from 'fs'
import { RepomixOutputAdapter } from './repomix-output-adapter'
import { CodefetchResult } from '../../shared/types'

// Opções aceitas pelo generateCodeSource para controlar o comportamento da geração
interface CodeSourceOptions {
  selectedFiles?: string[]
  format?: 'markdown' | 'xml'
}

// Resultado estendido com contagem de tokens (opcional — ausente no modo completo)
export interface CodeSourceResult extends CodefetchResult {
  tokenCount?: number
}

export class CodeSourceService {
  private repomix = new RepomixOutputAdapter()

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
