/*
--- ARQUITETURA DO SCRIPT ---

Responsabilidades do Script

1. Escanear o repositório e localizar arquivos candidatos à indexação.
2. Filtrar arquivos ignorados pelo .gitignore do projeto.
3. Filtrar pastas internas (node_modules, .git, dist, build, code_awareness, code_checkpoints).
4. Filtrar arquivos binários e arquivos maiores que 2MB.
5. Detectar linguagem com base na extensão do arquivo.
6. Retornar metadados básicos (caminho relativo, extensão, linguagem, tamanho, mtime).

Mapa de Relacionamentos do Script

1. repository-model.ts (Sprint 5)
   - Tipo: Dependência Inversa
   - Relação: Consumirá a lista de arquivos escaneados para disparar indexação.
   - Criticidade: Alta

2. ignore (biblioteca npm)
   - Tipo: Dependência Direta
   - Relação: Usa para filtrar arquivos ignorados pelo .gitignore.
   - Criticidade: Alta

3. fs/promises
   - Tipo: Dependência Direta
   - Relação: Usa para ler diretórios e metadados de arquivos.
   - Criticidade: Alta

Invariantes do Script

1. O Scanner nunca lê o conteúdo completo de arquivos binários — apenas os primeiros bytes para detecção.
2. O Scanner nunca retorna arquivos que não existem no disco.
3. O Scanner nunca retorna arquivos maiores que MAX_FILE_SIZE (2MB).
4. O Scanner respeita o .gitignore do repositório se existir.
5. O Scanner ignora pastas internas independentemente do .gitignore.
6. O Scanner detecta linguagem apenas por extensão — não analisa conteúdo.

--- FIM ARQUITETURA DO SCRIPT ---
*/

import { readdir, stat, open } from 'fs/promises'
import { existsSync, readFileSync, statSync } from 'fs'
import { join, extname, relative } from 'path'
import ignore, { Ignore } from 'ignore'

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'code_awareness',
  'code_checkpoints',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  'venv',
  '.venv'
])

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.md': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less'
}

export interface ScannedFile {
  relativePath: string
  extension: string
  language: string
  sizeBytes: number
  mtime: number
}

/** Retorna a linguagem com base na extensão do arquivo. Retorna 'unknown' se não estiver no mapa. */
export function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  return EXTENSION_TO_LANGUAGE[ext] ?? 'unknown'
}

/**
 * Lê apenas os primeiros 4096 bytes de um arquivo para detectar se é binário.
 * Evita carregar arquivos binários grandes inteiros na memória.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  const buffer = Buffer.alloc(4096)
  let handle: import('fs').promises.FileHandle | undefined
  try {
    handle = await open(filePath, 'r')
    const { bytesRead } = await handle.read(buffer, 0, 4096, 0)
    return isBinaryContent(buffer.subarray(0, bytesRead))
  } catch {
    // Se não conseguir ler (permissão, arquivo inexistente), assume não-binário
    return false
  } finally {
    // Garante que o file handle seja fechado mesmo em caso de erro
    if (handle !== undefined) {
      await handle.close()
    }
  }
}

/** Detecta se o conteúdo de um buffer é binário (não UTF-8 válido). Analisa apenas os primeiros 4096 bytes. */
function isBinaryContent(content: Buffer): boolean {
  for (let i = 0; i < Math.min(content.length, 4096); i++) {
    const byte = content[i]
    if (byte === 0) return true
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      return true
    }
  }
  return false
}

/** Lê o .gitignore do repositório e retorna uma instância configurada da biblioteca ignore. Retorna null se não existir. */
function loadGitignore(repoPath: string): Ignore | null {
  const gitignorePath = join(repoPath, '.gitignore')
  if (!existsSync(gitignorePath)) {
    return null
  }
  try {
    // Normaliza quebras de linha (\r\n → \n) para evitar padrões mal formados no Windows
    const content = readFileSync(gitignorePath, 'utf-8').replace(/\r\n/g, '\n')
    return ignore().add(content)
  } catch {
    // Se não conseguir ler o .gitignore, retorna null (não filtra por gitignore)
    return null
  }
}

/** Retorna true se o caminho está em uma pasta ignorada ou se o .gitignore diz para ignorar. */
function shouldIgnore(relativePath: string, gitignore: Ignore | null): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  const parts = normalized.split('/')

  // Ignora se qualquer parte do caminho estiver em IGNORED_DIRS
  if (parts.some((part) => IGNORED_DIRS.has(part))) {
    return true
  }

  // Respeita o .gitignore se existir
  if (gitignore) {
    return gitignore.ignores(normalized)
  }

  return false
}

/**
 * Escaneia o repositório e retorna arquivos candidatos à indexação.
 * Filtra binários, arquivos > 2MB, pastas ignoradas e .gitignore.
 */
export async function scanRepository(repoPath: string): Promise<ScannedFile[]> {
  // Validação rápida: repoPath deve existir e ser um diretório
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`Repository path inválido ou não é um diretório: ${repoPath}`)
  }

  const gitignore = loadGitignore(repoPath)
  const results: ScannedFile[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // Diretório inacessível: ignora
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      // Caminho relativo ao repositório — é o que o .gitignore espera para casar padrões
      const relativeToRepo = relative(repoPath, fullPath).replace(/\\/g, '/')

      if (shouldIgnore(relativeToRepo, gitignore)) {
        continue
      }

      try {
        if (entry.isDirectory()) {
          await walk(fullPath)
          continue
        }

        if (!entry.isFile()) {
          continue // Symlinks e outros tipos: ignora
        }

        const fileStat = await stat(fullPath)

        if (fileStat.size > MAX_FILE_SIZE) {
          continue
        }

        // Primeiro detecta se é binário lendo apenas 4096 bytes (evita carregar binários grandes)
        if (await isBinaryFile(fullPath)) {
          continue
        }

        const extension = extname(fullPath)

        results.push({
          relativePath: relativeToRepo,
          extension,
          language: detectLanguage(fullPath),
          sizeBytes: fileStat.size,
          mtime: fileStat.mtimeMs
        })
      } catch {
        continue // Arquivo inacessível: ignora
      }
    }
  }

  await walk(repoPath)

  // Ordena por relativePath
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return results
}
