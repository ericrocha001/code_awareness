/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Ler o conteúdo de um arquivo fonte a partir do caminho absoluto.
2. Escrever o conteúdo em múltiplos repositórios de destino, sobrescrevendo se já existir.
3. Retornar relatório de sucesso/falha por repositório.

Mapa de Relacionamentos do Script

1. file-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Consumido pelo handler IPC de propagação.
   - Criticidade: Alta

Invariantes do Script

1. O nome do arquivo no destino é sempre o mesmo do arquivo fonte (basename).
2. Cada repositório é processado independentemente — falha em um não aborta os outros.
3. O conteúdo do arquivo fonte nunca é validado ou transformado — apenas copiado.

--- FIM ARQUITETURA DO SCRIPT ---
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
