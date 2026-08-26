/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Fornecer o perfil padrão do Code Source com defaults seguros.
2. Fornecer o formato padrão do Code Source.
3. Normalizar defensivamente perfis do Code Source recebidos de fontes não confiáveis.
4. Normalizar defensivamente o formato de saída do Code Source.

Mapa de Relacionamentos do Script

1. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome SourceProfile e SourceOutputFormat como contratos normalizados.
   - Criticidade: Alta

Invariantes do Script

1. O módulo é puro — sem filesystem, IPC, processos ou dependências do main/renderer.
2. A normalização nunca lança erro: entrada inválida, incompleta ou desconhecida produz sempre um perfil válido.
3. Campos desconhecidos são descartados; cada campo booleano inválido assume o default do perfil padrão.
4. O formato normalizado é sempre 'markdown' ou 'xml'; qualquer outro valor vira 'markdown'.
5. O módulo não conhece o Code Compression (nem tipos, nem defaults).

--- FIM ARQUITETURA DO SCRIPT ---
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
