// Responsabilidades do Script
//
// 1. Verificar se um diretório é um repositório Git válido.
// 2. Obter a lista de arquivos modificados (staged e unstaged) via comandos nativos do Git.
// 3. Extrair os hunks de alteração de um arquivo específico para mapeamento de linhas.
// 4. Ler o conteúdo de um arquivo no estado do commit HEAD anterior.

import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { DiffFileStatus } from '../../shared/types'

const GIT_TIMEOUT_MS = 10_000

export interface DiffHunk {
  oldStart: number
  oldCount: number
  start: number // primeira linha modificada no novo arquivo (1-indexed)
  count: number // quantidade de linhas afetadas
}

const GIT_STATUS_CODE_MAP: Record<string, DiffFileStatus['changeType']> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  '?': 'added'
}

export class GitService {
  async isGitRepository(dirPath: string): Promise<boolean> {
    return existsSync(join(dirPath, '.git'))
  }

  private runGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const proc = spawn('git', args, { cwd, shell: false })

      // Timeout de proteção contra processos Git travados
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('Git process timed out'))
      }, GIT_TIMEOUT_MS)

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout)
        else reject(new Error(stderr.trim() || `git exited with code ${code}`))
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  async getModifiedFiles(dirPath: string): Promise<DiffFileStatus[]> {
    try {
      const stdout = await this.runGit(['status', '--porcelain'], dirPath)
      const files = this.parseGitStatus(stdout)
      return files
        .map(f => {
          try {
            const st = statSync(join(dirPath, f.relativePath))
            return { ...f, mtime: st.mtimeMs }
          } catch {
            return { ...f, mtime: 0 }
          }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .map(({ mtime, ...f }) => f)
    } catch {
      return []
    }
  }

  async getModifiedHunks(dirPath: string, relativePath: string): Promise<DiffHunk[]> {
    try {
      const stdout = await this.runGit(['diff', 'HEAD', '-U0', '--', relativePath], dirPath)
      return this.parseHunks(stdout)
    } catch {
      return []
    }
  }

  async getFileAtHead(dirPath: string, relativePath: string): Promise<string | null> {
    try {
      const stdout = await this.runGit(['show', `HEAD:${relativePath}`], dirPath)
      return stdout
    } catch {
      return null
    }
  }

  private parseHunks(diffOutput: string): DiffHunk[] {
    const pattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
    const hunks: DiffHunk[] = []

    for (const match of diffOutput.matchAll(pattern)) {
      const oldStart = parseInt(match[1])
      const oldCount = match[2] !== undefined ? parseInt(match[2]) : 1
      const start = parseInt(match[3])
      const count = match[4] !== undefined ? parseInt(match[4]) : 1
      hunks.push({ oldStart, oldCount, start, count })
    }

    return hunks
  }

  private parseGitStatus(output: string): DiffFileStatus[] {
    return output
      .split('\n')
      .map(line => {
        if (line.trim().length === 0) return null
        
        let relativePath = line.substring(3).trim()
        
        // Handle git renames (e.g., 'old_path -> new_path')
        if (relativePath.includes(' -> ')) {
          relativePath = relativePath.split(' -> ').pop()!.trim()
        }
        
        // Remove surrounding quotes if git porcelain added them
        if (relativePath.startsWith('"') && relativePath.endsWith('"')) {
          relativePath = relativePath.substring(1, relativePath.length - 1)
        }
        
        if (!relativePath || relativePath.endsWith('/')) return null
        const name = relativePath.split('/').pop() ?? relativePath
        if (!name) return null
        
        if (relativePath === 'code_awareness' || relativePath.startsWith('code_awareness/')) return null
        if (relativePath === 'codefetch' || relativePath.startsWith('codefetch/')) return null
        if (relativePath === '.sprintdiff' || relativePath.startsWith('.sprintdiff/')) return null
        
        const code = line.substring(0, 2).trim()
        const changeType = GIT_STATUS_CODE_MAP[code[0]] ?? 'modified'
        return { relativePath, name, changeType }
      })
      .filter((item): item is DiffFileStatus => item !== null)
  }
}
