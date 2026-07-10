/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Dividir documentos markdown grandes em chunks respeitando o limite de 2.5M caracteres por chunk.
2. Preservar o markdown original intacto (incluindo fences de código) durante o chunking.
3. Garantir que o chunking nunca quebre no meio de blocos de código, exceto quando o limite absoluto de segurança (3M) for excedido.

Mapa de Relacionamentos do Script

1. src/main/ipc/file-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Consumido pelo handler IPC de exportação para NotebookLM.
   - Criticidade: Alta

Invariantes do Script

1. O markdown original deve ser preservado intacto — nenhuma transformação de conteúdo é aplicada.
2. Nunca quebrar no meio de um bloco de código, exceto quando currentChars exceder o HARD_LIMIT (3M).
3. Cada chunk deve ter tamanho próximo ao máximo para aproveitar eficientemente o limite de 500k palavras do NotebookLM.
4. Para documentos menores que o limite, retornar array com um único elemento (sem processamento desnecessário).

--- FIM ARQUITETURA DO SCRIPT ---
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