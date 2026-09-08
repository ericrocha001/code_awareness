/*
-T ---
*/

import { spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

const GIT_TIMEOUT_MS = 5000

/**
 * Executa um comando `git` dentro do repositório e retorna o stdout.
 * Lança erro se o código de saída não for o esperado (0, ou 0/1 quando `allowExitOne`).
 */
export async function gitExec(
  repoPath: string,
  args: string[],
  options: { allowExitOne?: boolean } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    const proc = spawn('git', args, { cwd: repoPath, shell: false })

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`git timeout após ${GIT_TIMEOUT_MS}ms: git ${args.join(' ')}`))
    }, GIT_TIMEOUT_MS)

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      clearTimeout(timer)
      const ok = code === 0 || (options.allowExitOne && code === 1)
      if (ok) resolve(stdout)
      else reject(new Error(stderr.trim() || `git ${args.join(' ')} exited com código ${code}`))
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * Cria um repositório Git temporário único, inicializado e com identidade local configurada.
 * Retorna o caminho absoluto do repositório.
 */
export async function createTempGitRepo(): Promise<string> {
  const repoPath = mkdtempSync(join(tmpdir(), 'git_test_'))
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
 * Remove o repositório temporário inteiro.
 * BUGFIX Windows: loop de retry para tolerar lock do filesystem (WAL/antivírus),
 * no mesmo padrão de cleanupTestDir de test-helpers.ts. Nunca lança exceção.
 */
export async function cleanupTempRepo(repoPath: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (existsSync(repoPath)) {
        rmSync(repoPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
      }
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  // Último esforço silencioso para não abortar os demais testes
  console.warn(`[git-test-helpers] cleanupTempRepo falhou após 4 tentativas: ${repoPath}`)
}