/*
-T ---
*/

import { readdir, stat, open } from 'fs/promises'
import { existsSync, readFileSync, statSync } from 'fs'
import { join, extname, relative, dirname } from 'path'
import ignore, { Ignore } from 'ignore'
import type { Stats } from 'fs'
import { createCodeMapWorkMetrics, type CodeMapWorkMetrics } from './codemap-work-metrics'
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
  '.markdown': 'markdown',
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
  observation?: FileObservation
}

export interface FileObservation {
  stat: Stats
  eligible?: boolean
}

export interface ScanOptions {
  metrics?: CodeMapWorkMetrics
  reuseEligibility?: (relativePath: string, observation: FileObservation) => boolean
  filterEligible?: (paths: string[], observations: ReadonlyMap<string, FileObservation>, metrics: CodeMapWorkMetrics) => Promise<string[]>
}

export function diskMetadataVersion(stat: Stats, contentHash: string): string {
  return JSON.stringify([1, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs, stat.mode, contentHash])
}

export async function observeTextEligibility(filePath: string, observation: FileObservation, metrics?: CodeMapWorkMetrics): Promise<boolean> {
  if (observation.eligible !== undefined) return observation.eligible
  if (!observation.stat.isFile() || observation.stat.size > MAX_FILE_SIZE || isKnownBinaryExtension(filePath)) return observation.eligible = false
  if (metrics) metrics.contentReads++
  const buffer = Buffer.alloc(4096)
  const handle = await open(filePath, 'r')
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return observation.eligible = !isBinaryContent(buffer.subarray(0, bytesRead), bytesRead === buffer.length)
  } finally {
    await handle.close()
  }
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
    return isBinaryContent(buffer.subarray(0, bytesRead), bytesRead === buffer.length)
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

export function isBinaryContent(content: Buffer, partial = false): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content, { stream: partial })
  } catch {
    return true
  }
  for (let i = 0; i < content.length; i++) {
    const byte = content[i]
    if (byte === 0) return true
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      return true
    }
  }
  return false
}

/** Lê o .gitignore do repositório e retorna uma instância configurada da biblioteca ignore. Retorna null se não existir. */
function loadGitignore(repoPath: string, metrics?: CodeMapWorkMetrics): Ignore | null {
  const gitignorePath = join(repoPath, '.gitignore')
  try {
    // Normaliza quebras de linha (\r\n → \n) para evitar padrões mal formados no Windows
    const content = readFileSync(gitignorePath, 'utf-8').replace(/\r\n/g, '\n')
    if (metrics) metrics.ignoreRuleReads++
    return ignore().add(content)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function isFilesystemIgnored(repoPath: string, relativePath: string, cache = new Map<string, Ignore | null>(), metrics?: CodeMapWorkMetrics): boolean {
  if (isInternalPath(relativePath)) return true
  const parts = dirname(relativePath).replace(/\\/g, '/').split('/').filter(part => part !== '.')
  let ignored = false
  for (let depth = 0; depth <= parts.length; depth++) {
    const directory = parts.slice(0, depth).join('/')
    if (!cache.has(directory)) cache.set(directory, loadGitignore(join(repoPath, directory), metrics))
    const rules = cache.get(directory)
    if (!rules) continue
    const scoped = directory ? relativePath.slice(directory.length + 1) : relativePath
    const scopedParts = scoped.split('/')
    for (let end = 1; end < scopedParts.length; end++) {
      if (rules.ignores(scopedParts.slice(0, end).join('/') + '/')) return true
    }
    const test = rules.test(scoped)
    if (test.ignored) ignored = true
    else if (test.unignored) ignored = false
  }
  return ignored
}

function isInternalPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  const parts = normalized.split('/')

  // Ignora se qualquer parte do caminho estiver em IGNORED_DIRS
  if (parts.some((part) => IGNORED_DIRS.has(part))) {
    return true
  }

  return false
}

/**
 * Escaneia o repositório e retorna arquivos candidatos à indexação.
 * Filtra binários, arquivos > 2MB, pastas ignoradas e .gitignore.
 */
export async function scanRepository(repoPath: string, options: ScanOptions = {}): Promise<ScannedFile[]> {
  // Validação rápida: repoPath deve existir e ser um diretório
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`Repository path inválido ou não é um diretório: ${repoPath}`)
  }

  const startedAt = Date.now()
  const metrics = options.metrics ?? createCodeMapWorkMetrics()
  const observations = new Map<string, FileObservation>()
  const results: ScannedFile[] = []
  const ignoreCache = new Map<string, Ignore | null>()

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    if (!options.filterEligible) ignoreCache.set(relative(repoPath, dir).replace(/\\/g, '/'), entries.some(entry => entry.name === '.gitignore') ? loadGitignore(dir, metrics) : null)

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      // Caminho relativo ao repositório — é o que o .gitignore espera para casar padrões
      const relativeToRepo = relative(repoPath, fullPath).replace(/\\/g, '/')

      if (isInternalPath(relativeToRepo)) {
        continue
      }

      if (!options.filterEligible) {
        if (isFilesystemIgnored(repoPath, relativeToRepo + (entry.isDirectory() ? '/' : ''), ignoreCache, metrics)) continue
      }

      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (!entry.isFile()) continue

      metrics.filesVisited++
      metrics.filesStatChecked++
      let fileStat: Stats
      try {
        fileStat = await stat(fullPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const observation: FileObservation = { stat: fileStat }
      if (options.reuseEligibility?.(relativeToRepo, observation)) {
        observation.eligible = true
        metrics.metadataReused++
      }
      observations.set(relativeToRepo, observation)

      results.push({
        relativePath: relativeToRepo,
        extension: extname(fullPath),
        language: detectLanguage(fullPath),
        sizeBytes: fileStat.size,
        mtime: fileStat.mtimeMs,
        observation
      })
    }
  }

  try {
    await walk(repoPath)
    const eligible = options.filterEligible
      ? new Set(await options.filterEligible(results.map(file => file.relativePath), observations, metrics))
      : new Set<string>()
    if (!options.filterEligible) for (const file of results) {
      if (await observeTextEligibility(join(repoPath, file.relativePath), file.observation!, metrics)) eligible.add(file.relativePath)
    }
    results.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    return results.filter(file => eligible.has(file.relativePath))
  } finally {
    metrics.phaseDurationMs.discovery += Date.now() - startedAt
  }
}
