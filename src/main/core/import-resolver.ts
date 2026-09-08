/*
-T ---
*/

import { join, dirname, normalize } from 'path'

export interface ImportResolutionInternal {
  status: 'internal'
  targetRelativePath: string
}

export type ImportResolution =
  | ImportResolutionInternal
  | { status: 'external' }
  | { status: 'unresolved' }

interface TsPathEntry {
  key: string
  target: string
}

const EXTENSION_CANDIDATES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

function stripExtension(p: string): string {
  return p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
}

/** Remove comentários de linha/bloco de um JSONC, preservando strings e quebras de linha. */
function stripJsonComments(json: string): string {
  let result = ''
  let inString = false
  let i = 0
  while (i < json.length) {
    const ch = json[i]
    const next = json[i + 1]
    if (inString) {
      result += ch
      if (ch === '\\') {
        result += next ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      result += ch
      i++
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < json.length && json[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < json.length && !(json[i] === '*' && json[i + 1] === '/')) i++
      i += 2
      continue
    }
    result += ch
    i++
  }
  return result
}

/** Lê e interpreta tsconfig.json (baseUrl/paths); nunca lança. */
function loadTsConfig(tsconfigPath: string): { baseUrl?: string; paths: TsPathEntry[] } {
  try {
    const fs = require('fs') as typeof import('fs')
    if (!fs.existsSync(tsconfigPath)) return { paths: [] }
    const raw = fs.readFileSync(tsconfigPath, 'utf-8')
    const parsed = JSON.parse(stripJsonComments(raw))
    const compilerOptions = parsed?.compilerOptions ?? {}
    const baseUrl = typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : undefined
    const paths: TsPathEntry[] = []
    const rawPaths = compilerOptions.paths
    if (rawPaths && typeof rawPaths === 'object') {
      for (const key of Object.keys(rawPaths)) {
        const targets = rawPaths[key]
        if (Array.isArray(targets) && typeof targets[0] === 'string') {
          paths.push({ key, target: targets[0] })
        }
      }
    }
    return { baseUrl, paths }
  } catch {
    return { paths: [] }
  }
}

export class ImportResolver {
  private readonly repoPath: string
  private readonly tsconfigBaseUrl: string | undefined
  private readonly tsPaths: TsPathEntry[]
  /** Mapa semExt (normalized, sem extensão) → relativePath completo (com extensão). */
  private filesByKey = new Map<string, string>()

  constructor(repoPath: string) {
    this.repoPath = repoPath
    const cfg = loadTsConfig(join(repoPath, 'tsconfig.json'))
    this.tsconfigBaseUrl = cfg.baseUrl
    this.tsPaths = cfg.paths
  }

  /** Informa os arquivos existentes; indexa por chave sem extensão e resolve para o caminho completo. */
  setFiles(relativePaths: string[]): void {
    this.filesByKey = new Map()
    for (const p of relativePaths) {
      const rel = normalizeSlashes(p)
      this.filesByKey.set(stripExtension(rel), rel)
    }
  }

  private resolveCandidate(base: string): { found: boolean; relativePath: string } {
    for (const ext of EXTENSION_CANDIDATES) {
      const candidate = base + ext
      const full = this.filesByKey.get(candidate)
      if (full) {
        return { found: true, relativePath: full }
      }
    }
    const indexFull = this.filesByKey.get(base + '/index')
    if (indexFull) {
      return { found: true, relativePath: indexFull }
    }
    return { found: false, relativePath: base }
  }

  private resolvePathToFile(resolvedBase: string): string | null {
    const r = this.resolveCandidate(stripExtension(normalizeSlashes(resolvedBase)))
    return r.found ? r.relativePath : null
  }

  private tryBaseUrlResolve(targetBase: string): ImportResolution {
    const target = this.resolvePathToFile(targetBase)
    return target ? { status: 'internal', targetRelativePath: target } : { status: 'unresolved' }
  }

  resolve(specifier: string, importerRelativePath: string): ImportResolution {
    const s = specifier.trim()

    // Relativo (./ ou ../)
    if (s.startsWith('./') || s.startsWith('../')) {
      const importerDir = dirname(importerRelativePath)
      const resolvedBase = normalizeSlashes(normalize(join(importerDir, s)))
      const target = this.resolvePathToFile(resolvedBase)
      return target ? { status: 'internal', targetRelativePath: target } : { status: 'unresolved' }
    }

    // Absoluto a partir da raiz do repo (/...)
    if (s.startsWith('/')) {
      const resolvedBase = normalizeSlashes(s.replace(/^\/+/, ''))
      const target = this.resolvePathToFile(resolvedBase)
      return target ? { status: 'internal', targetRelativePath: target } : { status: 'unresolved' }
    }

    // Aliases do tsconfig (baseUrl + paths)
    if (this.tsPaths.length > 0) {
      for (const { key, target } of this.tsPaths) {
        const starKey = key.indexOf('*')
        const starTarget = target.indexOf('*')
        if (starKey >= 0 && starTarget >= 0) {
          const prefix = key.slice(0, starKey)
          const suffix = key.slice(starKey + 1)
          if (s.startsWith(prefix) && s.endsWith(suffix)) {
            const middle = s.slice(prefix.length, s.length - suffix.length)
            const targetBase = target.slice(0, starTarget) + middle + target.slice(starTarget + 1)
            return this.tryBaseUrlResolve(targetBase)
          }
        } else if (s === key) {
          return this.tryBaseUrlResolve(target)
        }
      }
    }

    // baseUrl genérico sem alias explícito
    if (this.tsconfigBaseUrl) {
      return this.tryBaseUrlResolve(normalizeSlashes(join(this.tsconfigBaseUrl, s)))
    }

    // Sem ponto inicial nem alias → externo
    return { status: 'external' }
  }
}
