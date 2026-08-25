/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir e centralizar as constantes de esquema do sistema de compressão: COMPRESSION_VERSION e COMPRESSION_TOTAL_FAILURE_MARKER.
2. Eliminar dependências circulares entre o orquestrador e seus delegados, fornecendo um módulo neutro e sem dependências de implementação.

Mapa de Relacionamentos do Script

1. compression-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome COMPRESSION_VERSION (chave de cache) e COMPRESSION_TOTAL_FAILURE_MARKER (validação de entrada vazia).
   - Criticidade: Alta

2. compression-executor.ts
   - Tipo: Dependência Direta
   - Relação: Consome COMPRESSION_VERSION para composição da chave inFlight.
   - Criticidade: Alta

3. compression-document-assembler.ts
   - Tipo: Dependência Direta
   - Relação: Consome COMPRESSION_TOTAL_FAILURE_MARKER para o documento de falha total.
   - Criticidade: Alta

4. code-map-service.ts
   - Tipo: Dependência Direta
   - Relação: Consome COMPRESSION_TOTAL_FAILURE_MARKER para detectar falha total no resultado comprimido.
   - Criticidade: Alta

Invariantes do Script

1. O módulo é neutro — não importa nenhum módulo de implementação (zero dependências de runtime).
2. As constantes são a fonte única de verdade (single source of truth) para a versão de esquema e o marcador de falha total.
3. Nenhum módulo de produção deve importar essas constantes a partir de compression-service.ts — sempre a partir deste módulo.
*/

/** Versão do esquema de compressão: qualquer alteração na estratégia invalida o cache automaticamente. */
export const COMPRESSION_VERSION = '2'

/**
 * Marcador exato retornado quando todos os arquivos selecionados falham na compressão.
 * Fonte única de verdade — consumidores devem importar esta constante em vez de hardcodar o texto.
 */
export const COMPRESSION_TOTAL_FAILURE_MARKER = '# ❌ Falha na Compressão'