/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Compartilhar a infraestrutura de processo do Repomix CLI (getCommand, runProcess e checkInstallation) entre os adapters de compressão e de output.
2. Manter a verificação de instalação do Repomix única e acessível a ambos os adapters.

Mapa de Relacionamentos do Script

1. repomix-process-runner.ts
   - Tipo: Dependência Direta
   - Relação: Consome run para executar o spawn da CLI com timeout e captura de stdout/stderr.
   - Criticidade: Alta

2. repomix-adapter.ts
   - Tipo: Dependência Inversa
   - Relação: Estende BaseRepomixAdapter para herdar getCommand, runProcess e checkInstallation.
   - Criticidade: Alta

3. repomix-output-adapter.ts
   - Tipo: Dependência Inversa
   - Relação: Estende BaseRepomixAdapter para herdar getCommand, runProcess e checkInstallation.
   - Criticidade: Alta

Invariantes do Script

1. A classe é abstrata — nunca é instanciada diretamente; apenas herdada pelos adapters.
2. runProcess delega ao RepomixProcessRunner e nunca decide rejeitar por exitCode != 0 — o chamador decide.
3. checkInstallation usa timeout de 10s e nunca lança: retorna false em falha de instalação.
4. Nenhuma lógica de compressão ou output reside nesta classe — apenas infraestrutura de processo.

--- FIM ARQUITETURA DO SCRIPT ---
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
    return this.runner.run(command, args, { cwd: options.cwd, timeoutMs: options.timeoutMs })
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
