/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Detectar e executar o Repomix CLI no sistema operacional do usuário.
2. Comprimir um único arquivo a partir de um RepomixRequest via --include, retornando apenas o bloco de código comprimido limpo, com retry para falhas transitórias.
3. Comprimir múltiplos arquivos em batches a partir de um RepomixRequest, retornando um dicionário relativePath -> conteúdo comprimido com preservação de resultados parciais.
4. Registrar logs estruturados de batches (tamanho, código de saída, stderr, duração) e de falhas individuais para diagnóstico acionável.
5. Converter o RepomixRequest em argumentos CLI via buildRepomixCliArguments e delegar a execução do processo ao RepomixProcessRunner.
6. Extrair conteúdo comprimido de saída JSON (transporte json do Compression Core) via parseJsonOutput.
7. Gerar o documento final de Direct Output (markdown/xml) a partir do RepomixRequest, sem cache por arquivo e sem parse em blocos, decidindo entre transporte inline (`--include`) e via arquivo de configuração (`--config`) com base no orçamento da linha de comando inteira.
8. Estender BaseRepomixAdapter para compartilhar a infraestrutura de processo (getCommand, runProcess e checkInstallation).
9. Orquestrar o ciclo de vida do arquivo de configuração temporário no Direct Output: criação em os.tmpdir() (nunca em repoPath) e remoção garantida em finally (mesmo sob erro, exceção ou timeout).

Mapa de Relacionamentos do Script

1. repomix-arguments-builder.ts
   - Tipo: Dependência Direta
   - Relação: Consome buildRepomixCliArguments para derivar argumentos CLI a partir do RepomixRequest.
   - Criticidade: Alta

2. base-repomix-adapter.ts
   - Tipo: Dependência Direta
   - Relação: Estende BaseRepomixAdapter, herdando getCommand, runProcess e checkInstallation (que consomem RepomixProcessRunner).
   - Criticidade: Alta

3. repomix-request.ts
   - Tipo: Contrato / Interface
   - Relação: Recebe RepomixRequest em compressSingleFile e compressMultipleFiles.
   - Criticidade: Alta

4. CompressionService
   - Tipo: Dependência Inversa
   - Relação: Consome compressSingleFile e compressMultipleFiles (Compression Core) e generateDirectOutput (Direct Output markdown/xml).
   - Criticidade: Alta

Invariantes do Script

1. A assinatura pública compressSingleFile(request, relativePath) é estável — o CompressionService depende dela.
2. O parse de blocos deve corresponder exatamente ao relativePath solicitado (não substring).
3. Quebras de linha mistas (\r\n e \n) devem ser normalizadas antes do parse.
4. Falhas em arquivos individuais no lote nunca devem quebrar o lote inteiro.
5. O chunking de batch respeita o orçamento da LINHA DE COMANDO INTEIRA (MAX_COMMAND_LINE_BUDGET), com MAX_BATCH_FILE_COUNT e MAX_FILES_PER_BATCH como limites defensivos secundários.
6. Resultados parciais do batch são preservados — apenas arquivos ausentes entram no fallback individual do CompressionService.
7. O retry em compressSingleFile é limitado a MAX_SINGLE_RETRY_COUNT tentativas com backoff de RETRY_DELAY_MS.
8. O parser tolerante aceita apenas variações conhecidas do formato Repomix — formato irreconhecível retorna string vazia com log.
9. A execução de processo é delegada exclusivamente ao RepomixProcessRunner (que retorna exitCode sem lançar; o adapter decide).
10. No Direct Output, o arquivo de configuração temporário é sempre criado em os.tmpdir() (fora de repoPath), com nome único por execução, e removido em finally — nunca fica órfão em erro/timeout, nem vaza dentro do repositório.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { buildRepomixCliArguments } from './repomix-arguments-builder'
import { BaseRepomixAdapter } from './base-repomix-adapter'
import type { RepomixRequest } from './repomix-request'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Orçamento seguro da LINHA DE COMANDO INTEIRA (em caracteres) para decidir o
 * transporte da lista de arquivos (inline via `--include` vs arquivo via `--config`).
 *
 * Derivação:
 *   1. O limite efetivo de uma linha de comando no cmd.exe (Windows) é de 8.191
 *      caracteres. Estourá-lo produz o erro "linha de comando muito longa".
 *   2. Subtrai-se uma margem de segurança para o caminho do executável (repomix.cmd)
 *      e para as flags fixas do perfil (--compress, --style, --stdout, opcionais),
 *      bem como aspas e separadores — que, no pior caso realista, raramente somam
 *      mais de ~2.000 bytes.
 *   3. O valor 6.000, portanto, representa o teto conservador da linha inteira
 *      estimada em `estimateCommandLineBytes`, deixando folga no caso pior do Windows.
 *
 * Constante única: é usada (a) como limiar de decisão no Direct Output e
 * (b) como teto de bytes em cada batch do Compression Core.
 */
