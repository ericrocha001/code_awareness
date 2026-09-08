/*
-T ---
*/

import { createHash } from 'crypto'
import type {
  CompressionProfile,
  CompressionSettings,
  OutputFormat
} from '../../shared/types'
import type { EffectiveProfile } from './effective-profile'

/** Versão atual do schema do perfil — incrementa para migrações futuras. */
export const COMPRESSION_PROFILE_SCHEMA_VERSION = 1

/** Caminho arquitetural para um formato de transporte. */
export type CompressionPath = 'compression-core' | 'direct-output'

/**
 * Perfil padrão — base de compatibilidade retroativa para a resolução semântica.
 * No caminho compression-core o builder emite argumentos enxutos
 * (--compress --style plain --stdout). --output-show-line-numbers é no-op sob
 * --compress (sempre presente) e não é mais emitido pelo builder.
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

/** Formato de transporte padrão (compatibilidade retroativa com o código atual). */
export const DEFAULT_OUTPUT_FORMAT: OutputFormat = 'plain'

/** Unidade semântica padrão persistida. */
export const DEFAULT_COMPRESSION_SETTINGS: CompressionSettings = {
  profile: DEFAULT_PROFILE,
  outputFormat: DEFAULT_OUTPUT_FORMAT
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
 * Normaliza um perfil potencialmente incompleto/corrompido em um perfil canônico.
 * Nunca lança — campos ausentes/errados são preenchidos com defaults; campos
 * desconhecidos são descartados. Version desconhecida aplica o schema atual.
 */
export function normalizeCompressionProfile(input: unknown): CompressionProfile {
  const src = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>

  // Se a versão é conhecida e diferente da atual, migra para o schema atual.
  // Por ora a única migração é resetar para o default (schema atual = v1).
  const rawVersion = src.version
  const version = typeof rawVersion === 'number' && rawVersion > 0 ? Math.floor(rawVersion) : COMPRESSION_PROFILE_SCHEMA_VERSION

  const profile: CompressionProfile = {
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

  return profile
}

/**
 * Determina o caminho arquitetural para um formato de transporte.
 * Novo contrato (Sprint 6.1):
 * - plain → Compression Core (documento-esqueleto legado, consumido pelo CodeMap).
 * - markdown/xml/json → Direct Output (documento nativo do Repomix no formato escolhido).
 */
export function resolveCompressionPath(format: OutputFormat): CompressionPath {
  return format === 'plain' ? 'compression-core' : 'direct-output'
}

/**
 * Serializa o Effective Profile em JSON com chaves em ordem alfabética fixa e calcula SHA-256.
 * O hash identifica exclusivamente as transformações semânticas ativas no caminho de execução.
 */
export function computeProfileHash(profile: EffectiveProfile): string {
  const sortedKeys = Object.keys(profile).sort() as Array<keyof EffectiveProfile>
  const canonical: Record<string, unknown> = {}
  for (const key of sortedKeys) {
    canonical[key] = (profile as Record<string, unknown>)[key]
  }

  return createHash('sha256').update(JSON.stringify(canonical), 'utf-8').digest('hex')
}
