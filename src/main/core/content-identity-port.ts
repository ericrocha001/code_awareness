/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir o contrato estável de identidade de conteúdo (ContentIdentityPort): resolução do hash SHA-256 de um arquivo por repositório.

Mapa de Relacionamentos do Script

1. compression-service.ts
   - Tipo: Contrato / Interface
   - Relação: CompressionService passa a depender desta porta (via construtor) em vez de um function type inline.
   - Criticidade: Alta

2. code-map-service.ts
   - Tipo: Dependência Inversa
   - Relação: CodeMapService expõe getFileContentHash para que o bootstrap componha a implementação concreta desta porta.
   - Criticidade: Alta

3. main.ts
   - Tipo: Dependência Direta
   - Relação: Compõe a implementação concreta da porta no bootstrap, consultando o CodeMapService para reuso de hashes.
   - Criticidade: Alta

Invariantes do Script

1. A porta é uma interface pura — não importa RepositoryModel, CompressionService nem o mapa global `instances`.
2. getContentHash nunca lança: retorna null quando o hash não pode ser resolvido, permitindo fallback do consumidor.
3. A assinatura espelha exatamente o que o CompressionService consome, sem acoplar detalhes de implementação do hash.

--- FIM ARQUITETURA DO SCRIPT ---
*/

/**
 * Provedor de identidade de conteúdo: resolve o hash SHA-256 de um arquivo
 * (por repositório e caminho relativo). A implementação concreta é composta
 * no bootstrap e injetada no CompressionService.
 */
export interface ContentIdentityPort {
  getContentHash(repoPath: string, relativePath: string): Promise<string | null>
}
