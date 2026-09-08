/*
-T ---
*/

import type { OutputFormat } from '../../shared/types'
import type { EffectiveProfile } from './effective-profile'
import type { RepomixRequest } from './repomix-request'

/** Mapeia o formato de transporte para a flag --style do Repomix. */
export function outputFormatToStyle(format: OutputFormat): string {
  return format
}

/**
 * Modo de transporte da lista de arquivos para a CLI do Repomix.
 * - 'inline-include': emite `--include <files,separados,por,virgula>`.
 * - 'config-file':    emite `--config <caminho-absoluto>` (arquivo JSON com {"include": [...]}).
 */
export type IncludeTransport = 'inline-include' | 'config-file'

/**
 * Construção do contrato tipado de uma operação de compressão.
 * Encapsula repositório, arquivos selecionados, perfil efetivo e formato.
 */
export function buildRepomixRequest(
  repoPath: string,
  selectedFiles: string[],
  profile: EffectiveProfile,
  outputFormat: OutputFormat
): RepomixRequest {
  return {
    repoPath,
    selectedFiles,
    profile,
    outputFormat
  }
}

/**
 * Traduz o EffectiveProfile, o OutputFormat e os arquivos selecionados em argumentos CLI do Repomix.
 *
 * Nota sobre --output-show-line-numbers:
 * A flag é deliberadamente NÃO emitida. Ela é no-op sob `--compress` (que é sempre
 * incluído na combinação), pois a compactação Tree-sitter remove as linhas originais
 * e a numeração não é emitida. O campo `showLineNumbers` é preservado no EffectiveProfile
 * apenas para compatibilidade/legibilidade do perfil, sem efeito na CLI do Repomix 1.15.0.
 */
export function buildRepomixCliArguments(
  profile: EffectiveProfile,
  format: OutputFormat,
  files: string[],
  transport: IncludeTransport = 'inline-include',
  configPath?: string
): string[] {
  const args: string[] = []

  if (transport === 'config-file') {
    if (!configPath) {
      throw new Error(
        '[RepomixArgumentsBuilder] Transporte config-file exige configPath (caminho absoluto do arquivo de configuração).'
      )
    }
    // Em modo config, a lista de arquivos vive no JSON; a CLI recebe apenas o caminho.
    args.push('--config', configPath)
  } else {
    args.push('--include', files.join(','))
  }

  // --compress é obrigatório e invisível (núcleo da compressão).
  args.push('--compress')

  if (profile.removeComments) args.push('--remove-comments')
  if (profile.removeEmptyLines) args.push('--remove-empty-lines')
  if (profile.truncateBase64) args.push('--truncate-base64')

  if (profile.path === 'direct-output') {
    if (profile.parsableStyle) {
      if (format === 'xml' || format === 'markdown') {
        args.push('--parsable-style')
      } else {
        console.warn(
          `[RepomixArgumentsBuilder] parsableStyle é irrelevante para o formato "${format}" — flag omitida.`
        )
      }
    }
  }

  args.push('--style', outputFormatToStyle(format))
  args.push('--stdout')

  if (profile.path === 'direct-output') {
    if (!profile.includeFileSummary) {
      args.push('--no-file-summary')
    }

    if (!profile.includeDirectoryStructure) {
      args.push('--no-directory-structure')
      if (profile.includeEmptyDirectories || profile.includeFullDirectoryStructure) {
        console.warn(
          '[RepomixArgumentsBuilder] includeEmptyDirectories/includeFullDirectoryStructure ignorados: requerem includeDirectoryStructure habilitado.'
        )
      }
    } else {
      if (profile.includeEmptyDirectories) args.push('--include-empty-directories')
      if (profile.includeFullDirectoryStructure) args.push('--include-full-directory-structure')
    }
  }

  return args
}
