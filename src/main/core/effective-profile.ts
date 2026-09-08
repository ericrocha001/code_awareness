/*
-T ---
*/

import type { CompressionProfile, OutputFormat } from '../../shared/types'
import {
  normalizeCompressionProfile,
  resolveCompressionPath
} from './compression-profile'

export interface CompressionCoreEffectiveProfile {
  path: 'compression-core'
  removeComments: boolean
  removeEmptyLines: boolean
  truncateBase64: boolean
}

export interface DirectOutputEffectiveProfile {
  path: 'direct-output'
  includeDirectoryStructure: boolean
  includeEmptyDirectories: boolean
  includeFileSummary: boolean
  includeFullDirectoryStructure: boolean
  parsableStyle: boolean
  removeComments: boolean
  removeEmptyLines: boolean
  showLineNumbers: boolean
  truncateBase64: boolean
}

export type EffectiveProfile = CompressionCoreEffectiveProfile | DirectOutputEffectiveProfile

/** Formatos de transporte válidos conhecidos pela resolução semântica. */
const VALID_OUTPUT_FORMATS: readonly OutputFormat[] = ['plain', 'json', 'markdown', 'xml']

/**
 * Pipeline de resolução semântica:
 * Stored Profile -> Normalização -> Resolução do caminho -> Aplicação da semântica CLI -> Effective Profile.
 */
export function resolveEffectiveProfile(
  profile: CompressionProfile | unknown,
  format: OutputFormat = 'plain'
): EffectiveProfile {
  const normalized = normalizeCompressionProfile(profile)
  // Validação defensiva: um OutputFormat desconhecido em runtime cai para 'plain'
  // de forma pura (sem warning/efeito colateral), preservando o determinismo.
  const safeFormat: OutputFormat =
    (VALID_OUTPUT_FORMATS as readonly string[]).includes(format) ? format : 'plain'
  const path = resolveCompressionPath(safeFormat)

  if (path === 'compression-core') {
    return {
      path: 'compression-core',
      removeComments: normalized.removeComments,
      removeEmptyLines: normalized.removeEmptyLines,
      truncateBase64: normalized.truncateBase64
    }
  }

  return {
    path: 'direct-output',
    includeDirectoryStructure: normalized.includeDirectoryStructure,
    includeEmptyDirectories: normalized.includeEmptyDirectories,
    includeFileSummary: normalized.includeFileSummary,
    includeFullDirectoryStructure: normalized.includeFullDirectoryStructure,
    parsableStyle: normalized.parsableStyle,
    removeComments: normalized.removeComments,
    removeEmptyLines: normalized.removeEmptyLines,
    showLineNumbers: normalized.showLineNumbers,
    truncateBase64: normalized.truncateBase64
  }
}