const MAX_COMMAND_LINE_BUDGET = 6000

/**
 * Overhead fixo conservador (bytes) das flags fixas da CLI que o builder emite além
 * do transporte de inclusão. Inclui `--compress`, `--style <fmt>`, `--stdout` e o
 * pior caso do perfil (remove-comments, remove-empty-lines, truncate-base64,
 * parsable-style, structure e no-structure). Usado no pior caso para o orçamento
 * sem depender do perfil concreto — subestimar aqui "estoura" a linha no Windows.
 */
const FIXED_COMMAND_FLAGS_OVERHEAD = 400

// Limite secundário de quantidade: nunca mais de 200 arquivos por batch,
// mesmo que caibam no limite de bytes (defesa contra argumentos excessivos).
const MAX_BATCH_FILE_COUNT = 200

// Limite defensivo de arquivos por batch: conservador para reduzir a superfície de falha do Repomix CLI.
// 20 arquivos por batch é mais confiável que 200, pois o Repomix pode falhar silenciosamente com muitos --include.
const MAX_FILES_PER_BATCH = 20

// Número máximo de tentativas de retry para compressSingleFile em falhas transitórias.
const MAX_SINGLE_RETRY_COUNT = 1

// Backoff entre tentativas de retry (ms).
const RETRY_DELAY_MS = 1000
export class RepomixAdapter extends BaseRepomixAdapter {

/**
   * Comprime um único arquivo e retorna apenas o seu bloco de código,
   * descartando qualquer metadado de introdução ou rodapé do Repomix.
   *
   * Possui mecanismo de retry para falhas transitórias (antivírus, disco ocupado no Windows).
   * Máximo de MAX_SINGLE_RETRY_COUNT retentativas com backoff de RETRY_DELAY_MS.
   *
   * @param retryCount Número de tentativas de retry restantes (uso interno).
   */
  async compressSingleFile(
    request: RepomixRequest,
    relativePath: string,
    retryCount: number = MAX_SINGLE_RETRY_COUNT
  ): Promise<string> {
    const { repoPath, profile, outputFormat } = request
    const command = this.getCommand()
    const args = buildRepomixCliArguments(profile, outputFormat, [relativePath])
    const style = outputFormat

    try {
      const res = await this.runProcess(command, args, { cwd: repoPath })
      if (res.exitCode !== 0) {
        throw new Error(res.stderr.trim() || `Repomix falhou (código ${res.exitCode}).`)
      }
      const result = style === 'json'
        ? this.extractSingleFromJson(res.stdout, relativePath)
        : this.extractFileBlock(res.stdout, relativePath)
      return result
    } catch (err) {
      if (retryCount > 0) {
        const errMsg = err instanceof Error ? err.message : String(err)
        // Apenas erros verdadeiramente transitórios justificam retry.
        // ENOENT e "não encontrado" são erros permanentes — o arquivo não existe e
        // não reaparecerá após 1s de delay. Retry nesses casos apenas adiciona
        // latência sem benefício. EBUSY/EAGAIN indicam lock transitório do SO.
        const isTransient = errMsg.includes('timeout') || errMsg.includes('EBUSY') || errMsg.includes('EAGAIN')
        if (isTransient) {
          console.warn(`[RepomixAdapter] compressSingleFile falhou para "${relativePath}" (tentativa restante: ${retryCount}): ${errMsg}`)
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
          return this.compressSingleFile(request, relativePath, retryCount - 1)
        }
      }
      throw err
    }
  }

