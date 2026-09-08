/*
-T ---
*/

import { spawn } from 'child_process'
import { GenerationCancelledError } from './generation-errors'

export interface ProcessRunnerResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface ProcessRunnerOptions {
  /**
   * Timeout em milissegundos. Default: 120000ms (2 minutos).
   * Ao estourar, o processo é morto e a promise rejeita.
   */
  timeoutMs?: number
  cwd: string
  /**
   * Signal opcional para cancelamento da execução.
   * Ao abortar, o processo é encerrado e a promise rejeita com GenerationCancelledError.
   */
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 120000

/** Executa um processo filho e captura stdout/stderr com timeout obrigatório e cancelamento opcional. */
export class RepomixProcessRunner {
  async run(
    command: string,
    args: string[],
    options: ProcessRunnerOptions
  ): Promise<ProcessRunnerResult> {
    if (options.signal?.aborted) {
      throw new GenerationCancelledError()
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise((resolve, reject) => {
      let isSettled = false

      // BUGFIX Windows: com shell:true (necessário para resolver repomix.cmd), os
      // argumentos são concatenados em uma única linha de comando pelo cmd.exe.
      // Sem aspas, espaços e metacaracteres do cmd (`&`, `^`, `(`, `)`) em nomes de
      // arquivo corrompem o comando (ex.: "weird & file.ts" virava dois comandos).
      // A solução é construir a linha de comando completa com cada argumento
      // perigosamente entre aspas duplas — dentro de aspas o cmd trata os
      // metacaracteres como literais. Aspas duplas em si são inválidas em nomes de
      // arquivo no Windows, então não há necessidade de escaping interno.
      const shellRequired = process.platform === 'win32'
      const quoteIfNeeded = (arg: string): string =>
        /[\s&()^|<>"=;,!%]/.test(arg) ? `"${arg}"` : arg

      const spawnCommand = shellRequired
        ? [command, ...args.map(quoteIfNeeded)].join(' ')
        : command

      const proc = spawn(spawnCommand, shellRequired ? [] : args, {
        cwd: options.cwd,
        shell: shellRequired
      })

      let stdout = ''
      let stderr = ''

      const cleanup = () => {
        clearTimeout(timer)
        if (options.signal) {
          options.signal.removeEventListener('abort', abortListener)
        }
      }

      const abortListener = () => {
        if (isSettled) return
        isSettled = true
        cleanup()
        try {
          proc.kill()
        } catch {
          // Ignora falhas caso o processo já tenha encerrado
        }
        reject(new GenerationCancelledError())
      }

      if (options.signal) {
        options.signal.addEventListener('abort', abortListener, { once: true })
      }

      const timer = setTimeout(() => {
        if (isSettled) return
        isSettled = true
        cleanup()
        try {
          proc.kill()
        } catch {
          // Ignora falhas ao matar processo
        }
        reject(new Error(`Processo "${command}" excedeu o timeout de ${timeoutMs / 1000}s.`))
      }, timeoutMs)

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      proc.on('error', (err) => {
        if (isSettled) return
        isSettled = true
        cleanup()
        reject(err)
      })

      proc.on('close', (code) => {
        if (isSettled) return
        isSettled = true
        cleanup()
        resolve({ stdout, stderr, exitCode: code ?? -1 })
      })
    })
  }
}