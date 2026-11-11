import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type * as ClineSdk from '@cline/sdk' with { 'resolution-mode': 'import' }

const MAX_CONFINED_READ_BYTES = 2 * 1024 * 1024
const MAX_CONFINED_SEARCH_RESULTS = 100
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out'])

function normalizeForComparison(target: string): string {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isStrictDescendantOrSame(candidate: string, root: string, allowRoot: boolean): boolean {
  const normCandidate = normalizeForComparison(candidate)
  const normRoot = normalizeForComparison(root)
  if (normCandidate === normRoot) return allowRoot
  const rel = path.relative(normRoot, normCandidate)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function resolveWithDeepestExistingRealpath(targetPath: string): string {
  const normalized = path.resolve(targetPath)
  if (fs.existsSync(normalized)) {
    return fs.realpathSync(normalized)
  }
  const missingSegments: string[] = []
  let probe = normalized
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) {
      throw new Error(`PATH_OUTSIDE_BOUND_WORKTREE: no existing ancestor for "${targetPath}"`)
    }
    missingSegments.unshift(path.basename(probe))
    probe = parent
  }
  return path.join(fs.realpathSync(probe), ...missingSegments)
}

export function resolveConfinedWorktreePath(
  worktreeRoot: string,
  rawTargetPath: string,
  options?: { readonly allowRoot?: boolean; readonly mustExist?: boolean }
): string {
  if (typeof rawTargetPath !== 'string' || !rawTargetPath.trim() || rawTargetPath.includes('\0')) {
    throw new Error('PATH_OUTSIDE_BOUND_WORKTREE: target path must be a non-empty valid path')
  }

  const trimmed = rawTargetPath.trim()
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/.*/.test(trimmed) && !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    throw new Error(`PATH_OUTSIDE_BOUND_WORKTREE: URI scheme blocked "${trimmed}"`)
  }

  const realRoot = fs.realpathSync(path.resolve(worktreeRoot))
  const candidate = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(realRoot, trimmed)
  const resolvedReal = resolveWithDeepestExistingRealpath(candidate)

  if (!isStrictDescendantOrSame(resolvedReal, realRoot, options?.allowRoot ?? false)) {
    throw new Error(`PATH_OUTSIDE_BOUND_WORKTREE: "${rawTargetPath}" escapes bound worktree`)
  }

  const rel = path.relative(normalizeForComparison(realRoot), normalizeForComparison(resolvedReal))
  const segments = rel.split(/[\\/]+/).filter(Boolean)
  if (segments.some((seg) => seg.toLowerCase() === '.git')) {
    throw new Error('PATH_OUTSIDE_BOUND_WORKTREE: .git internals are not writable or exposed')
  }

  if (options?.mustExist && !fs.existsSync(resolvedReal)) {
    throw new Error(`FILE_NOT_FOUND: ${rawTargetPath}`)
  }

  return resolvedReal
}

export function buildBuildxClineToolPolicies(allowAutoApprove: boolean): Record<string, ClineSdk.ToolPolicy> {
  return {
    run_commands: { enabled: false, autoApprove: false },
    fetch_web_content: { enabled: false, autoApprove: false },
    apply_patch: { enabled: false, autoApprove: false },
    skills: { enabled: false, autoApprove: false },
    ask_question: { enabled: false, autoApprove: false },
    read_files: { enabled: true, autoApprove: true },
    search_codebase: { enabled: true, autoApprove: true },
    editor: { enabled: true, autoApprove: allowAutoApprove },
    submit_and_exit: { enabled: true, autoApprove: true }
  }
}

