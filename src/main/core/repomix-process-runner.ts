/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Isolar a execução de processo em módulo puro com responsabilidade única de spawn, timeout, cancelamento e captura de stdout/stderr.
2. Retornar resultado estruturado (stdout, stderr, exitCode) sem lançar exceção para exitCode != 0 — o chamador decide.
3. Implementar timeout obrigatório com default de 120000ms e encerramento forçado do processo filho.
4. Suportar cancelamento via AbortSignal com encerramento forçado do processo filho e rejeição com GenerationCancelledError.
5. Tratar falhas de criação do processo (ex.: comando não encontrado) como erro relançado.

Mapa de Relacionamentos do Script

1. generation-errors.ts
   - Tipo: Dependência Direta
   - Relação: Importa GenerationCancelledError para rejeitar quando o AbortSignal é disparado.
   - Criticidade: Alta

2. base-repomix-adapter.ts
   - Tipo: Dependência Inversa
   - Relação: Consome run para executar o spawn da CLI com timeout, cancelamento e captura de stdout/stderr.
   - Criticidade: Alta

Invariantes do Script

1. Nunca lança exceção por exitCode != 0 — sempre resolve com { stdout, stderr, exitCode }.
2. Lança apenas para falhas de criação do processo (command not found, ENOENT), timeout e cancelamento via AbortSignal.
3. stdout e stderr são sempre retornados (mesmo que vazios) em resoluções bem-sucedidas.
4. Timeout e cancelamento produzem erros distintos (Error com mensagem de timeout vs GenerationCancelledError).
5. Nenhum listener no AbortSignal permanece registrado após a conclusão da promise (sucesso, erro, timeout ou cancelamento).
6. Se o signal já estiver abortado antes do spawn, a promise rejeita imediatamente com GenerationCancelledError sem iniciar processo.
7. Em win32 usa shell (necessário para resolução de repomix.cmd); nas demais plataformas spawn direto.

--- FIM ARQUITETURA DO SCRIPT ---
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

      const proc = spawn(command, args, {
        cwd: options.cwd,
        shell: process.platform === 'win32'
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