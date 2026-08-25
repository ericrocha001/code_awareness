/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Traduzir o EffectiveProfile, o OutputFormat e a lista de arquivos em argumentos CLI válidos para o Repomix.
2. Aplicar regras de dependência entre opções da CLI (ex.: subopções de diretório dependem de includeDirectoryStructure).
3. Emitir avisos estruturados ao detectar combinações de flags incompatíveis.
4. Produzir o contrato tipado RepomixRequest a partir do repositório, arquivos, perfil efetivo e formato de transporte.

Mapa de Relacionamentos do Script

1. effective-profile.ts
   - Tipo: Dependência Direta
   - Relação: Consome o tipo EffectiveProfile para guiar a construção dos argumentos CLI e do RepomixRequest.
   - Criticidade: Alta

2. repomix-request.ts
   - Tipo: Dependência Direta
   - Relação: buildRepomixRequest produz uma RepomixRequest (Contrato / Interface).
   - Criticidade: Alta

3. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome OutputFormat.
   - Criticidade: Alta

4. repomix-adapter.ts
   - Tipo: Dependência Inversa
   - Relação: Consome buildRepomixCliArguments para derivar os argumentos CLI a partir do RepomixRequest.
   - Criticidade: Alta

5. compression-service.ts
   - Tipo: Dependência Inversa
   - Relação: Consome buildRepomixRequest para construir o contrato enviado ao adapter.
   - Criticidade: Alta

Invariantes do Script

1. O módulo é de domínio puro — sem acesso a filesystem, spawn de processos ou estado global.
2. Argumentos de saída sempre começam com o transporte de inclusão: `--include <files>` (inline-include) ou `--config <path>` (config-file), seguidos de --compress, flags opcionais do perfil, --style e --stdout.
3. --compress e --stdout são sempre incluídos em todas as construções.
4. --output-show-line-numbers nunca é emitido em nenhum caminho — é no-op sob --compress, sempre presente na combinação.
5. outputFilePathStyle nunca é emitido na CLI (inexistente no Repomix 1.15.0).
6. Warnings estruturados são emitidos via console.warn para configurações conflituosas.
7. O builder não conhece filesystem nem paths absolutos — a decisão do modo de transporte (inline vs config) pertence ao adapter; quando `transport === 'config-file'` e `configPath` é omitido, o módulo lança Error (contrato violado pelo chamador).

--- FIM ARQUITETURA DO SCRIPT ---
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