  /**
   * Estima os bytes da LINHA DE COMANDO INTEIRA no caso pior do Windows, incluindo:
   * - o caminho do executável (`repomix.cmd`) + separador;
   * - o overhead fixo conservador das flags fixas do perfil (FIXED_COMMAND_FLAGS_OVERHEAD);
   * - o transporte de inclusão: `--include <files.join(',')>` (inline) ou `--config <tmpPath>`
   *   com caminho absoluto típico (config-file);
   * - aspas e separadores do shell.
   *
   * O valor é CONSERVADOR de propósito: subestimar faz a linha estourar no Windows
   * mesmo abaixo do orçamento. Em caso de dúvida, arredonda-se para cima.
   */
  private estimateCommandLineBytes(files: string[], configMode: boolean): number {
    // comando + espaço que o precede na linha (separador entre arg)
    let bytes = Buffer.byteLength('repomix.cmd', 'utf8') + 1
    bytes += FIXED_COMMAND_FLAGS_OVERHEAD

    if (configMode) {
      // Caminho absoluto típico do config no dir temporário do SO (aspas incluídas).
      const typicalPath = join(tmpdir(), 'repomix-cfg-estimate.json')
      bytes += Buffer.byteLength('--config', 'utf8') + 1
      bytes += Buffer.byteLength(typicalPath, 'utf8') + 2 // aspas ao redor do caminho
    } else {
      // --include <files.join(',')> (aspas conservadoras ao redor do valor).
      bytes += Buffer.byteLength('--include', 'utf8') + 1
      bytes += Buffer.byteLength(files.join(','), 'utf8') + 2
    }

    return bytes
  }

  /**
   * Cria um caminho único (timestamp + random) para o arquivo de configuração no
   * temp do SO — NUNCA dentro de repoPath, para não vazar artefatos no repositório.
   */
  private buildTempConfigFilePath(): string {
    const rand = Math.random().toString(36).slice(2, 10)
    return join(tmpdir(), `repomix-cfg-${Date.now()}-${rand}.json`)
  }

  /**
   * Grava o JSON `{"include": [...]}` em um arquivo temporário no dir do SO e
   * retorna o caminho absoluto, para ser passado via `--config`. A remoção é
   * responsabilidade do chamador (bloco finally).
   */
  private writeTempConfigFile(selectedFiles: string[]): string {
    const configPath = this.buildTempConfigFilePath()
    writeFileSync(configPath, JSON.stringify({ include: selectedFiles }), 'utf8')
    return configPath
  }

  /**
   * Divide a lista de caminhos em batches respeitando o orçamento da LINHA DE
   * COMANDO INTEIRA (MAX_COMMAND_LINE_BUDGET), além das limites secundários
   * MAX_BATCH_FILE_COUNT e MAX_FILES_PER_BATCH (defensivos — não gatilho primário).
   */
  private buildBatches(_repoPath: string, relativePaths: string[]): string[][] {
    const batches: string[][] = []
    let currentBatch: string[] = []

    for (const relativePath of relativePaths) {
      // Fecha o batch atual se adicionar este arquivo estouraria o orçamento da linha inteira.
      const candidate = [...currentBatch, relativePath]
      const exceedsLineBudget = this.estimateCommandLineBytes(candidate, false) > MAX_COMMAND_LINE_BUDGET
      const exceedsCount = currentBatch.length >= MAX_BATCH_FILE_COUNT
      const exceedsDefensiveLimit = currentBatch.length >= MAX_FILES_PER_BATCH

      if ((exceedsLineBudget || exceedsCount || exceedsDefensiveLimit) && currentBatch.length > 0) {
        batches.push(currentBatch)
        currentBatch = []
      }

      currentBatch.push(relativePath)
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch)
    }

    return batches
  }

