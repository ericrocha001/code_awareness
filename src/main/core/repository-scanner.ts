/*
-T ---
*/

import { readdir, stat, open } from 'fs/promises'
import { existsSync, readFileSync, statSync } from 'fs'
import { join, extname, relative } from 'path'
import ignore, { Ignore } from 'ignore'
import { getLanguageForExtension } from './language-adapter'

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB

const BINARY_EXTENSIONS = new Set([
  '.7z', '.avi', '.bmp', '.class', '.dll', '.doc', '.docx', '.eot', '.exe', '.gif', '.gz',
  '.ico', '.jar', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.otf', '.pdf', '.png', '.so',
  '.tar', '.tiff', '.ttf', '.wav', '.webm', '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.zip'
])

export function isKnownBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())
}

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
  '.mjs': 'javascript',
  '.cjs': 'javascript',
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
  return getLanguageForExtension(ext) ?? EXTENSION_TO_LANGUAGE[ext] ?? 'unknown'
}

/**
 * Lê apenas os primeiros 4096 bytes de um arquivo para detectar se é binário.
 * Evita carregar arquivos binários grandes inteiros na memória.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  if (isKnownBinaryExtension(filePath)) return true
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

export async function isEligibleTextFile(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath)
    return fileStat.isFile() && fileStat.size <= MAX_FILE_SIZE && !(await isBinaryFile(filePath))
  } catch {
    return false
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

        if (!(await isEligibleTextFile(fullPath))) {
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
