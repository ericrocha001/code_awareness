// Responsabilidades do Script
//
// 1. Detectar e executar o Repomix CLI no sistema operacional do usuário.
// 2. Comprimir um único arquivo do repositório via --include, retornando apenas o
//    bloco de código comprimido limpo, sem cabeçalhos ou rodapés de boilerplate.

import { spawn } from 'child_process'

export class RepomixAdapter {
  private getCommand(): string {
    return process.platform === 'win32' ? 'repomix.cmd' : 'repomix'
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
   * Executa o processo filho e retorna stdout como string.
   * Rejeita se o processo sair com código diferente de 0.
   */
  private runProcess(command: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd,
        shell: process.platform === 'win32'
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on('close', (code) => {
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