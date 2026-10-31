import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import type { CliCommandDescriptor } from './cli-execution-types'

const KNOWN_INTERPRETERS = new Set([
  'node',
  'node.exe',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'bash',
  'bash.exe',
  'sh',
  'sh.exe',
  'python',
  'python.exe',
  'python3',
  'python3.exe',
  'perl',
  'perl.exe',
  'ruby',
  'ruby.exe'
])

const KNOWN_PACKAGE_MANAGERS = new Set([
  'npm',
  'npm.cmd',
  'npx',
  'npx.cmd',
  'yarn',
  'yarn.cmd',
  'pnpm',
  'pnpm.cmd',
  'corepack',
  'corepack.cmd'
])

export function formatCommandLine(executable: string, args: string[]): string {
  const quote = (arg: string) => {
    if (!arg) return '""'
    if (/[\s"']/.test(arg)) {
      return `"${arg.replace(/"/g, '\\"')}"`
    }
    return arg
  }
  return [quote(executable), ...args.map(quote)].join(' ')
}

export function resolveExecutablePath(nameOrPath: string, cwd: string): string | null {
  // If it contains path separators, check relative to cwd
  if (nameOrPath.includes('/') || nameOrPath.includes('\\')) {
    const candidate = resolve(cwd, nameOrPath)
    if (existsSync(candidate)) {
      try {
        const stat = statSync(candidate)
        if (stat.isFile()) return realpathSync(candidate)
      } catch {}
    }
    // Try with Windows PATHEXT
    if (process.platform === 'win32') {
      const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
      for (const ext of pathext) {
        const candidateWithExt = candidate + ext
        if (existsSync(candidateWithExt)) {
          try {
            const stat = statSync(candidateWithExt)
            if (stat.isFile()) return realpathSync(candidateWithExt)
          } catch {}
        }
      }
    }
    return null
  }

  // Look up in PATH
  const pathDirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
  const extensions =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')]
      : ['']

  for (const dir of pathDirs) {
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = join(dir, nameOrPath + ext)
      if (existsSync(candidate)) {
        try {
          const stat = statSync(candidate)
          if (stat.isFile()) return realpathSync(candidate)
        } catch {}
      }
    }
  }

  return null
}

export function detectRisks(executable: string, originalName: string, args: string[]): string[] {
  const risks: string[] = [
    'POTENTIAL_DATA_OR_NETWORK_ACCESS',
    'REMOTE_OUTPUT_EXPOSURE'
  ]

  const baseName = originalName.toLowerCase().replace(/\\/g, '/').split('/').pop() || ''
  if (KNOWN_INTERPRETERS.has(baseName)) {
    risks.push('COMMAND_INTERPRETER_ARBITRARY_CODE_EXECUTION')
  }

  if (KNOWN_PACKAGE_MANAGERS.has(baseName)) {
    risks.push('PACKAGE_SCRIPT_INDIRECT_CODE_EXECUTION')
  }

  if (args.some((a) => /-(e|c|command)|--eval|--execute/i.test(a))) {
    risks.push('INLINE_SCRIPT_EVALUATION')
  }

  return risks
}

export function resolveCliCommand(
  repoRoot: string,
  rawExecutable: string,
  rawArgs: string[] = [],
  rawRelativeCwd?: string
): CliCommandDescriptor {
  if (!rawExecutable || typeof rawExecutable !== 'string' || !rawExecutable.trim()) {
    throw new Error('INVALID_ARGUMENT: executable is required')
  }

  // Check rawRelativeCwd: reject absolute path
  if (rawRelativeCwd && isAbsolute(rawRelativeCwd)) {
    throw new Error('ABSOLUTE_CWD_FORBIDDEN: cwd must be relative to the active checkout')
  }

  const canonicalRoot = realpathSync(repoRoot)
  const targetCwd = rawRelativeCwd ? resolve(canonicalRoot, rawRelativeCwd) : canonicalRoot

  // Verify targetCwd exists
  if (!existsSync(targetCwd)) {
    throw new Error('CWD_NOT_FOUND')
  }

  const canonicalCwd = realpathSync(targetCwd)

  // Verify that canonicalCwd is inside canonicalRoot
  const rel = relative(canonicalRoot, canonicalCwd)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('CWD_OUTSIDE_CHECKOUT: Working directory must be inside the active repository')
  }

  const resolvedExecutable = resolveExecutablePath(rawExecutable.trim(), canonicalCwd)
  if (!resolvedExecutable) {
    throw new Error(`EXECUTABLE_NOT_FOUND: Could not resolve executable '${rawExecutable}'`)
  }

  const cleanArgs = rawArgs.map((arg) => String(arg))
  if ([resolvedExecutable, ...cleanArgs].some(value => value.includes('\0'))) throw new Error('INVALID_COMMAND_ARGUMENT')
  let executable = resolvedExecutable, args = cleanArgs
  let windowsCommandLine: string | undefined
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedExecutable)) {
    if ([resolvedExecutable, ...cleanArgs].some(value => /["&|<>%^!\r\n()]/.test(value)) || cleanArgs.some(value => /\\$/.test(value))) {
      throw new Error('WINDOWS_WRAPPER_ARGUMENT_UNREPRESENTABLE')
    }
    const interpreter = resolveExecutablePath(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'cmd.exe'), canonicalCwd)
    if (!interpreter) throw new Error('WINDOWS_INTERPRETER_UNAVAILABLE')
    executable = interpreter
    const script = [resolvedExecutable, ...cleanArgs].map(value => `"${value}"`).join(' ')
    args = ['/d', '/v:off', '/s', '/c', script]
    windowsCommandLine = `"${interpreter}" /d /v:off /s /c "${script}"`
  }
  const displayCommandLine = windowsCommandLine ?? formatCommandLine(executable, args)
  if (displayCommandLine.length > 30000) throw new Error('COMMAND_LIMIT')

  return {
    executable,
    windowsCommandLine,
    originalArgs: cleanArgs,
    originalExecutable: rawExecutable,
    args,
    cwd: canonicalCwd,
    relativeCwd: rel || '.',
    displayCommandLine
  }
}
