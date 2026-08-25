/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Isolar a execução de processo em módulo puro com responsabilidade única de spawn, timeout e captura de stdout/stderr.
2. Retornar resultado estruturado (stdout, stderr, exitCode) sem lançar exceção para exitCode != 0 — o chamador decide.
3. Implementar timeout obrigatório com default de 120000ms e encerramento forçado do processo filho.
4. Tratar falhas de criação do processo (ex.: comando não encontrado) como erro relançado.

Mapa de Relacionamentos do Script

1. repomix-adapter.ts
   - Tipo: Dependência Inversa
   - Relação: Consome run para executar a CLI do Repomix, delegando spawn, timeout e captura de saída.
   - Criticidade: Alta

Invariantes do Script

1. Nunca lança exceção por exitCode != 0 — sempre resolve com { stdout, stderr, exitCode }.
2. Lança apenas para falhas de criação do processo (command not found, ENOENT) e para timeout.
3. stdout e stderr são sempre retornados (mesmo que vazios).
4. Timeout é obrigatório com default de 120000ms; ao estourar, o processo é morto e a promise rejeita.
5. Em win32 usa shell (necessário para resolução de repomix.cmd); nas demais plataformas spawn direto.
*/

import { spawn } from 'child_process'

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
}

const DEFAULT_TIMEOUT_MS = 120000

/** Executa um processo filho e captura stdout/stderr com timeout obrigatório. */
export class RepomixProcessRunner {
  async run(
    command: string,
    args: string[],
    options: ProcessRunnerOptions
  ): Promise<ProcessRunnerResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: options.cwd,
        shell: process.platform === 'win32'
      })

      let stdout = ''
      let stderr = ''

      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error(`Processo "${command}" excedeu o timeout de ${timeoutMs / 1000}s.`))
      }, timeoutMs)

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
        resolve({ stdout, stderr, exitCode: code ?? -1 })
      })
    })
  }
}