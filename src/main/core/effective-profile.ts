/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Executar a pipeline de resolução semântica que transforma um Stored Profile em Effective Profile canônico.
2. Eliminar configurações sem efeito prático ou sem suporte na CLI do Repomix para o caminho ativo (Compression Core vs Direct Output).
3. Produzir a representação semântica mínima e determinística necessária para a execução e cálculo de hash.

Mapa de Relacionamentos do Script

1. compression-profile.ts
   - Tipo: Dependência Direta
   - Relação: Consome normalizeCompressionProfile e resolveCompressionPath para normalizar a entrada e identificar o caminho arquitetural.
   - Criticidade: Alta

2. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome CompressionProfile e OutputFormat para tipagem de entrada da resolução.
   - Criticidade: Alta

3. repomix-arguments-builder.ts
   - Tipo: Dependência Inversa
   - Relação: Fornece o tipo EffectiveProfile e a representação semântica consumida para geração de flags CLI.
   - Criticidade: Alta

4. compression-service.ts
   - Tipo: Dependência Inversa
   - Relação: Consome resolveEffectiveProfile para obtenção do perfil efetivo na compressão e no cálculo de hash de cache.
   - Criticidade: Alta

Invariantes do Script

1. O módulo é puramente determinístico e sem efeitos colaterais — sem filesystem, processos ou estado global.
2. No caminho compression-core, apenas removeComments, removeEmptyLines e truncateBase64 são preservados.
3. outputFilePathStyle é eliminado em todos os caminhos arquiteturais (flag inexistente no Repomix 1.15.0).
4. A resolução de perfil nunca lança erro para entradas nulas, incompletas ou corrompidas, delegando a higienização a normalizeCompressionProfile.
5. Um OutputFormat desconhecido em runtime é tratado de forma pura — cai para 'plain' sem warning ou efeito colateral, preservando o determinismo.

--- FIM ARQUITETURA DO SCRIPT ---
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
