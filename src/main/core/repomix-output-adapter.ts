/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Gerar o Markdown completo de um repositório via Repomix CLI (generateFullRepositoryMarkdown).
2. Gerar Markdown/XML seletivo dos arquivos escolhidos com contagem heurística de tokens (generateSelectiveMarkdown).
3. Gerar saída seletiva do Code Source a partir de perfil e formato próprios (generateSelectiveSource), decidindo internamente o transporte entre inclusão inline e arquivo de configuração temporário.

Mapa de Relacionamentos do Script

1. base-repomix-adapter.ts
   - Tipo: Dependência Direta
   - Relação: Estende BaseRepomixAdapter para herdar getCommand, runProcess e checkInstallation.
   - Criticidade: Alta

2. code-source-arguments-builder.ts
   - Tipo: Dependência Direta
   - Relação: Consome buildSourceCliArguments para derivar argumentos CLI do Code Source.
   - Criticidade: Alta

3. shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Consome SourceOutputFormat e SourceProfile como contratos do novo método.
   - Criticidade: Alta

4. code-source-service.ts
   - Tipo: Dependência Inversa
   - Relação: Consome generateFullRepositoryMarkdown, generateSelectiveMarkdown e generateSelectiveSource.
   - Criticidade: Alta

5. git-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Instancia e usa checkInstallation para o Code Source.
   - Criticidade: Média

Invariantes do Script

1. generateSelectiveMarkdown nunca aceita selectedFiles vazio — lança Error explícito.
2. A contagem de tokens é heurística (~4 caracteres por token) calculada sobre o conteúdo gerado.
3. checkInstallation usa timeout de 10s e nunca lança (herdado da base).
4. Falha do Repomix (exitCode != 0) lança Error com stderr ou código.
5. Não contém lógica de compressão (cache, batch, fallback, parsing) — limita-se ao output de documentos.
6. generateSelectiveSource JAMAIS emite compressão estrutural — o builder do Code Source é a única fonte de argumentos.
7. O arquivo de configuração temporário do Code Source é criado em os.tmpdir() (nunca em repoPath) e removido em finally, mesmo sob erro.
8. O adapter não importa nenhum módulo do Code Compression.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BaseRepomixAdapter } from './base-repomix-adapter'
import { buildSourceCliArguments } from './code-source-arguments-builder'
import type { SourceOutputFormat, SourceProfile } from '../../shared/types'

/**
 * Orçamento seguro da linha de comando inteira (caracteres) — mesmo valor e
 * derivação usados no Direct Output do Compression (limite de 8.191 chars do
 * cmd.exe menos margem para executável e flags). Valor duplicado de propósito:
 * o Code Source não pode importar módulos do Code Compression.
 */
const SOURCE_MAX_COMMAND_LINE_BUDGET = 6000

/** Overhead fixo conservador das flags fixas da CLI além do transporte (ver adapter de compressão). */
const SOURCE_FIXED_COMMAND_FLAGS_OVERHEAD = 400

