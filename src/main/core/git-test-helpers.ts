/*
-T ---
*/

import { execFile, spawn } from 'node:child_process'
import { mkdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  acquireFixtureProcessGuard,
  createOwnedSubdir,
  createOwnedTempDir,
  registerOwnedTempDir,
  releaseFixtureProcessGuard,
  safeCleanupTempDir,
  type CleanupOptions,
  type CleanupResult
} from './temp-cleanup'

const GIT_TIMEOUT_MS = 5000
const GIT_TERMINATION_WAIT_MS = 2000

export type { CleanupOptions, CleanupResult }

export interface GitExecError extends Error {
  timedOut?: boolean
  cancelled?: boolean
  terminatedConfirmed?: boolean
}

export type TreeTerminationProbe = (
  pid: number,
  waitMs: number
) => Promise<{ confirmed: boolean; reason?: string }>

async function defaultTerminateProcessTree(
  pid: number,
  waitMs: number
): Promise<{ confirmed: boolean; reason?: string }> {
  if (process.platform === 'win32') {
    return new Promise(resolveTerm => {
      execFile(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, timeout: Math.max(GIT_TERMINATION_WAIT_MS, waitMs) },
        (err, _stdout, stderr) => {
          if (!err) {
            resolveTerm({ confirmed: true })
            return
          }
          resolveTerm({
            confirmed: false,
            reason: stderr.trim() || err.message
          })
        }
      )
    })
  }

  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code !== 'ESRCH') {
      return { confirmed: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  const deadline = Date.now() + Math.max(50, waitMs)
  while (Date.now() <= deadline) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') {
        return { confirmed: true }
      }
      return { confirmed: false, reason: error instanceof Error ? error.message : String(error) }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  return { confirmed: false, reason: 'Process group still active after termination budget' }
}

/**
 * Executa um comando `git` dentro do repositório e retorna o stdout.
 * Lança erro se o código de saída não for o esperado (0, ou 0/1 quando `allowExitOne`).
 * Em timeout ou cancelamento, confirma encerramento do processo líder e da árvore de descendentes
 * antes de liberar a fixture para cleanup; em incerteza, rejeita com `terminatedConfirmed = false`
 * mantendo proteção em memória da fixture até confirmação real.
 */
export async function gitExec(
  repoPath: string,
  args: string[],
  options: {
    allowExitOne?: boolean
    timeoutMs?: number
    terminationWaitMs?: number
    signal?: AbortSignal
    terminateTree?: TreeTerminationProbe
  } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
  const terminationWaitMs = options.terminationWaitMs ?? GIT_TERMINATION_WAIT_MS
  const terminateTree = options.terminateTree ?? defaultTerminateProcessTree

  if (options.signal?.aborted) {
    const err: GitExecError = new Error(`git cancelado antes de iniciar (encerramento confirmado): git ${args.join(' ')}`)
    err.cancelled = true
    err.terminatedConfirmed = true
    throw err
  }

  const guard = acquireFixtureProcessGuard(repoPath)

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let abortKind: 'timeout' | 'cancelled' | null = null
    let leaderClosed = false
    let treeState: 'NONE' | 'PENDING' | 'CONFIRMED' | 'FAILED' = 'NONE'
    let treeFailureReason: string | undefined
    let killWaitTimer: NodeJS.Timeout | undefined

    const buildAbortError = (kind: 'timeout' | 'cancelled', confirmed: boolean, detail?: string): GitExecError => {
      const prefix = kind === 'timeout' ? `git timeout após ${timeoutMs}ms` : 'git cancelado'
      const statusText = confirmed
        ? '(encerramento confirmado)'
        : `(término não confirmado — processo ainda ativo${detail ? `: ${detail}` : ''})`
      const err: GitExecError = new Error(`${prefix} ${statusText}: git ${args.join(' ')}`)
      err.timedOut = kind === 'timeout'
      err.cancelled = kind === 'cancelled'
      err.terminatedConfirmed = confirmed
      return err
    }

    const finish = (err: Error | null, output?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killWaitTimer) clearTimeout(killWaitTimer)
      options.signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve(output ?? '')
    }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn('git', args, {
        cwd: repoPath,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32'
      })
    } catch (spawnError) {
      releaseFixtureProcessGuard(guard)
      const err = (spawnError instanceof Error ? spawnError : new Error(String(spawnError))) as GitExecError
      err.terminatedConfirmed = true
      reject(err)
      return
    }

    const tryResolveAbortConfirmation = () => {
      if (!abortKind) return
      if (leaderClosed && treeState === 'CONFIRMED') {
        releaseFixtureProcessGuard(guard)
        if (!settled) {
          finish(buildAbortError(abortKind, true))
        }
        return
      }
      if (!settled && treeState === 'FAILED') {
        // Mantém guard ativo enquanto o término da árvore permanecer incerto.
        try { proc.unref() } catch {}
        finish(buildAbortError(abortKind, false, treeFailureReason))
      }
    }

    const requestTermination = (kind: 'timeout' | 'cancelled') => {
      if (settled || abortKind) return
      abortKind = kind
      const pid = proc.pid
      if (!pid) {
        // Falha de spawn sem PID efetivo é confirmável após error/ausência de processo; nunca via proc.killed.
        treeState = 'FAILED'
        treeFailureReason = 'PID ausente ao solicitar encerramento'
        finish(buildAbortError(kind, false, treeFailureReason))
        return
      }

      treeState = 'PENDING'
      void terminateTree(pid, terminationWaitMs).then(
        result => {
          if (result.confirmed) {
            treeState = 'CONFIRMED'
          } else {
            treeState = 'FAILED'
            treeFailureReason = result.reason
          }
          tryResolveAbortConfirmation()
        },
        err => {
          treeState = 'FAILED'
          treeFailureReason = err instanceof Error ? err.message : String(err)
          tryResolveAbortConfirmation()
        }
      )

      killWaitTimer = setTimeout(() => {
        if (settled) return
        // Não declarar encerramento por envio de sinal/unref/destruição de streams; manter guard ativo até confirmação real.
        try { proc.unref() } catch {}
        finish(buildAbortError(kind, false))
      }, terminationWaitMs)
    }

    const onAbort = () => requestTermination('cancelled')
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => requestTermination('timeout'), timeoutMs)

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      leaderClosed = true
      if (abortKind) {
        tryResolveAbortConfirmation()
        return
      }
      releaseFixtureProcessGuard(guard)
      const ok = code === 0 || (options.allowExitOne && code === 1)
      if (ok) finish(null, stdout)
      else finish(new Error(stderr.trim() || `git ${args.join(' ')} exited com código ${code}`))
    })

    proc.on('error', (err) => {
      const e = err as GitExecError
      if (!proc.pid) {
        // Spawn falhou antes de criar processo no SO: não há processo ativo na fixture.
        releaseFixtureProcessGuard(guard)
        if (abortKind) {
          e.timedOut = abortKind === 'timeout'
          e.cancelled = abortKind === 'cancelled'
        }
        e.terminatedConfirmed = true
        finish(e)
        return
      }
      // Processo já existia: nunca marcar terminatedConfirmed por proc.killed; manter fixture protegida salvo confirmação real.
      if (abortKind) {
        e.timedOut = abortKind === 'timeout'
        e.cancelled = abortKind === 'cancelled'
        e.terminatedConfirmed = leaderClosed && treeState === 'CONFIRMED'
        if (e.terminatedConfirmed) releaseFixtureProcessGuard(guard)
      } else {
        e.terminatedConfirmed = false
      }
      finish(e)
    })
  })
}

