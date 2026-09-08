/*
-T ---
*/

import type { SourceOutputFormat, SourceProfile } from '../types'

/** Perfil padrão do Code Source: preserva ao máximo o comportamento atual. */
export const DEFAULT_SOURCE_PROFILE: SourceProfile = {
  // Limpeza
  removeComments: false,
  removeEmptyLines: false,
  truncateBase64: false,
  // Apresentação
  showLineNumbers: false,
  parsableStyle: false,
  // Estrutura
  includeFileSummary: false,
  includeDirectoryStructure: true,
  includeEmptyDirectories: false,
  includeFullDirectoryStructure: false,
  // Metadata
  version: 1
}

/** Formato padrão do Code Source. */
export const DEFAULT_SOURCE_OUTPUT_FORMAT: SourceOutputFormat = 'markdown'

/**
 * Normaliza defensivamente um perfil do Code Source de origem desconhecida.
 * Campos booleanos inválidos assumem o default; versão só é preservada se for
 * número finito positivo; campos desconhecidos são ignorados. Nunca lança erro.
 */
export function normalizeSourceProfile(input: unknown): SourceProfile {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>

  const bool = (key: keyof SourceProfile, fallback: boolean): boolean =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : fallback

  const version = raw.version
  const validVersion =
    typeof version === 'number' && Number.isFinite(version) && version > 0 ? version : DEFAULT_SOURCE_PROFILE.version

  return {
    removeComments: bool('removeComments', DEFAULT_SOURCE_PROFILE.removeComments),
    removeEmptyLines: bool('removeEmptyLines', DEFAULT_SOURCE_PROFILE.removeEmptyLines),
    truncateBase64: bool('truncateBase64', DEFAULT_SOURCE_PROFILE.truncateBase64),
    showLineNumbers: bool('showLineNumbers', DEFAULT_SOURCE_PROFILE.showLineNumbers),
    parsableStyle: bool('parsableStyle', DEFAULT_SOURCE_PROFILE.parsableStyle),
    includeFileSummary: bool('includeFileSummary', DEFAULT_SOURCE_PROFILE.includeFileSummary),
    includeDirectoryStructure: bool('includeDirectoryStructure', DEFAULT_SOURCE_PROFILE.includeDirectoryStructure),
    includeEmptyDirectories: bool('includeEmptyDirectories', DEFAULT_SOURCE_PROFILE.includeEmptyDirectories),
    includeFullDirectoryStructure: bool(
      'includeFullDirectoryStructure',
      DEFAULT_SOURCE_PROFILE.includeFullDirectoryStructure
    ),
    version: validVersion
  }
}

/**
 * Normaliza defensivamente o formato do Code Source.
 * Aceita apenas 'markdown' e 'xml'; qualquer outro valor resulta em 'markdown'.
 */
export function normalizeSourceOutputFormat(input: unknown): SourceOutputFormat {
  return input === 'xml' ? 'xml' : 'markdown'
}
