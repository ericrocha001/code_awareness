/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Traduzir o SourceProfile, o formato de saída e a lista de arquivos selecionados em argumentos CLI válidos para o Repomix.
2. Aplicar regras de dependência entre opções da CLI (subopções de diretório dependem de includeDirectoryStructure).
3. Emitir avisos estruturados ao detectar combinações de flags incompatíveis.
4. Garantir que nenhum caminho de construção emita compressão estrutural.

Mapa de Relacionamentos do Script

1. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome SourceProfile e SourceOutputFormat como contratos de entrada.
   - Criticidade: Alta

2. shared/utils/source-profile.ts
   - Tipo: Dependência Direta
   - Relação: Consome DEFAULT_SOURCE_PROFILE apenas para validação defensiva do formato em runtime.
   - Criticidade: Média

Invariantes do Script

1. O módulo é de domínio puro — sem acesso a filesystem, spawn de processos, IPC, UI ou estado global.
2. Jamais emite a flag de compressão estrutural (--compress) — invariante central do Code Source.
3. Argumentos começam com o transporte de arquivos (--include inline ou --config <path>), seguido das flags opcionais do perfil, --style e --stdout, nesta ordem determinística.
4. Transporte config-file exige configPath absoluto; ausência lança Error (contrato violado pelo chamador).
5. Lista de arquivos vazia no transporte inline lança Error — a geração seletiva requer arquivos selecionados.
6. Formato diferente de markdown/xml lança Error (defesa contra entrada corrompida em runtime).
7. O builder não decide qual transporte usar — decisão pertence ao chamador.

--- FIM ARQUITETURA DO SCRIPT ---
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
