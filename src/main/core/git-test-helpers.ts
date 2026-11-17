/*
-T ---
*/

import { execFile, spawn } from 'node:child_process'
import { mkdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  createOwnedTempDir,
  registerOwnedTempDir,
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

function terminateChildTree(pid: number, fallbackKill: () => void): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, err => {
      if (err) {
        try { fallbackKill() } catch {}
      }
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { fallbackKill() } catch {}
  }
}

/**
 * Executa um comando `git` dentro do repositório e retorna o stdout.
 * Lança erro se o código de saída não for o esperado (0, ou 0/1 quando `allowExitOne`).
 * Em timeout ou cancelamento, aguarda confirmação de encerramento (`close`) antes de rejeitar
 * para não liberar `cleanupTempRepo` sobre processo próprio ainda ativo.
 */
export async function gitExec(
  repoPath: string,
  args: string[],
  options: { allowExitOne?: boolean; timeoutMs?: number; terminationWaitMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
  const terminationWaitMs = options.terminationWaitMs ?? GIT_TERMINATION_WAIT_MS
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let abortKind: 'timeout' | 'cancelled' | null = null
    let killWaitTimer: NodeJS.Timeout | undefined

    const finish = (err: Error | null, output?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killWaitTimer) clearTimeout(killWaitTimer)
      options.signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve(output ?? '')
    }

    if (options.signal?.aborted) {
      const err: GitExecError = new Error(`git cancelado antes de iniciar (encerramento confirmado): git ${args.join(' ')}`)
      err.cancelled = true
      err.terminatedConfirmed = true
      reject(err)
      return
    }

    const proc = spawn('git', args, {
      cwd: repoPath,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32'
    })

    const requestTermination = (kind: 'timeout' | 'cancelled') => {
      if (settled || abortKind) return
      abortKind = kind
      const reasonPrefix = kind === 'timeout'
        ? `git timeout após ${timeoutMs}ms`
        : 'git cancelado'
      const pid = proc.pid
      if (pid) terminateChildTree(pid, () => proc.kill('SIGKILL'))
      else try { proc.kill('SIGKILL') } catch {}

      killWaitTimer = setTimeout(() => {
        // Não assumir encerramento só porque kill() retornou; sinalizar explicitamente ausência de close.
        try { proc.unref() } catch {}
        proc.stdout?.destroy()
        proc.stderr?.destroy()
        const err: GitExecError = new Error(`${reasonPrefix} (término não confirmado — processo ainda ativo): git ${args.join(' ')}`)
        err.timedOut = kind === 'timeout'
        err.cancelled = kind === 'cancelled'
        err.terminatedConfirmed = false
        finish(err)
      }, terminationWaitMs)
    }

    const onAbort = () => requestTermination('cancelled')
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => requestTermination('timeout'), timeoutMs)

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      if (abortKind) {
        const prefix = abortKind === 'timeout' ? `git timeout após ${timeoutMs}ms` : 'git cancelado'
        const err: GitExecError = new Error(`${prefix} (encerramento confirmado): git ${args.join(' ')}`)
        err.timedOut = abortKind === 'timeout'
        err.cancelled = abortKind === 'cancelled'
        err.terminatedConfirmed = true
        finish(err)
        return
      }
      const ok = code === 0 || (options.allowExitOne && code === 1)
      if (ok) finish(null, stdout)
      else finish(new Error(stderr.trim() || `git ${args.join(' ')} exited com código ${code}`))
    })

    proc.on('error', (err) => {
      if (abortKind) {
        const e = err as GitExecError
        e.timedOut = abortKind === 'timeout'
        e.cancelled = abortKind === 'cancelled'
        e.terminatedConfirmed = proc.exitCode !== null || proc.killed
        finish(e)
        return
      }
      finish(err)
    })
  })
}

/** Cria um diretório temporário rastreado sob identidade própria do helper. */
export function createTempDir(prefix = 'git_test_'): string {
  return createOwnedTempDir(prefix)
}

/** Registra explicitamente um diretório temporário para remoção segura. */
export function registerTempDir(dirPath: string): string {
  return registerOwnedTempDir(dirPath)
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
