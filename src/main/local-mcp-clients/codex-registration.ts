import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readEntry, sameEntry, type McpEntry } from './config-editors'
import { assertProfilePath, assertUserOwned } from './safe-config-file'

export function discoverCodex(localAppData: string): string | undefined {
  const root = join(localAppData, 'OpenAI', 'Codex', 'bin')
  if (!existsSync(root)) return
  assertProfilePath(root, localAppData); assertUserOwned(root)
  return readdirSync(root).slice(0, 32).map(name => join(root, name, 'codex.exe'))
    .filter(path => existsSync(path) && statSync(path).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

export function codexRegistrar(binary: string, home: string): (entry: McpEntry) => Promise<McpEntry> {
  assertProfilePath(binary, home); assertUserOwned(binary)
  if (basename(binary).toLowerCase() !== 'codex.exe') throw new Error('UNTRUSTED_CODEX_CLI')
  const digest = () => createHash('sha256').update(readFileSync(binary)).digest('hex')
  const expected = digest()
  return async entry => {
    assertProfilePath(binary, home); assertUserOwned(binary)
    if (digest() !== expected) throw new Error('CODEX_CLI_REVISION_CONFLICT')
    const staging = mkdtempSync(join(tmpdir(), 'code-awareness-codex-registration-'))
    try {
      const options = { encoding: 'utf8' as const, windowsHide: true, timeout: 15000, maxBuffer: 65536,
        env: { ...process.env, CODEX_HOME: staging }, shell: false, stdio: 'pipe' as const }
      const version = execFileSync(binary, ['--version'], options).trim()
      if (!/^codex-cli \d+\.\d+\.\d+[^\r\n]*$/.test(version)) throw new Error('UNSUPPORTED_CODEX_CLI')
      const args = ['mcp', 'add', 'code_awareness_local', ...Object.entries(entry.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--', entry.command, ...entry.args]
      execFileSync(binary, args, options)
      const registered = readEntry(readFileSync(join(staging, 'config.toml'), 'utf8'), true, 'code_awareness_local')
      if (!sameEntry(registered, entry)) throw new Error('CODEX_REGISTRATION_MISMATCH')
      return registered as McpEntry
    } catch (error) {
      if (error instanceof Error && /^[A-Z_]+$/.test(error.message)) throw error
      throw new Error('CODEX_REGISTRATION_FAILED')
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }
}
