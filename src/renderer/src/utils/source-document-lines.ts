/*
-T ---
*/

/**
 * Normaliza quebras de linha para LF (\n) e divide o conteúdo em um array de linhas.
 * Retorna array vazio para entradas nulas, indefinidas ou vazias.
 */
export function splitDocumentLines(content: string | undefined | null): string[] {
  if (!content) {
    return []
  }
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return normalized.split('\n')
}