/**
   * Parser único do stdout que extrai todos os arquivos em uma única passagem O(n).
   * Tolerante a variações conhecidas do formato Repomix:
   * - Cabeçalho com espaços extras ("File:  src/file.ts")
   * - Separador com mais ou menos caracteres ("====" a "================")
   * - Conteúdo vazio entre separadores (arquivo sem esqueleto estrutural)
   * - Ausência de separador final (EOF)
   *
   * Formato típico do Repomix (style plain em lote):
   *   ================================================================
   *   Files
   *   ================================================================
   *
   *   ================
   *   File: src/a.ts
   *   ================
   *   <conteúdo comprimido de a.ts>
   *   ================
   *   File: src/b.ts
   *   ================
   *   <conteúdo comprimido de b.ts>
   *   ================================================================
   *   End of Codebase
   *   ================================================================
   */
  parseBatchOutput(stdout: string): Record<string, string> {
    const lines = stdout.replace(/\r\n/g, '\n').split('\n')
    const results: Record<string, string> = {}

    // Separador tolerante: aceita qualquer sequência de 4+ "=" (com possível espaço ao redor)
    const isSeparator = (line: string): boolean => /^={4,}\s*$/.test(line.trim())
    // Cabeçalho tolerante: "File:" seguido de um ou mais espaços e o caminho
    const isFileHeader = (line: string): boolean => /^File:\s+\S/.test(line)
    const parseFilePath = (line: string): string => line.replace(/^File:\s+/, '').trim()

    let currentPath: string | null = null
    let collecting = false
    let currentLines: string[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Quando encontra o cabeçalho "File: <path>", registra o início do arquivo
      if (isFileHeader(line)) {
        // Salva o arquivo anterior antes de iniciar o próximo
        if (currentPath !== null) {
          results[currentPath] = currentLines.join('\n').trim()
        }
        currentPath = parseFilePath(line)
        collecting = false
        currentLines = []
        continue
      }

      // Separador que inicia a coleta do arquivo após o cabeçalho "File: ..."
      if (currentPath !== null && !collecting && isSeparator(line)) {
        collecting = true
        continue
      }

      // Durante a coleta: o próximo separador encerra a coleta do arquivo atual
      if (collecting) {
        if (isSeparator(line)) {
          if (currentPath !== null) {
            results[currentPath] = currentLines.join('\n').trim()
          }
          currentPath = null
          collecting = false
          currentLines = []
        } else {
          currentLines.push(line)
        }
      }
    }

    // Salva o último arquivo se ainda pendente (ausência de separador final / EOF)
    if (currentPath !== null) {
      results[currentPath] = currentLines.join('\n').trim()
    }

    return results
  }

  /**
   * Extrai o dicionário caminho → conteúdo de uma saída JSON do Repomix
   * (transporte json do Compression Core). Nunca lança: retorna {} em falha.
   */
  parseJsonOutput(stdout: string): Record<string, string> {
    try {
      const data = JSON.parse(stdout) as { files?: Record<string, string> }
      return data.files ?? {}
    } catch {
      return {}
    }
  }

  /**
   * Extrai o conteúdo de um único arquivo de uma saída JSON.
   * Retorna string vazia se a chave não existir ou o JSON for inválido.
   */
  private extractSingleFromJson(stdout: string, relativePath: string): string {
    try {
      const data = JSON.parse(stdout) as { files?: Record<string, string> }
      const files = data.files ?? {}
      return files[relativePath] ?? ''
    } catch {
      return ''
    }
  }
