// Responsabilidades do Script
//
// 1. Verificar se um diretório é um repositório Git válido.
// 2. Obter a lista de arquivos modificados (staged, unstaged e untracked individuais) via comandos nativos do Git.
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
      // Executa os dois comandos em paralelo para performance
      const [statusOutput, untrackedOutput] = await Promise.all([
        this.runGit(['status', '--porcelain'], dirPath),
        // ls-files lista cada arquivo untracked individualmente (nunca agrupa diretórios)
        // --exclude-standard respeita o .gitignore do projeto
        this.runGit(['ls-files', '--others', '--exclude-standard'], dirPath)
      ])

      // Arquivos M/A/D do git status (modified, staged, deleted)
      const statusFiles = this.parseGitStatus(statusOutput)

      // Caminhos já cobertos pelo git status (evita duplicatas)
      const statusPaths = new Set(statusFiles.map(f => f.relativePath))

      // Arquivos untracked individuais vindos do ls-files
      const untrackedFiles: DiffFileStatus[] = untrackedOutput
        .split('\n')
        .map(line => line.trim())
        // Ignora linhas vazias ou caminhos que terminam em '/' (defesa em profundidade)
        .filter(p => p.length > 0 && !p.endsWith('/'))
        // Ignora pastas internas do code_awareness que não devem aparecer
        .filter(p =>
          p !== 'code_awareness' && !p.startsWith('code_awareness/') &&
          p !== 'codefetch'     && !p.startsWith('codefetch/')     &&
          p !== '.sprintdiff'   && !p.startsWith('.sprintdiff/')
        )
        // Ignora arquivos já presentes no git status (ex: staged untracked via 'A')
        .filter(p => !statusPaths.has(p))
        .map(relativePath => ({
          relativePath,
          name: relativePath.split('/').pop() ?? relativePath,
          changeType: 'added' as DiffFileStatus['changeType'],
          mtime: 0,
          size: 0
        }))

      // Merge e enriquecimento com mtime/size via statSync
      const allFiles = [...statusFiles, ...untrackedFiles]
      return allFiles
        .map(f => {
          try {
            const st = statSync(join(dirPath, f.relativePath))
            return { ...f, mtime: st.mtimeMs, size: st.size }
          } catch {
            return { ...f, mtime: 0, size: 0 }
          }
        })
        .sort((a, b) => b.mtime - a.mtime)
    } catch {
      return []
    }
  }

  async getAllTrackedFiles(dirPath: string): Promise<DiffFileStatus[]> {
    try {
      const stdout = await this.runGit(['ls-files'], dirPath)
      const files: DiffFileStatus[] = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(p => p.length > 0 && !p.endsWith('/'))
        .filter(p =>
          p !== 'code_awareness' && !p.startsWith('code_awareness/') &&
          p !== 'codefetch'     && !p.startsWith('codefetch/')     &&
          p !== '.sprintdiff'   && !p.startsWith('.sprintdiff/')
        )
        .map(relativePath => {
          let mtime = 0
          let size = 0
          try {
            const st = statSync(join(dirPath, relativePath))
            mtime = st.mtimeMs
            size = st.size
          } catch {
            // keep 0
          }
          return {
            relativePath,
            name: relativePath.split('/').pop() ?? relativePath,
            changeType: 'tracked',
            mtime,
            size
          }
        })

      return files.sort((a, b) => b.mtime - a.mtime)
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
        return { relativePath, name, changeType, mtime: 0, size: 0 }
      })
      .filter((item): item is DiffFileStatus => item !== null)
  }
}
