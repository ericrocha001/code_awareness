/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Fornecer ao renderer o perfil padrão de compressão (DEFAULT_PROFILE) e a normalização
   defensiva de perfis (normalizeCompressionProfile) para a UI de configuração.
2. Espelhar a semântica do módulo de domínio do processo main (compression-profile.ts)
   sem depender de módulos Node, preservando a fronteira renderer ↔ main (IPC).

Mapa de Relacionamentos do Script

1. OutputModal.tsx
   - Tipo: Dependência Inversa
   - Relação: Consome DEFAULT_PROFILE e normalizeCompressionProfile para popular os defaults
     e sanear perfis persistidos vindos de settings.
   - Criticidade: Alta

2. main/core/compression-profile.ts
   - Tipo: Contrato / Interface
   - Relação: Este módulo espelha as constantes e regras de normalização daquele módulo; qualquer
     divergência de comportamento pode produzir perfis de UI distintos do backend.
   - Criticidade: Alta

Invariantes do Script

1. O módulo é de domínio puro — sem acesso a filesystem, Node ou IPC.
2. normalizeCompressionProfile nunca lança; sempre produz um CompressionProfile válido.
3. Os valores de DEFAULT_PROFILE devem refletir exatamente os do processo main (compression-profile.ts).
4. O renderer só conversa com o processo main via IPC — nunca importa módulos de src/main.

--- FIM ARQUITETURA DO SCRIPT ---
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
