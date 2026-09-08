/*
-T ---
*/

import type { CompressionProfile } from '../../../shared/types'

/** Versão atual do schema do perfil — espelha COMPRESSION_PROFILE_SCHEMA_VERSION do main. */
const COMPRESSION_PROFILE_SCHEMA_VERSION = 1

/**
 * Perfil padrão de compressão — espelha DEFAULT_PROFILE do processo main (compression-profile.ts).
 * Base de compatibilidade retroativa para a resolução semântica da UI.
 *
 * FONTE AUTORITATIVA: src/main/core/compression-profile.ts (DEFAULT_PROFILE tem removeComments: false).
 * Nota: docs/COMPRESSION_CAPABILITY_MATRIX.md documenta apenas a EXISTENCIA da flag CLI
 * `--remove-comments`, não a sua ativación por padrão. O test do main (PA-P12) exige que
 * DEFAULT_PROFILE + plain NÃO incluya `--remove-comments` (compatibilidade retroativa legada).
 */
export const DEFAULT_PROFILE: CompressionProfile = {
  removeComments: false,
  removeEmptyLines: false,
  truncateBase64: false,
  showLineNumbers: true,
  parsableStyle: false,
  outputFilePathStyle: 'target-relative',
  includeFileSummary: false,
  includeDirectoryStructure: false,
  includeEmptyDirectories: false,
  includeFullDirectoryStructure: false,
  version: COMPRESSION_PROFILE_SCHEMA_VERSION
}

/** Valida/coage um valor desconhecido a boolean, aplicando o default quando inválido. */
function asBoolean(value: unknown, defaultValue: boolean): boolean {
  return typeof value === 'boolean' ? value : defaultValue
}

/** Valida/coage o enum de estilo de caminho, aplicando o default quando inválido. */
function asFilePathStyle(value: unknown): CompressionProfile['outputFilePathStyle'] {
  return value === 'cwd-relative' ? 'cwd-relative' : 'target-relative'
}

/**
 * Normaliza um perfil potencialmente incompleto/corrompido em um perfil canônico para a UI.
 * Nunca lança — campos ausentes/errados são preenchidos com defaults.
 */
export function normalizeCompressionProfile(input: unknown): CompressionProfile {
  const src = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const rawVersion = src.version
  const version = typeof rawVersion === 'number' && rawVersion > 0 ? Math.floor(rawVersion) : COMPRESSION_PROFILE_SCHEMA_VERSION

  return {
    removeComments: asBoolean(src.removeComments, DEFAULT_PROFILE.removeComments),
    removeEmptyLines: asBoolean(src.removeEmptyLines, DEFAULT_PROFILE.removeEmptyLines),
    truncateBase64: asBoolean(src.truncateBase64, DEFAULT_PROFILE.truncateBase64),
    showLineNumbers: asBoolean(src.showLineNumbers, DEFAULT_PROFILE.showLineNumbers),
    parsableStyle: asBoolean(src.parsableStyle, DEFAULT_PROFILE.parsableStyle),
    outputFilePathStyle: asFilePathStyle(src.outputFilePathStyle),
    includeFileSummary: asBoolean(src.includeFileSummary, DEFAULT_PROFILE.includeFileSummary),
    includeDirectoryStructure: asBoolean(src.includeDirectoryStructure, DEFAULT_PROFILE.includeDirectoryStructure),
    includeEmptyDirectories: asBoolean(src.includeEmptyDirectories, DEFAULT_PROFILE.includeEmptyDirectories),
    includeFullDirectoryStructure: asBoolean(src.includeFullDirectoryStructure, DEFAULT_PROFILE.includeFullDirectoryStructure),
    version
  }
}
