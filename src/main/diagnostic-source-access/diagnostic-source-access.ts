import { open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_READ_LINES = 200
const MAX_RESPONSE_CHARS = 64 * 1024
const MAX_FIND_FILES = 20
const MAX_MATCHES = 100

export interface DiagnosticDirectoryEntry {
  name: string
  type: 'file' | 'directory' | 'symlink'
}

export interface DiagnosticTextMatch {
  path: string
  line: number
  text: string
}

function normalized(value: string): string {
  return value.replace(/\\/g, '/')
}

export class DiagnosticSourceAccess {
  private rootPromise: Promise<string>

  constructor(repoRoot: string) {
    this.rootPromise = realpath(repoRoot)
  }

  async listDirectory(relativePath = '.'): Promise<{ path: string; entries: DiagnosticDirectoryEntry[] }> {
    const absolute = await this.resolveKnownPath(relativePath, 'directory')
    const entries = await readdir(absolute, { withFileTypes: true })
    return {
      path: normalized(relativePath),
      entries: entries.slice(0, 500).map((entry) => ({
        name: entry.name,
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file'
      }))
    }
  }

  async readFile(relativePath: string, startLine: number, endLine: number): Promise<{ path: string; startLine: number; endLine: number; text: string; truncated: boolean }> {
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine + 1 > MAX_READ_LINES) {
      throw new Error('INVALID_LINE_RANGE')
    }
    const absolute = await this.resolveKnownPath(relativePath, 'file')
    const content = await this.readText(absolute)
    const lines = content.split(/\r?\n/)
    const selected = lines.slice(startLine - 1, endLine).join('\n')
    const truncated = selected.length > MAX_RESPONSE_CHARS
    return { path: normalized(relativePath), startLine, endLine: Math.min(endLine, lines.length), text: selected.slice(0, MAX_RESPONSE_CHARS), truncated }
  }

  async findText(paths: string[], text: string, maxMatches = MAX_MATCHES): Promise<{ matches: DiagnosticTextMatch[]; truncated: boolean }> {
    if (!text || text.length > 500) throw new Error('INVALID_SEARCH_TEXT')
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FIND_FILES || new Set(paths).size !== paths.length) throw new Error('INVALID_FILE_SELECTION')
    if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > MAX_MATCHES) throw new Error('INVALID_MATCH_LIMIT')
    const matches: DiagnosticTextMatch[] = []
    let truncated = false
    for (const relativePath of paths) {
      const absolute = await this.resolveKnownPath(relativePath, 'file')
      const lines = (await this.readText(absolute)).split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(text)) continue
        if (matches.length === maxMatches) {
          truncated = true
          return { matches, truncated }
        }
        matches.push({ path: normalized(relativePath), line: index + 1, text: lines[index].slice(0, 500) })
      }
    }
    return { matches, truncated }
  }

  private async resolveKnownPath(relativePath: string, expected: 'file' | 'directory'): Promise<string> {
    if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath) || normalized(relativePath).split('/').includes('..')) throw new Error('PATH_OUTSIDE_REPOSITORY')
    const root = await this.rootPromise
    let resolved: string
    try {
      resolved = await realpath(resolve(root, relativePath))
    } catch {
      throw new Error('PATH_NOT_FOUND')
    }
    const rel = normalized(relative(root, resolved))
    if (rel.startsWith('../') || isAbsolute(rel)) throw new Error('PATH_OUTSIDE_REPOSITORY')
    const metadata = await stat(resolved)
    if (expected === 'file' ? !metadata.isFile() : !metadata.isDirectory()) throw new Error(`EXPECTED_${expected.toUpperCase()}`)
    return resolved
  }

  private async readText(absolute: string): Promise<string> {
    const metadata = await stat(absolute)
    if (metadata.size > MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE')
    const handle = await open(absolute, 'r')
    try {
      const probe = Buffer.alloc(Math.min(metadata.size, 8192))
      if (probe.length > 0) await handle.read(probe, 0, probe.length, 0)
      if (probe.includes(0)) throw new Error('BINARY_FILE_REJECTED')
      const bytes = await handle.readFile()
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new Error('BINARY_FILE_REJECTED')
      }
    } finally {
      await handle.close()
    }
  }
}
