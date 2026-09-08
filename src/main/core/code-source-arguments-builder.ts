/*
-T ---
*/

import type { SourceOutputFormat, SourceProfile } from '../../shared/types'

/**
 * Modo de transporte da lista de arquivos para a CLI do Repomix, próprio do Code Source.
 * - 'inline-include': emite `--include <files,separados,por,virgula>`.
 * - 'config-file':    emite `--config <caminho-absoluto>` (arquivo JSON com {"include": [...]}).
 */
export type SourceIncludeTransport = 'inline-include' | 'config-file'

const SUPPORTED_FORMATS: readonly SourceOutputFormat[] = ['markdown', 'xml']

/**
 * Traduz o SourceProfile, o formato de saída e os arquivos selecionados em argumentos CLI do Repomix.
 *
 * Invariante central: esta função NUNCA emite `--compress` — o Code Source entrega
 * o código-fonte integral, sem compressão estrutural.
 *
 * Ordem determinística dos argumentos:
 * transporte → limpeza → apresentação → estilo → stdout → resumo → estrutura (+ dependentes).
 */
export function buildSourceCliArguments(
  profile: SourceProfile,
  format: SourceOutputFormat,
  files: string[],
  transport: SourceIncludeTransport = 'inline-include',
  configPath?: string
): string[] {
  // Defesa contra formato corrompido em runtime: o contrato tipado já restringe,
  // mas dados persistidos antigos podem escapar da tipagem.
  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new Error(
      `[SourceArgumentsBuilder] Formato "${format}" não suportado pelo Code Source (esperado: markdown | xml).`
    )
  }

  const args: string[] = []

  if (transport === 'config-file') {
    if (!configPath) {
      throw new Error(
        '[SourceArgumentsBuilder] Transporte config-file exige configPath (caminho absoluto do arquivo de configuração).'
      )
    }
    // Em modo config, a lista de arquivos vive no JSON; a CLI recebe apenas o caminho.
    args.push('--config', configPath)
  } else {
    if (files.length === 0) {
      throw new Error('[SourceArgumentsBuilder] A geração seletiva do Code Source exige arquivos selecionados.')
    }
    args.push('--include', files.join(','))
  }

  // Limpeza
  if (profile.removeComments) args.push('--remove-comments')
  if (profile.removeEmptyLines) args.push('--remove-empty-lines')
  if (profile.truncateBase64) args.push('--truncate-base64')

  // Apresentação
  if (profile.showLineNumbers) args.push('--output-show-line-numbers')
  if (profile.parsableStyle) args.push('--parsable-style')

  args.push('--style', format)
  args.push('--stdout')

  // Resumo de arquivo: flag negativa apenas quando desativado (default do Repomix é incluir).
  if (!profile.includeFileSummary) {
    args.push('--no-file-summary')
  }

  // Estrutura de diretórios e flags dependentes.
  if (!profile.includeDirectoryStructure) {
    args.push('--no-directory-structure')
    if (profile.includeEmptyDirectories || profile.includeFullDirectoryStructure) {
      console.warn(
        '[SourceArgumentsBuilder] includeEmptyDirectories/includeFullDirectoryStructure ignorados: requerem includeDirectoryStructure habilitado.'
      )
    }
  } else {
    if (profile.includeEmptyDirectories) args.push('--include-empty-directories')
    if (profile.includeFullDirectoryStructure) args.push('--include-full-directory-structure')
  }

  return args
}
