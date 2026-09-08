/*
-T ---
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
