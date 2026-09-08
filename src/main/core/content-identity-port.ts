/*
-T ---
*/

/**
 * Provedor de identidade de conteúdo: resolve o hash SHA-256 de um arquivo
 * (por repositório e caminho relativo). A implementação concreta é composta
 * no bootstrap e injetada no CompressionService.
 */
export interface ContentIdentityPort {
  getContentHash(repoPath: string, relativePath: string): Promise<string | null>
}
