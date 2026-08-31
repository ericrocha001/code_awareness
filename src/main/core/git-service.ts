/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Verificar se um diretório representa um repositório Git válido.
2. Executar comandos nativos do Git e capturar suas saídas de forma assíncrona.
3. Obter a lista de todos os arquivos rastreados (tracked) e não rastreados (untracked) do repositório (getAllFiles).
4. Obter a lista de arquivos modificados (staged, unstaged e untracked individuais) do repositório.
5. Extrair os hunks de alteração (intervalos de linhas modificadas) de um arquivo específico.
6. Recuperar o conteúdo de um arquivo no estado do commit HEAD.
7. Obter o hash do commit HEAD atual do repositório.
8. Listar caminhos relativos de todos os arquivos para a interface segregada FileListingPort.

Mapa de Relacionamentos do Script

1. src/main/ipc/git-handler.ts
   - Tipo: Dependência Inversa
   - Relação: Expõe as funcionalidades de Git por meio de handlers IPC para a interface gráfica.
   - Criticidade: Alta

2. src/main/core/diff-service.ts
   - Tipo: Dependência Inversa
   - Relação: Fornece informações de arquivos modificados e hunks para a lógica de diff semântico.
   - Criticidade: Alta

3. src/main/core/checkpoint-service.ts
   - Tipo: Dependência Inversa
   - Relação: Fornece o hash do commit HEAD para validação de integridade nos checkpoints.
   - Criticidade: Média

4. src/shared/types.ts
   - Tipo: Contrato / Interface
   - Relação: Retorna estruturas de dados que devem obedecer às interfaces declaradas nos tipos do projeto.
   - Criticidade: Alta

5. src/main/core/file-listing-port.ts
   - Tipo: Contrato / Interface
   - Relação: GitService implementa FileListingPort como contrato mínimo de listagem.
   - Criticidade: Alta

Invariantes do Script

1. O método de listagem de arquivos rastreados deve retornar a propriedade changeType sempre definida como 'tracked'.
2. Métodos de listagem de arquivos não devem expor caminhos pertencentes às pastas de infraestrutura interna (como code_awareness, codefetch, .sprintdiff, code_checkpoints).
3. Todas as chamadas aos comandos nativos do Git devem possuir um limite de tempo máximo (timeout) para evitar travamentos de processos.
4. Em caso de erro na execução dos comandos Git, os métodos públicos devem retornar estruturas vazias ou nulas ao invés de propagar exceções para o chamador.
5. `getAllFiles` continua excluindo arquivos ausentes do filesystem. `getModifiedFiles` expõe os arquivos deletados reportados pelo Git com `changeType: 'deleted'` e metadados zerados (mtime e size), para que o diff semântico possa representá-los.
6. Em caso de falha ao ler o mtime de um arquivo existente (statSync), o método deve usar Date.now() como fallback para garantir ordenação por recência consistente.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { DiffFileStatus } from '../../shared/types'
import { FileListingPort } from './file-listing-port'


const GIT_TIMEOUT_MS = 10_000

// Pastas internas que devem ser ignoradas em todas as listagens de arquivos
const INTERNAL_FOLDERS = [
  'code_awareness',
  'codefetch',
  '.sprintdiff',
  'code_checkpoints'
]

function isInternalPath(path: string): boolean {
  return INTERNAL_FOLDERS.some(folder =>
    path === folder || path.startsWith(`${folder}/`)
  )
}

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

