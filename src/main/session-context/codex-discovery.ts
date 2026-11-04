import { lstat, realpath, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { discoverCodexCandidates } from '../local-mcp-clients/codex-registration'
import { assertProfilePath, assertUserOwnedAsync } from '../local-mcp-clients/safe-config-file'
import type { CodexArchiveDiscovery } from '../../shared/types/codex-archive-types'
import type { CodexProfile } from './codex-stdio'
import { digest } from './privacy'

export async function codexProfileIdentity(profile: CodexProfile): Promise<string> {
  try {
    if ([profile.executable, profile.directory].some(path => !isAbsolute(path) || /^[\\/]{2}/.test(path)) || (process.platform === 'win32' && !profile.executable.toLowerCase().endsWith('.exe'))) throw new Error('EXECUTABLE_UNAVAILABLE')
    for (const path of [profile.executable, profile.directory]) assertProfilePath(path, path)
    const [exe, directory] = await Promise.all([lstat(profile.executable), lstat(profile.directory)])
    if (!exe.isFile() || exe.isSymbolicLink() || exe.nlink !== 1 || !directory.isDirectory() || directory.isSymbolicLink()) throw new Error('EXECUTABLE_UNAVAILABLE')
    return digest(JSON.stringify([await realpath(profile.executable), exe.dev, exe.ino, exe.size, exe.mtimeMs, exe.ctimeMs, await realpath(profile.directory), directory.dev, directory.ino]))
  } catch { throw new Error('EXECUTABLE_UNAVAILABLE') }
}

export interface CodexCandidate { id: string; profile: CodexProfile; pin: string }
export interface CodexDiscovery { view: CodexArchiveDiscovery; candidates: CodexCandidate[] }
export async function verifyCodexCandidate(profile: CodexProfile): Promise<CodexCandidate> {
  if (basename(profile.executable).toLowerCase() !== 'codex.exe') throw new Error('EXECUTABLE_UNAVAILABLE')
  const pin = await codexProfileIdentity(profile)
  await Promise.all([assertUserOwnedAsync(profile.executable), assertUserOwnedAsync(profile.directory)])
  if (await codexProfileIdentity(profile) !== pin) throw new Error('EXECUTABLE_UNAVAILABLE')
  return { id: digest(JSON.stringify([profile, pin])), profile, pin }
}

export function candidateView(candidate: CodexCandidate): CodexArchiveDiscovery['candidates'][number] {
  return { id: candidate.id, executable: candidate.profile.executable, profile: candidate.profile.directory }
}

export async function discoverCodexArchive(env = process.env, home = homedir()): Promise<CodexDiscovery> {
  const candidates: CodexCandidate[] = []
  try {
    const directory = env.CODEX_HOME !== undefined ? env.CODEX_HOME : join(home, '.codex')
    if (!directory) throw new Error('PROFILE_MISSING')
    if ([directory, env.LOCALAPPDATA, env.APPDATA].some(path => path !== undefined && (!isAbsolute(path) || /^[\\/]{2}/.test(path)))) throw new Error('UNSAFE_CANDIDATE')
    assertProfilePath(directory, directory)
    try { if (!(await lstat(directory)).isDirectory()) throw new Error() } catch { return { view: { state: 'INVALID', reason: 'PROFILE_MISSING', candidates: [] }, candidates } }
    const binaries = env.LOCALAPPDATA ? discoverCodexCandidates(env.LOCALAPPDATA) : []
    const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    const platformPackage = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64'
    if (env.APPDATA) {
      const modules = join(env.APPDATA, 'npm', 'node_modules', '@openai')
      for (const pkg of [join(modules, 'codex'), join(modules, platformPackage), join(modules, 'codex', 'node_modules', '@openai', platformPackage)]) {
        try {
          assertProfilePath(pkg, home)
          const metadata = await lstat(join(pkg, 'package.json'))
          if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536) continue
          const value = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
          if (!['@openai/codex', '@openai/' + platformPackage].includes(value.name)) continue
          const binary = join(pkg, 'vendor', triple, 'codex', 'codex.exe')
          try { await lstat(binary); binaries.push(binary) } catch {}
        } catch {}
      }
    }
    for (const executable of [...new Set(binaries)]) candidates.push(await verifyCodexCandidate({ executable, directory }))
    const unique = [...new Map(candidates.map(candidate => [candidate.pin, candidate])).values()]
    return { view: { state: unique.length === 1 ? 'ONE_VERIFIED_CANDIDATE' : unique.length ? 'AMBIGUOUS' : 'NOT_FOUND', candidates: unique.map(candidateView) }, candidates: unique }
  } catch { return { view: { state: 'INVALID', reason: 'UNSAFE_CANDIDATE', candidates: [] }, candidates: [] } }
}
