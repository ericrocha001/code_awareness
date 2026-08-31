/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Dividir o conteúdo de documentos em linhas de forma determinística e estável entre plataformas.
2. Normalizar quebras de linha (convertendo CRLF e CR em LF) antes da divisão.
3. Tratar documentos nulos, indefinidos ou vazios retornando uma lista vazia de linhas de forma segura.
4. Preservar linhas vazias intermediárias e finais do documento original.

Mapa de Relacionamentos do Script

1. SourcePreviewVirtualized.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome splitDocumentLines para calcular o número de linhas e renderizar o preview virtualizado.
   - Criticidade: Alta

Invariantes do Script

1. A função splitDocumentLines é pura, síncrona e livre de efeitos colaterais.
2. Entradas nulas, indefinidas ou vazias retornam array vazio ([]).
3. Todas as quebras CRLF (\r\n) e CR (\r) são convertidas para LF (\n) antes da divisão.
4. Linhas vazias intermediárias são estritamente preservadas.

--- FIM ARQUITETURA DO SCRIPT ---
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