export class RepomixOutputAdapter extends BaseRepomixAdapter {
  /**
   * Gera o markdown completo de um repositório via Repomix.
   */
  async generateFullRepositoryMarkdown(repoPath: string): Promise<string> {
    const args = [
      '--style', 'markdown',
      '--stdout'
      // Omitido --no-file-summary para manter o resumo padrão
    ]
    const res = await this.runProcess(this.getCommand(), args, { cwd: repoPath, timeoutMs: 120000 })
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `Repomix falhou (código ${res.exitCode}).`)
    }
    return res.stdout
  }

  /**
   * Gera Markdown apenas dos arquivos selecionados e retorna também a contagem de tokens.
   * A contagem é calculada diretamente sobre o conteúdo gerado, refletindo o tamanho real
   * do texto que será enviado para a IA.
   */
  async generateSelectiveMarkdown(
    repoPath: string,
    selectedFiles: string[],
    format: 'markdown' | 'xml' = 'markdown'
  ): Promise<{ content: string; tokenCount: number }> {
    if (selectedFiles.length === 0) {
      throw new Error('Nenhum arquivo selecionado para geração seletiva.')
    }

    const includePattern = selectedFiles.join(',')

    // Execução única: gera o conteúdo Markdown/XML dos arquivos selecionados
    const res = await this.runProcess(this.getCommand(), [
      '--include', includePattern,
      '--style', format,
      '--stdout',
      '--no-file-summary'
    ], { cwd: repoPath, timeoutMs: 120000 })

    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `Repomix falhou (código ${res.exitCode}).`)
    }

    // Contagem de tokens diretamente sobre o conteúdo gerado.
    // Estimativa conservadora: ~4 caracteres por token (média para texto em inglês/código).
    // Sem dependência externa de tokenização, esta é a aproximação mais simples e confiável.
    const tokenCount = Math.ceil(res.stdout.length / 4)

    return { content: res.stdout, tokenCount }
  }

  /**
   * Geração seletiva do Code Source: traduz perfil + formato via builder puro,
   * decide o transporte (inline vs config temporário) pelo orçamento da linha
   * de comando e executa o Repomix, retornando apenas o conteúdo gerado.
   *
   * NUNCA emite compressão estrutural e NUNCA escreve artefato no repositório.
   */
  async generateSelectiveSource(
    repoPath: string,
    selectedFiles: string[],
    format: SourceOutputFormat,
    profile: SourceProfile
  ): Promise<string> {
    // Validação defensiva antes do builder — o erro aqui é do chamador.
    if (!repoPath || typeof repoPath !== 'string') {
      throw new Error('[RepomixOutputAdapter] repoPath é obrigatório e deve ser uma string não vazia.')
    }
    if (!Array.isArray(selectedFiles) || selectedFiles.length === 0) {
      throw new Error('[RepomixOutputAdapter] Nenhum arquivo selecionado para geração seletiva do Code Source.')
    }

    const command = this.getCommand()
    const estimatedInlineBytes =
      Buffer.byteLength('repomix.cmd', 'utf8') +
      1 +
      SOURCE_FIXED_COMMAND_FLAGS_OVERHEAD +
      Buffer.byteLength('--include', 'utf8') +
      1 +
      Buffer.byteLength(selectedFiles.join(','), 'utf8') +
      2
    const useConfigFile = estimatedInlineBytes > SOURCE_MAX_COMMAND_LINE_BUDGET

    let configFilePath: string | undefined
    try {
      let args: string[]
      if (useConfigFile) {
        configFilePath = this.writeSourceTempConfigFile(selectedFiles)
        console.log(
          `[RepomixOutputAdapter] code-source: transporte via --config (${selectedFiles.length} arquivos, estimativa ${estimatedInlineBytes} bytes > orçamento ${SOURCE_MAX_COMMAND_LINE_BUDGET})`
        )
        args = buildSourceCliArguments(profile, format, selectedFiles, 'config-file', configFilePath)
      } else {
        args = buildSourceCliArguments(profile, format, selectedFiles, 'inline-include')
      }

      const res = await this.runProcess(command, args, { cwd: repoPath, timeoutMs: 120000 })
      if (res.exitCode !== 0) {
        throw new Error(res.stderr.trim() || `Repomix falhou (código ${res.exitCode}).`)
      }
      return res.stdout
    } finally {
      // Remoção garantida do config temporário — sempre, mesmo sob erro ou timeout.
      if (configFilePath) {
        try {
          unlinkSync(configFilePath)
        } catch (removeErr) {
          const msg = removeErr instanceof Error ? removeErr.message : String(removeErr)
          console.warn(`[RepomixOutputAdapter] code-source: falha ao remover temporário "${configFilePath}": ${msg}`)
        }
      }
    }
  }

  /**
   * Grava o JSON {"include": [...]} em um arquivo temporário NO tmpdir do SO
   * (nunca dentro do repoPath) e retorna o caminho absoluto. A remoção é
   * responsabilidade do chamador (bloco finally).
   */
  private writeSourceTempConfigFile(selectedFiles: string[]): string {
    const rand = Math.random().toString(36).slice(2, 10)
    const configPath = join(tmpdir(), `code-source-cfg-${Date.now()}-${rand}.json`)
    try {
      writeFileSync(configPath, JSON.stringify({ include: selectedFiles }), 'utf8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`[RepomixOutputAdapter] Falha ao criar arquivo de configuração temporário "${configPath}": ${msg}`)
    }
    return configPath
  }
}