/**
   * Comprime múltiplos arquivos em batches reais via Repomix CLI com múltiplos padrões --include.
   *
   * Estratégia:
   *   1. Divide selectedFiles em batches respeitando MAX_INCLUDE_PATTERN_BYTES, MAX_BATCH_FILE_COUNT e MAX_FILES_PER_BATCH.
   *   2. Executa os batches em paralelo com limite de concorrência (MAX_CONCURRENT = 5).
   *   3. Cada batch executa repomix com --include contendo os arquivos separados por vírgula.
   *   4. Extrai todos os arquivos do stdout em passagem única O(n) via parseBatchOutput.
   *   5. Preserva resultados parciais: arquivos presentes são retornados no dicionário,
   *      permitindo que o CompressionService envie apenas ausentes para o fallback individual.
   *   6. Registra logs estruturados por batch para diagnóstico acionável.
   */
  async compressMultipleFiles(request: RepomixRequest): Promise<Record<string, string>> {
    const { repoPath, selectedFiles, profile, outputFormat } = request
    if (selectedFiles.length === 0) {
      return {}
    }

    const MAX_CONCURRENT = 5
    const batches = this.buildBatches(repoPath, selectedFiles)
    const results: Record<string, string> = {}
    const command = this.getCommand()
    const style = outputFormat

    console.log(`[RepomixAdapter] compressMultipleFiles: ${selectedFiles.length} arquivo(s) → ${batches.length} batch(es)`)

    // Processa os batches em paralelo com controle de concorrência
    for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
      const batchChunk = batches.slice(i, i + MAX_CONCURRENT)

      const batchResults = await Promise.allSettled(
        batchChunk.map(async (batch, chunkIndex) => {
          const batchIndex = i + chunkIndex
          const args = buildRepomixCliArguments(profile, outputFormat, batch)

          const startMs = Date.now()

          try {
            const res = await this.runProcess(command, args, { cwd: repoPath })
            const { stdout, stderr, exitCode } = res
            const durationMs = Date.now() - startMs
            console.log(`[RepomixAdapter] batch[${batchIndex}]: ${batch.length} arquivo(s), saída=${exitCode}, duração=${durationMs}ms${stderr ? `, stderr="${stderr.slice(0, 120)}"` : ''}`)

            if (exitCode !== 0) {
              throw new Error(stderr.trim() || `Repomix falhou (código ${exitCode}).`)
            }

            const parsed = style === 'json'
              ? this.parseJsonOutput(stdout)
              : this.parseBatchOutput(stdout)

            // Log de arquivos ausentes no batch (falha de parse ou arquivo não retornado)
            for (const rel of batch) {
              if (!parsed[rel] || parsed[rel].trim().length === 0) {
                console.warn(`[RepomixAdapter] batch[${batchIndex}]: arquivo ausente no stdout — "${rel}"`)
              }
            }

            return parsed
          } catch (err) {
            const durationMs = Date.now() - startMs
            const errMsg = err instanceof Error ? err.message : String(err)
            console.error(`[RepomixAdapter] batch[${batchIndex}] FALHOU: ${batch.length} arquivo(s), duração=${durationMs}ms, erro="${errMsg}"`)
            throw err
          }
        })
      )

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j]
        if (result.status === 'fulfilled') {
          Object.assign(results, result.value)
        } else {
          console.error(`[RepomixAdapter] batch[${i + j}] rejeitado:`, result.reason)
        }
      }
    }

    const successCount = Object.keys(results).filter(k => results[k] && results[k].trim().length > 0).length
    const failCount = selectedFiles.length - successCount
    if (failCount > 0) {
      console.warn(`[RepomixAdapter] compressMultipleFiles resumo: ${successCount} sucesso(s), ${failCount} falha(s) de ${selectedFiles.length} arquivo(s)`)
    }

    return results
  }

  /**
   * Gera o documento final (Markdown/XML) para o caminho Direct Output.
   * Não faz cache por arquivo nem parse em blocos: o stdout é o documento.
   * Em falha (exit != 0, saída vazia ou erro de processo), retorna failed:true
   * com motivo para que o orquestrador preserve o contrato de falha total.
   */
  async generateDirectOutput(
    request: RepomixRequest
  ): Promise<{ content: string; failed: boolean; reason?: string }> {
    const { repoPath, selectedFiles, profile, outputFormat } = request

    if (selectedFiles.length === 0) {
      return { content: '', failed: true, reason: 'Nenhum arquivo selecionado para Direct Output.' }
    }

    const command = this.getCommand()
    const startMs = Date.now()

    // Decisão de transporte baseada no orçamento da LINHA DE COMANDO INTEIRA:
    // abaixo do orçamento, mantém o caminho provado (inline via --include);
    // acima, grava um JSON temporário fora do repositório e passa --config.
    const estimatedInlineBytes = this.estimateCommandLineBytes(selectedFiles, false)
    const useConfigFile = estimatedInlineBytes > MAX_COMMAND_LINE_BUDGET

    let configFilePath: string | undefined

    // A escrita do config (quando necessária) acontece DENTRO deste try: se o adapter
    // lançar antes do runProcess, o finally abaixo ainda remove o arquivo, evitando órfãos.
    try {
      let args: string[]

      if (useConfigFile) {
        configFilePath = this.writeTempConfigFile(selectedFiles)
        console.log(
          `[RepomixAdapter] direct-output: transporte via --config (${selectedFiles.length} arquivos, estimativa ${estimatedInlineBytes} bytes > orçamento ${MAX_COMMAND_LINE_BUDGET})`
        )
        args = buildRepomixCliArguments(profile, outputFormat, selectedFiles, 'config-file', configFilePath)
      } else {
        args = buildRepomixCliArguments(profile, outputFormat, selectedFiles)
      }

      const res = await this.runProcess(command, args, { cwd: repoPath, timeoutMs: 120000 })
      const durationMs = Date.now() - startMs
      console.log(`[RepomixAdapter] direct-output: ${selectedFiles.length} arquivos, formato=${outputFormat}, duração=${durationMs}ms, código=${res.exitCode}`)

      if (res.exitCode !== 0) {
        return { content: '', failed: true, reason: res.stderr.trim() || `Repomix falhou (código ${res.exitCode}).` }
      }

      const content = res.stdout.trim()
      if (!content) {
        return { content: '', failed: true, reason: 'Saída vazia do Repomix no Direct Output.' }
      }

      return { content, failed: false }
    } finally {
      // Remoção garantida do config temporário — sempre, mesmo sob erro ou timeout.
      if (configFilePath) {
        try {
          unlinkSync(configFilePath)
          console.log(`[RepomixAdapter] direct-output: arquivo temporário removido — "${configFilePath}"`)
        } catch (removeErr) {
          const msg = removeErr instanceof Error ? removeErr.message : String(removeErr)
          console.warn(`[RepomixAdapter] direct-output: falha ao remover temporário "${configFilePath}": ${msg}`)
        }
      }
    }
  }

  /**
   * Varre a saída do Repomix linha por linha e isola apenas o bloco
   * de código relativo ao arquivo requisitado.
   *
   * Formato típico do Repomix (style plain):
   *   ...boilerplate...
   *   File: src/index.ts
   *   ================
   *   <código comprimido>
   *   ================
   *   ...próximo arquivo ou rodapé...
   */
  /**
   * Varre a saída do Repomix linha por linha e isola apenas o bloco
   * de código relativo ao arquivo requisitado.
   *
   * Formato típico do Repomix (style plain):
   *   ...boilerplate...
   *   File: src/index.ts
   *   ================
   *   <código comprimido>
   *   ================
   *   ...próximo arquivo ou rodapé...
   */
  private extractFileBlock(stdout: string, relativePath: string): string {
    // Normaliza quebras de linha mistas (\r\n → \n) para varredura uniforme
    const lines = stdout.replace(/\r\n/g, '\n').split('\n')

    const fileHeader = `File: ${relativePath}`

    let foundHeader = false
    let foundSeparatorAfterHeader = false
    const collected: string[] = []

    for (const line of lines) {
      // Passo 1 — encontra a linha de cabeçalho do arquivo
      if (!foundHeader) {
        if (line.trim() === fileHeader) foundHeader = true
        continue
      }

      // Passo 2 — aguarda o separador imediatamente após o cabeçalho (tolerante a comprimento)
      if (!foundSeparatorAfterHeader) {
        if (/^={4,}\s*$/.test(line.trim())) foundSeparatorAfterHeader = true
        continue
      }

      // Passo 3 — coleta até o próximo separador (próximo arquivo ou fim)
      if (/^={4,}\s*$/.test(line.trim())) break
      collected.push(line)
    }

    return collected.join('\n').trim()
  }

}