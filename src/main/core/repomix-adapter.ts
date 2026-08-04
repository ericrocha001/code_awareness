/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Detectar e executar o Repomix CLI no sistema operacional do usuário.
2. Comprimir um único arquivo do repositório via --include, retornando apenas o bloco de código comprimido limpo.
3. Comprimir múltiplos arquivos em uma única chamada CLI, retornando um dicionário relativePath -> conteúdo comprimido.
4. Gerar o Markdown completo do repositório para o Code Source, verificando sua instalação.
5. Gerar Markdown seletivo (arquivos escolhidos) com contagem de tokens.

Mapa de Relacionamentos do Script

1. CodeSourceService
   - Tipo: Dependência Inversa
   - Relação: Consome generateFullRepositoryMarkdown e generateSelectiveMarkdown.
   - Criticidade: Alta

2. CompressionService (futuro)
   - Tipo: Dependência Inversa
   - Relação: Consumirá compressSingleFile e compressMultipleFiles.
   - Criticidade: Alta

Invariantes do Script

1. O método compressSingleFile nunca deve ser alterado ou removido.
2. O parse de blocos deve corresponder exatamente ao relativePath solicitado (não substring).
3. Quebras de linha mistas (\r\n e \n) devem ser normalizadas antes do parse.
4. Falhas em arquivos individuais no lote nunca devem quebrar o lote inteiro.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { spawn } from 'child_process'

export class RepomixAdapter {
  private getCommand(): string {
    return process.platform === 'win32' ? 'repomix.cmd' : 'repomix'
  }

  /**
   * Verifica se o Repomix está instalado e acessível no sistema.
   */
  async checkInstallation(): Promise<boolean> {
    try {
      await this.runProcess(this.getCommand(), ['--version'], process.cwd(), 10000)
      return true
    } catch {
      return false
    }
  }

  /**
   * Gera o markdown completo de um repositório via Repomix.
   */
  async generateFullRepositoryMarkdown(repoPath: string): Promise<string> {
    const command = this.getCommand()
    const args = [
      '--style', 'markdown',
      '--stdout'
      // Omitido --no-file-summary para manter o resumo padrão
    ]

    return this.runProcess(command, args, repoPath, 120000)
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

    const command = this.getCommand()
    const includePattern = selectedFiles.join(',')

    // Execução única: gera o conteúdo Markdown/XML dos arquivos selecionados
    const content = await this.runProcess(command, [
      '--include', includePattern,
      '--style', format,
      '--stdout',
      '--no-file-summary'
    ], repoPath, 120000)

    // Contagem de tokens diretamente sobre o conteúdo gerado.
    // Estimativa conservadora: ~4 caracteres por token (média para texto em inglês/código).
    // Sem dependência externa de tokenização, esta é a aproximação mais simples e confiável.
    const tokenCount = Math.ceil(content.length / 4)

    return { content, tokenCount }
  }

  /**
   * Comprime um único arquivo e retorna apenas o seu bloco de código,
   * descartando qualquer metadado de introdução ou rodapé do Repomix.
   *
   * Estratégia de extração orientada a linhas:
   *   1. Procura a linha com o cabeçalho exato "File: <relativePath>".
   *   2. Avança até a próxima linha separadora ("================").
   *   3. Coleta todas as linhas subsequentes até o próximo separador ou EOF.
   */
  async compressSingleFile(repoPath: string, relativePath: string): Promise<string> {
    const command = this.getCommand()
    const args = [
      '--include', relativePath,
      '--compress',
      '--output-show-line-numbers',
      '--style', 'plain',
      '--stdout',
      '--no-file-summary',
      '--no-directory-structure'
    ]

    const stdout = await this.runProcess(command, args, repoPath)
    return this.extractFileBlock(stdout, relativePath)
  }

  /**
   * Comprime múltiplos arquivos usando chamadas individuais paralelas.
   *
   * Estratégia:
   *   1. Processa arquivos em paralelo com limite de concorrência (MAX_CONCURRENT).
   *   2. Usa compressSingleFile para cada arquivo individualmente (confiável).
   *   3. Usa Promise.allSettled para capturar erros individuais sem quebrar o lote.
   *
   * Por que não usar múltiplos --include?
   *   O Repomix CLI não suporta de forma confiável múltiplos flags --include
   *   quando há muitos arquivos, resultando em falhas silenciosas.
   */
  async compressMultipleFiles(
    repoPath: string,
    relativePaths: string[]
  ): Promise<Record<string, string>> {
    if (relativePaths.length === 0) {
      return {}
    }

    const MAX_CONCURRENT = 5
    const results: Record<string, string> = {}
    const errors: string[] = []

    // Processa em chunks para limitar concorrência
    for (let i = 0; i < relativePaths.length; i += MAX_CONCURRENT) {
      const chunk = relativePaths.slice(i, i + MAX_CONCURRENT)

      const chunkResults = await Promise.allSettled(
        chunk.map(async (relativePath) => {
          const content = await this.compressSingleFile(repoPath, relativePath)
          return { path: relativePath, content }
        })
      )

      for (let j = 0; j < chunkResults.length; j++) {
        const result = chunkResults[j]
        const path = chunk[j]

        if (result.status === 'fulfilled') {
          results[path] = result.value.content
        } else {
          console.error(`Erro ao comprimir ${path}:`, result.reason)
          errors.push(path)
        }
      }
    }

    // Falhas individuais são omitidas do resultado sem lançar exceção.
    // O CompressionService (consumidor) já lida com arquivos ausentes no dicionário,
    // adicionando-os à seção de erros sem descartar os resultados bem-sucedidos.
    return results
  }

  /**
   * Executa o processo filho e retorna stdout como string.
   * Rejeita se o processo sair com código diferente de 0.
   */
  private runProcess(command: string, args: string[], cwd: string, timeoutMs: number = 120000): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd,
        shell: process.platform === 'win32'
      })

      let stdout = ''
      let stderr = ''

      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error(`Processo do Repomix excedeu o timeout de ${timeoutMs / 1000}s.`))
      }, timeoutMs)

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve(stdout)
        } else {
          const msg = stderr.trim()
            ? `Repomix falhou: ${stderr.trim()}`
            : 'Repomix não foi detectado ou falhou ao processar o arquivo.'
          reject(new Error(msg))
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`Repomix não encontrado. Detalhes: ${err.message}`))
      })
    })
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
  private extractFileBlock(stdout: string, relativePath: string): string {
    // Normaliza quebras de linha mistas (\r\n → \n) para varredura uniforme
    const lines = stdout.replace(/\r\n/g, '\n').split('\n')

    const SEPARATOR = '================'
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

      // Passo 2 — aguarda o separador imediatamente após o cabeçalho
      if (!foundSeparatorAfterHeader) {
        if (line.startsWith(SEPARATOR)) foundSeparatorAfterHeader = true
        continue
      }

      // Passo 3 — coleta até o próximo separador (próximo arquivo ou fim)
      if (line.startsWith(SEPARATOR)) break
      collected.push(line)
    }

    return collected.join('\n').trim()
  }

}