/** Cria um diretório temporário rastreado sob identidade própria do helper. */
export function createTempDir(prefix = 'git_test_'): string {
  return createOwnedTempDir(prefix)
}

/** Registra explicitamente subdiretório criado dentro de fixture já possuída pelo harness. */
export function registerTempDir(dirPath: string, ownerFixturePath: string): string {
  return registerOwnedTempDir(dirPath, ownerFixturePath)
}

/**
 * Cria um repositório Git temporário único, inicializado e com identidade local configurada.
 * Retorna o caminho absoluto do repositório.
 */
export async function createTempGitRepo(): Promise<string> {
  const repoPath = createOwnedTempDir('git_test_')
  await gitExec(repoPath, ['init'])
  await gitExec(repoPath, ['config', 'user.name', 'Test'])
  await gitExec(repoPath, ['config', 'user.email', 'test@example.com'])
  // Caminhos UTF-8 determinísticos: evita o escape octal do porcelain padrão (core.quotePath true).
  await gitExec(repoPath, ['config', 'core.quotePath', 'false'])
  return repoPath
}

/** Cria um clone local isolado sem hard links no `.git/objects` entre origem e fixture de destino. */
export async function cloneTempGitRepoIsolated(sourceRepoPath: string, parentFixturePath: string, name: string): Promise<string> {
  const targetPath = createOwnedSubdir(parentFixturePath, name)
  await gitExec(parentFixturePath, ['clone', '--no-hardlinks', sourceRepoPath, targetPath])
  await gitExec(targetPath, ['config', 'user.name', 'Test'])
  await gitExec(targetPath, ['config', 'user.email', 'test@example.com'])
  return targetPath
}

/** Grava um arquivo no repo, criando os diretórios intermediários se necessário. */
export function writeFile(repoPath: string, relativePath: string, content: string): void {
  const fullPath = join(repoPath, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
}

/** Remove um arquivo do repo; silencioso se já não existir. */
export function deleteFile(repoPath: string, relativePath: string): void {
  const fullPath = join(repoPath, relativePath)
  try {
    unlinkSync(fullPath)
  } catch {
    /* silencioso — arquivo já ausente */
  }
}

/** Executa `git add -A` no repositório. */
export async function stageAll(repoPath: string): Promise<void> {
  await gitExec(repoPath, ['add', '-A'])
}

/** Executa `git commit -m <message>` no repositório. */
export async function commit(repoPath: string, message: string): Promise<void> {
  await gitExec(repoPath, ['commit', '-m', message])
}

/** Atualiza o mtime de um arquivo sem alterar seu conteúdo. */
export function touch(repoPath: string, relativePath: string, mtime: number = Date.now()): void {
  const fullPath = join(repoPath, relativePath)
  utimesSync(fullPath, mtime, mtime)
}

/**
 * Remove o repositório temporário possuído pelo helper com tratamento seguro de atributos
 * read-only do `.git` no Windows, limites de tentativa/tempo e preservação da falha original do teste.
 */
export async function cleanupTempRepo(repoPath: string, options: CleanupOptions = {}): Promise<void> {
  await safeCleanupTempDir(repoPath, options)
}