export class GitService implements FileListingPort {
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
        this.runGit(['-c', 'core.quotePath=false', 'status', '--porcelain'], dirPath),
        // ls-files lista cada arquivo untracked individualmente (nunca agrupa diretórios)
        // --exclude-standard respeita o .gitignore do projeto
        this.runGit(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'], dirPath)
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
        // Usa a função compartilhada para ignorar pastas internas
        .filter(p => !isInternalPath(p))
        // Ignora arquivos já presentes no git status (ex: staged untracked via 'A')
        .filter(p => !statusPaths.has(p))
        .map(relativePath => {
          const fullPath = join(dirPath, relativePath)
          if (!existsSync(fullPath)) {
            console.debug(`[GitService] Arquivo deletado ignorado (untracked): ${relativePath}`)
            return null
          }
          return {
            relativePath,
            name: relativePath.split('/').pop() ?? relativePath,
            changeType: 'added' as DiffFileStatus['changeType'],
            mtime: 0,
            size: 0
          }
        })
        .filter((f): f is DiffFileStatus => f !== null)

      // Merge e enriquecimento com mtime/size via statSync
      const allFiles = [...statusFiles, ...untrackedFiles]
      return allFiles
        .map(f => {
          const fullPath = join(dirPath, f.relativePath)
          if (!existsSync(fullPath)) {
            // Arquivos deletados reportados pelo Git são expostos com metadados
            // zerados (mtime/size) para o diff semântico representar a deleção.
            // Demais casos (corrida transitória) continuam descartados.
            if (f.changeType === 'deleted') {
              return { ...f, mtime: 0, size: 0 }
            }
            console.debug(`[GitService] Arquivo deletado ignorado: ${f.relativePath}`)
            return null
          }
          try {
            const st = statSync(fullPath)
            return { ...f, mtime: st.mtimeMs, size: st.size }
          } catch {
            // Fallback: se não conseguir ler o mtime (permissão, etc.),
            // usa Date.now() para tratar como recente na ordenação por recência
            console.warn(`[GitService] Falha ao ler mtime de ${f.relativePath}, usando fallback`)
            return { ...f, mtime: Date.now(), size: 0 }
          }
        })
        .filter((f): f is DiffFileStatus => f !== null)
        .sort((a, b) => b.mtime - a.mtime)
    } catch {
      return []
    }
  }

  async getAllFiles(dirPath: string): Promise<DiffFileStatus[]> {
    try {
      // Executa os dois comandos Git em paralelo (tracked + untracked)
      const [trackedOutput, untrackedOutput] = await Promise.all([
        this.runGit(['-c', 'core.quotePath=false', 'ls-files'], dirPath),
        this.runGit(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'], dirPath)
      ])

      // Filtra e normaliza os arquivos tracked
      const trackedPaths = trackedOutput
        .split('\n')
        .map(line => line.trim())
        .filter(p => p.length > 0 && !p.endsWith('/'))
        .filter(p => !isInternalPath(p))

      const pathSet = new Set(trackedPaths)

      // Filtra e normaliza os arquivos untracked, evitando duplicatas com os tracked
      const untrackedPaths = untrackedOutput
        .split('\n')
        .map(line => line.trim())
        .filter(p => p.length > 0 && !p.endsWith('/'))
        .filter(p => !isInternalPath(p))
        .filter(p => !pathSet.has(p))

      // Une as duas listas e mapeia os status para o formato DiffFileStatus
      // Filtra arquivos que não existem mais no filesystem (deletados mas ainda no índice git)
      const allPaths = [...trackedPaths, ...untrackedPaths]
      const files: DiffFileStatus[] = []
      for (const relativePath of allPaths) {
        const fullPath = join(dirPath, relativePath)
        if (!existsSync(fullPath)) {
          // Arquivo deletado do disco mas ainda presente no índice git — exclui da listagem
          console.debug(`[GitService] Arquivo deletado ignorado: ${relativePath}`)
          continue
        }
        let mtime = 0
        let size = 0
        try {
          const st = statSync(fullPath)
          mtime = st.mtimeMs
          size = st.size
        } catch {
          // Fallback: se não conseguir ler o mtime, usa Date.now() para tratar como recente
          console.warn(`[GitService] Falha ao ler mtime de ${relativePath}, usando fallback`)
          mtime = Date.now()
        }
        files.push({
          relativePath,
          name: relativePath.split('/').pop() ?? relativePath,
          changeType: 'tracked',
          mtime,
          size
        })
      }

      // Ordena por mtime descendente para priorizar arquivos alterados recentemente
      return files.sort((a, b) => b.mtime - a.mtime)
    } catch {
      return []
    }
  }

  async listAllFiles(repoPath: string): Promise<Array<{ relativePath: string }>> {
    const files = await this.getAllFiles(repoPath)
    return files.map(f => ({ relativePath: f.relativePath }))
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

  /**
   * Obtém o hash do commit HEAD atual do repositório.
   *
   * @param dirPath Caminho absoluto para a raiz do repositório.
   * @returns Hash completo do HEAD atual ou null se não for possível obter.
   */
  async getCurrentCommitHash(dirPath: string): Promise<string | null> {
    try {
      const stdout = await this.runGit(['rev-parse', 'HEAD'], dirPath)
      return stdout.trim() || null
    } catch {
      // Repositório sem commits ou erro ao executar git rev-parse
      return null
    }
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
        
        if (isInternalPath(relativePath)) return null
        
        const code = line.substring(0, 2).trim()
        const changeType = GIT_STATUS_CODE_MAP[code[0]] ?? 'modified'
        return { relativePath, name, changeType, mtime: 0, size: 0 }
      })
      .filter((item): item is DiffFileStatus => item !== null)
  }
}