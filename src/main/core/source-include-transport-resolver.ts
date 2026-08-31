/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Decidir o transporte de inclusão (inline-include vs config-file) com base na estimativa de tamanho da linha de comando.
2. Calcular a estimativa em bytes UTF-8 da linha de comando no modo inline.
3. Criar o arquivo de configuração temporário JSON com a lista de arquivos selecionados.
4. Remover o arquivo de configuração temporário tolerando falha sem lançar.

Mapa de Relacionamentos do Script

1. code-source-arguments-builder.ts
   - Tipo: Dependência Direta
   - Relação: Importa o tipo SourceIncludeTransport como contrato de retorno do método decide.
   - Criticidade: Alta

2. repomix-output-adapter.ts
   - Tipo: Dependência Inversa
   - Relação: Consome decide, estimateInlineBytes, createTempConfigFile e removeTempConfigFile.
   - Criticidade: Alta

Invariantes do Script

1. decide retorna 'config-file' estritamente quando a estimativa excede o orçamento (comparação com >).
2. A fórmula de estimateInlineBytes preserva exatamente os mesmos operandos do adapter original, incluindo o literal 'repomix.cmd'.
3. createTempConfigFile escreve o arquivo no diretório temporário do SO, nunca no repositório.
4. removeTempConfigFile nunca lança — registra aviso em falha e encerra silenciosamente.
5. O limiar de orçamento e o overhead de flags são idênticos aos valores originais do adapter.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SourceIncludeTransport } from './code-source-arguments-builder'

/**
 * Orçamento seguro da linha de comando inteira (caracteres).
 * Mesmo valor do adapter original — exportado para uso no log diagnóstico.
 */
export const SOURCE_MAX_COMMAND_LINE_BUDGET = 6000

/** Overhead fixo conservador das flags fixas da CLI além do transporte. */
const SOURCE_FIXED_COMMAND_FLAGS_OVERHEAD = 400

/**
 * Decide e gerencia o transporte de inclusão dos arquivos selecionados para o comando Repomix.
 */
export class SourceIncludeTransportResolver {
  /**
   * Decide o transporte a utilizar com base na estimativa do tamanho da linha de comando.
   * Retorna 'config-file' quando a estimativa excede o orçamento; 'inline-include' caso contrário.
   */
  decide(selectedFiles: string[]): SourceIncludeTransport {
    return this.estimateInlineBytes(selectedFiles) > SOURCE_MAX_COMMAND_LINE_BUDGET
      ? 'config-file'
      : 'inline-include'
  }

  /**
   * Calcula a estimativa em bytes UTF-8 da linha de comando no modo inline.
   *
   * NOTA: o literal 'repomix.cmd' é preservado intencionalmente para manter
   * comportamento idêntico ao adapter original — não corrigir para getCommand().
   */
  estimateInlineBytes(selectedFiles: string[]): number {
    return (
      Buffer.byteLength('repomix.cmd', 'utf8') +
      1 +
      SOURCE_FIXED_COMMAND_FLAGS_OVERHEAD +
      Buffer.byteLength('--include', 'utf8') +
      1 +
      Buffer.byteLength(selectedFiles.join(','), 'utf8') +
      2
    )
  }

  /**
   * Cria um arquivo JSON no diretório temporário do SO com a chave `include`
   * contendo os arquivos selecionados. Retorna o caminho absoluto criado.
   */
  createTempConfigFile(selectedFiles: string[]): string {
    const rand = Math.random().toString(36).slice(2, 10)
    const configPath = join(tmpdir(), `code-source-cfg-${Date.now()}-${rand}.json`)
    try {
      writeFileSync(configPath, JSON.stringify({ include: selectedFiles }), 'utf8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `[SourceIncludeTransportResolver] Falha ao criar arquivo de configuração temporário "${configPath}": ${msg}`
      )
    }
    return configPath
  }

  /**
   * Remove o arquivo temporário no caminho informado.
   * Tolera falha: registra aviso e não lança.
   */
  removeTempConfigFile(configPath: string): void {
    try {
      unlinkSync(configPath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[SourceIncludeTransportResolver] Falha ao remover temporário "${configPath}": ${msg}`
      )
    }
  }
}
