import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

let cachedBinaryPath: string | null = null

export function getOrBuildCliJobOwnerBinary(): string | null {
  if (process.platform !== 'win32') {
    return null
  }

  if (cachedBinaryPath && existsSync(cachedBinaryPath)) {
    return cachedBinaryPath
  }

  // Pre-compiled location or out/cli-execution
  const root = realpathSync(resolve(__dirname, '../../../..'))
  const targetDir = join(root, 'out', 'cli-execution')
  mkdirSync(targetDir, { recursive: true })
  const targetExe = join(targetDir, 'cli-job-owner.exe')

  if (existsSync(targetExe)) {
    cachedBinaryPath = targetExe
    return targetExe
  }

  // Compile using framework csc.exe
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const compiler = join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

  if (!existsSync(compiler)) {
    return null
  }

  const win32Cs = join(root, 'src', 'main', 'work-orchestration', 'runtime-preview', 'windows', 'Win32.cs')
  const cliOwnerCs = join(root, 'src', 'main', 'cli-execution', 'windows', 'CliJobOwner.cs')

  if (!existsSync(win32Cs) || !existsSync(cliOwnerCs)) {
    return null
  }

  const result = spawnSync(
    compiler,
    ['/nologo', '/target:exe', `/out:${targetExe}`, win32Cs, cliOwnerCs],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000
    }
  )

  if (result.status === 0 && existsSync(targetExe)) {
    cachedBinaryPath = targetExe
    return targetExe
  }

  return null
}
