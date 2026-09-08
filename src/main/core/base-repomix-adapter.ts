/*
-T ---
*/

import { RepomixProcessRunner } from './repomix-process-runner'

export interface RunProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunProcessOptions {
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
}

export abstract class BaseRepomixAdapter {
  /** Runner de processo injetável — permite testar o adapter sem invocar a CLI real. */
  protected readonly runner: RepomixProcessRunner

  constructor(runner: RepomixProcessRunner = new RepomixProcessRunner()) {
    this.runner = runner
  }

  protected getCommand(): string {
    return process.platform === 'win32' ? 'repomix.cmd' : 'repomix'
  }

  /**
   * Executa um comando Repomix via runner, retornando exitCode/stdout/stderr sem lançar.
   *
   * NOTA (R2 Sprint 8): a Sprint 8 especificava `runProcess(command, args, cwd, timeoutMs): Promise<string>`,
   * mas a implementação retorna `{ exitCode, stdout, stderr }` porque os chamadores reais
   * (compressSingleFile, compressMultipleFiles) precisam de exitCode para retry/fallback
   * e stderr para logging diagnóstico. Retornar apenas string exigiria lançar exceções
   * para exitCode != 0, complicando o tratamento de erros parciais em batch.
   */
  protected runProcess(command: string, args: string[], options: RunProcessOptions): Promise<RunProcessResult> {
    return this.runner.run(command, args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal
    })
  }

  /** Verifica se o Repomix está instalado e acessível no sistema. */
  async checkInstallation(): Promise<boolean> {
    try {
      const res = await this.runProcess(this.getCommand(), ['--version'], {
        cwd: process.cwd(),
        timeoutMs: 10000
      })
      return res.exitCode === 0
    } catch {
      return false
    }
  }
}
