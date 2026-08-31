/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Definir a interface FileListingPort como contrato mínimo e segregado para listagem de caminhos relativos de arquivos de um repositório.

Mapa de Relacionamentos do Script

1. src/main/core/git-service.ts
   - Tipo: Dependência Inversa
   - Relação: GitService implementa esta porta para fornecer listagem desacoplada de arquivos.
   - Criticidade: Alta

Invariantes do Script

1. O script contém exclusivamente declarações de interface sem lógica executável ou dependências de infraestrutura.
2. A interface restringe-se estritamente ao contrato mínimo necessário contendo o campo relativePath.

--- FIM ARQUITETURA DO SCRIPT ---
*/

export interface FileListingPort {
  listAllFiles(repoPath: string): Promise<Array<{ relativePath: string }>>
}
