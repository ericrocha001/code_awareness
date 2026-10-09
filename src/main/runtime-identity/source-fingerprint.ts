import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export interface FileSnapshotMap {
  files: Map<string, string>
  fingerprint: string
  fileCount: number
  capturedAt: string
}

export interface SourceFingerprintOptions {
  rootDir?: string
  includedDirectories?: string[]
  includedRootFiles?: string[]
}

const DEFAULT_INCLUDED_DIRS = ['src/main', 'src/shared']
const DEFAULT_INCLUDED_ROOT_FILES = [
  'package.json',
  'tsconfig.json',
  'electron.vite.config.ts',
  'vite.config.ts'
]

function isIgnoredPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/')
  // Exclude test files, specs, fixtures, markdown docs
  if (
    normalized.endsWith('.test.ts') ||
    normalized.endsWith('.test.tsx') ||
    normalized.endsWith('.spec.ts') ||
    normalized.endsWith('.spec.tsx') ||
    normalized.endsWith('.test.js') ||
    normalized.endsWith('.spec.js') ||
    normalized.endsWith('.d.ts') ||
    normalized.endsWith('.md')
  ) {
    return true
  }

  // Exclude test directories or fixture directories
  const segments = normalized.split('/')
  for (const seg of segments) {
    if (
      seg === '__tests__' ||
      seg === 'fixtures' ||
      seg === 'benchmarks' ||
      seg === 'node_modules' ||
      seg === '.git' ||
      seg === 'out' ||
      seg === 'dist' ||
      seg === 'build'
    ) {
      return true
    }
  }

  return false
}

function collectFilesRecursively(dirAbs: string, rootDir: string, out: string[]): void {
  try {
    const entries = readdirSync(dirAbs, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirAbs, entry.name)
      if (entry.isDirectory()) {
        const relDir = relative(rootDir, fullPath).replace(/\\/g, '/')
        if (!isIgnoredPath(relDir)) {
          collectFilesRecursively(fullPath, rootDir, out)
        }
      } else if (entry.isFile()) {
        const relFile = relative(rootDir, fullPath).replace(/\\/g, '/')
        if (!isIgnoredPath(relFile)) {
          out.push(relFile)
        }
      }
    }
  } catch {
    // Directory might not exist or be inaccessible
  }
}

export function computeFileHash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

export class SourceFingerprintCollector {
  private readonly rootDir: string
  private readonly includedDirs: string[]
  private readonly includedRootFiles: string[]

  constructor(options: SourceFingerprintOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? process.cwd())
    this.includedDirs = options.includedDirectories ?? DEFAULT_INCLUDED_DIRS
    this.includedRootFiles = options.includedRootFiles ?? DEFAULT_INCLUDED_ROOT_FILES
  }

  getSourceRootPath(): string {
    return this.rootDir
  }

  captureSnapshot(): FileSnapshotMap {
    const collectedRelPaths: string[] = []

    for (const dir of this.includedDirs) {
      const dirAbs = join(this.rootDir, dir)
      collectFilesRecursively(dirAbs, this.rootDir, collectedRelPaths)
    }

    for (const rootFile of this.includedRootFiles) {
      const fileAbs = join(this.rootDir, rootFile)
      try {
        const stat = statSync(fileAbs)
        if (stat.isFile()) {
          const rel = relative(this.rootDir, fileAbs).replace(/\\/g, '/')
          if (!isIgnoredPath(rel)) {
            collectedRelPaths.push(rel)
          }
        }
      } catch {
        // file does not exist, ignore
      }
    }

    // Sort paths deterministically
    collectedRelPaths.sort()

    const files = new Map<string, string>()
    const aggregateHasher = createHash('sha256')

    for (const relPath of collectedRelPaths) {
      try {
        const fileAbs = join(this.rootDir, relPath)
        const content = readFileSync(fileAbs)
        const hash = computeFileHash(content)
        files.set(relPath, hash)
        aggregateHasher.update(`${relPath}:${hash}\n`)
      } catch {
        // Skip unreadable files
      }
    }

    const fingerprint = aggregateHasher.digest('hex')
    const capturedAt = new Date().toISOString()

    return {
      files,
      fingerprint,
      fileCount: files.size,
      capturedAt
    }
  }
}
