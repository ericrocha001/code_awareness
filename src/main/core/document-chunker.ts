/*
-T ---
*/

export class DocumentChunker {
  private readonly MAX_CHARS_PER_CHUNK = 2_500_000

  // Limite absoluto de segurança: força quebra mesmo dentro de bloco de código
  // para evitar OOM em repositórios com arquivos de dados/logs gigantescos.
  // WARNING: Quebrar dentro de um bloco de código corrompe a semântica do markdown,
  // mas é preferível a um crash do processo principal do Electron.
  private readonly HARD_LIMIT = 3_000_000

  /**
   * Divide um documento markdown em chunks respeitando o limite de 2.5M caracteres.
   * Preserva o markdown original intacto (incluindo fences ```).
   * Não quebra no meio de blocos de código, exceto quando excede o hard limit de segurança.
   *
   * Casos de borda:
   * - Documento vazio: retorna [].
   * - Documento dentro do limite: retorna [markdown] (sem processamento).
   * - Documento dentro de bloco de código no limite: continua até o fechamento.
   */
  chunkMarkdown(markdown: string): string[] {
    if (typeof markdown !== 'string') {
      throw new TypeError('markdown must be a string')
    }
    if (markdown.length === 0) return []
    if (markdown.length <= this.MAX_CHARS_PER_CHUNK) {
      return [markdown]
    }
    return this.splitIntoChunks(markdown)
  }

  /**
   * Divide o markdown em chunks linha a linha, respeitando blocos de código.
   * Sem marcadores de continuação — cada chunk é markdown puro e independente.
   */
  private splitIntoChunks(markdown: string): string[] {
    const lines = markdown.split('\n')
    const chunks: string[] = []
    let currentChunk: string[] = []
    let currentChars = 0
    let inCodeBlock = false

    for (const line of lines) {
      const trimmedLine = line.trimStart()

      // Detecta abertura/fechamento de bloco de código
      if (trimmedLine.startsWith('```')) {
        inCodeBlock = !inCodeBlock
      }

      const lineChars = line.length + 1 // +1 para o \n

      // Verifica se precisa quebrar
      const exceedsLimit = currentChars + lineChars > this.MAX_CHARS_PER_CHUNK
      const exceedsHardLimit = currentChars + lineChars > this.HARD_LIMIT

      if (exceedsLimit && (!inCodeBlock || exceedsHardLimit)) {
        // Finaliza chunk atual
        if (currentChunk.length > 0) {
          chunks.push(currentChunk.join('\n'))
        }
        currentChunk = [line]
        currentChars = lineChars
      } else {
        currentChunk.push(line)
        currentChars += lineChars
      }
    }

    // Adiciona o último chunk
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'))
    }

    return chunks
  }
}