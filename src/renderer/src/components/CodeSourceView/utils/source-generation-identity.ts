/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Computar um identificador determinístico (hash/string) dos parâmetros de geração do Code Source para deduplicação e controle de ciclo de vida.
2. Normalizar a lista de arquivos selecionados e as propriedades do perfil para garantir estabilidade semântica independentemente de ordem ou referências de objetos.

Mapa de Relacionamentos do Script

1. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Fornece SourceOutputFormat e SourceProfile.
   - Criticidade: Alta

2. hooks/useSourceGeneration.ts
   - Tipo: Dependência Inversa
   - Relação: Consome computeSourceGenerationIdentity para deduplicar requisições em voo e reutilizar o último resultado válido.
   - Criticidade: Alta

Invariantes do Script

1. A função computeSourceGenerationIdentity é pura, determinística e livre de efeitos colaterais.
2. Duas entradas com os mesmos arquivos em ordens diferentes geram a mesma identidade.
3. Mudanças de formato, perfil, arquivos ou repoPath alteram a identidade de forma determinística.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import type { SourceOutputFormat, SourceProfile } from '../../../../../shared/types'

/**
 * Computa um identificador determinístico único para os parâmetros de geração.
 * Normaliza os arquivos selecionados ordenando-os e extrai os campos canônicos do perfil.
 */
export function computeSourceGenerationIdentity(
  repoPath: string,
  selectedFiles: string[],
  format: SourceOutputFormat,
  profile: SourceProfile
): string {
  const sortedFiles = [...selectedFiles].sort().join('\n')
  const canonicalProfile = {
    removeComments: Boolean(profile.removeComments),
    removeEmptyLines: Boolean(profile.removeEmptyLines),
    truncateBase64: Boolean(profile.truncateBase64),
    showLineNumbers: Boolean(profile.showLineNumbers),
    parsableStyle: Boolean(profile.parsableStyle),
    includeFileSummary: Boolean(profile.includeFileSummary),
    includeDirectoryStructure: Boolean(profile.includeDirectoryStructure),
    includeEmptyDirectories: Boolean(profile.includeEmptyDirectories),
    includeFullDirectoryStructure: Boolean(profile.includeFullDirectoryStructure),
    version: typeof profile.version === 'number' ? profile.version : 1
  }

  return `${repoPath}:::${sortedFiles}:::${format}:::${JSON.stringify(canonicalProfile)}`
}
