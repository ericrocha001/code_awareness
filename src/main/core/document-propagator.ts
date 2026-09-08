/*
-T ---
*/

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, basename } from 'path'

export interface PropagationResult {
  success: number
  failed: number
  errors: string[]
}

export class DocumentPropagator {
  /**
   * Propaga um arquivo fonte para múltiplos repositórios de destino.
   * 
   * @param sourceFilePath - Caminho absoluto do arquivo fonte
   * @param destinationRepoPaths - Array de caminhos absolutos dos repositórios de destino
   * @returns Relatório com contagem de sucessos, falhas e mensagens de erro
   */
  propagate(
    sourceFilePath: string,
    destinationRepoPaths: string[]
  ): PropagationResult {
    // 1. Lê o conteúdo do arquivo fonte uma única vez
    let content: string
    try {
      content = readFileSync(sourceFilePath, 'utf-8')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return {
        success: 0,
        failed: destinationRepoPaths.length,
        errors: [`Falha ao ler arquivo fonte: ${message}`]
      }
    }

    // 2. Extrai o nome do arquivo (será o mesmo em todos os destinos)
    const fileName = basename(sourceFilePath)

    let success = 0
    let failed = 0
    const errors: string[] = []

    // 3. Escreve em cada repositório de destino
    for (const repoPath of destinationRepoPaths) {
      try {
        // Valida se o repositório existe
        if (!existsSync(repoPath)) {
          failed++
          errors.push(`${repoPath}: repositório não encontrado`)
          continue
        }

        const destPath = join(repoPath, fileName)
        
        // Sobrescreve se já existir, cria se não existir
        writeFileSync(destPath, content, 'utf-8')
        success++
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        failed++
        errors.push(`${repoPath}: ${message}`)
      }
    }

    return { success, failed, errors }
  }
}