export function createConfinedToolExecutors(options: {
  readonly worktreeRoot: string
  readonly createEditorExecutor: typeof ClineSdk.createEditorExecutor
}): Partial<ClineSdk.ToolExecutors> {
  const realRoot = fs.realpathSync(path.resolve(options.worktreeRoot))
  const baseEditor = options.createEditorExecutor({ restrictToCwd: true })

  return {
    readFile: async (request: Parameters<NonNullable<ClineSdk.ToolExecutors['readFile']>>[0]) => {
      const target = resolveConfinedWorktreePath(realRoot, request.path, { mustExist: true })
      const stat = await fsp.stat(target)
      if (!stat.isFile()) {
        throw new Error(`PATH_OUTSIDE_BOUND_WORKTREE: "${request.path}" is not a regular file`)
      }
      if (stat.size > MAX_CONFINED_READ_BYTES) {
        throw new Error(`FILE_TOO_LARGE: ${request.path} (${stat.size} bytes)`)
      }
      const content = await fsp.readFile(target, 'utf8')
      const lines = content.split(/\r?\n/)
      const startLine = request.start_line && request.start_line > 0 ? request.start_line : 1
      const endLine = request.end_line && request.end_line > 0 ? Math.min(request.end_line, lines.length) : lines.length
      if (startLine > lines.length) {
        return `(empty range: lines ${startLine}-${endLine} of ${lines.length})`
      }
      return lines
        .slice(startLine - 1, endLine)
        .map((line: string, index: number) => `${startLine + index}: ${line}`)
        .join('\n')
    },

    search: async (query: string, cwd: string, context: ClineSdk.AgentToolContext) => {
      if (context.signal?.aborted) {
        throw new Error('Search operation aborted')
      }
      const confinedCwd = cwd
        ? resolveConfinedWorktreePath(realRoot, cwd, { allowRoot: true, mustExist: true })
        : realRoot
      let regex: RegExp
      try {
        regex = new RegExp(query, 'i')
      } catch (err) {
        throw new Error(`Invalid regex pattern: ${query}. ${err instanceof Error ? err.message : ''}`)
      }

      const matches: string[] = []
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 16 || matches.length >= MAX_CONFINED_SEARCH_RESULTS || context.signal?.aborted) return
        const entries = await fsp.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (matches.length >= MAX_CONFINED_SEARCH_RESULTS) break
          if (entry.isSymbolicLink()) continue
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (SEARCH_SKIP_DIRS.has(entry.name)) continue
            await walk(fullPath, depth + 1)
          } else if (entry.isFile()) {
            const stat = await fsp.stat(fullPath).catch(() => null)
            if (!stat || stat.size > 512 * 1024) continue
            const raw = await fsp.readFile(fullPath, 'utf8').catch(() => null)
            if (!raw || raw.includes('\0')) continue
            const rel = path.relative(realRoot, fullPath).replace(/\\/g, '/')
            const fileLines = raw.split(/\r?\n/)
            for (let i = 0; i < fileLines.length; i++) {
              if (regex.test(fileLines[i])) {
                matches.push(`${rel}:${i + 1}: ${fileLines[i]}`)
                if (matches.length >= MAX_CONFINED_SEARCH_RESULTS) break
              }
            }
          }
        }
      }

      await walk(confinedCwd, 0)
      return matches.length > 0 ? matches.join('\n') : `No matches found for "${query}"`
    },

    editor: async (input: ClineSdk.EditFileInput, _cwd: string, context: ClineSdk.AgentToolContext) => {
      const confinedTarget = resolveConfinedWorktreePath(realRoot, input.path)
      const relativeTarget = path.relative(realRoot, confinedTarget)
      return await baseEditor({ ...input, path: relativeTarget }, realRoot, context)
    },

    bash: async () => {
      throw new Error('TOOL_FORBIDDEN_BY_BUILDX_POLICY: run_commands is disabled')
    },

    applyPatch: async () => {
      throw new Error('TOOL_FORBIDDEN_BY_BUILDX_POLICY: apply_patch is disabled')
    },

    webFetch: async () => {
      throw new Error('TOOL_FORBIDDEN_BY_BUILDX_POLICY: fetch_web_content is disabled')
    }
  }
}

export function extractTargetPathFromToolInput(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  if (toolName === 'editor' && typeof record.path === 'string') return record.path
  if (toolName === 'read_files') {
    if (typeof record.path === 'string') return record.path
    if (typeof record.file_path === 'string') return record.file_path
    if (typeof record.filePath === 'string') return record.filePath
    if (Array.isArray(record.files) && record.files.length > 0) {
      const first = record.files[0]
      if (typeof first === 'string') return first
      if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).path === 'string') {
        return (first as Record<string, unknown>).path as string
      }
    }
    if (Array.isArray(record.paths) && typeof record.paths[0] === 'string') return record.paths[0]
  }
  if (toolName === 'search_codebase' && typeof record.cwd === 'string') return record.cwd
  return undefined
}
