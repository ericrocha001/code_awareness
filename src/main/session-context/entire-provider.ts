import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { CodexParser } from './codex-parser'
import { digest } from './privacy'
import type { SessionStore } from './store'
import type { SessionInput } from './types'

interface ProviderConfig { enabled: true; repositoryId: string; executable: string; sha256: string; version: string }
interface ProviderSession { session_id: string; agent: string; status: string; worktree_path: string; started_at?: string; ended_at?: string }
export interface CommandOutput { code: number; text: string; limited: boolean }
export type CommandRunner = (executable: string, args: string[], cwd: string, limit: number, consume?: (chunk: Buffer) => boolean, timeoutMs?: number, signal?: AbortSignal) => Promise<CommandOutput>
export const runReadOnly: CommandRunner = (executable, args, cwd, limit, consume, timeoutMs = 10_000, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('PROJECT_CONTEXT_CHANGED')); return }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|ENTIRE_)/i.test(key)))
  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, NO_COLOR: '1', CI: '1', ENTIRE_LOG_LEVEL: 'error' } })
  let text = '', bytes = 0, limited = false, stderrBytes = 0
  const cancel = () => { limited = true; child.kill() }
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, Math.max(1, Math.min(10_000, timeoutMs)))
  child.stdout.on('data', (chunk: Buffer) => {
    if (limited) return
    bytes += chunk.length
    if (bytes > limit || (consume && !consume(chunk))) { limited = true; child.kill(); return }
    if (!consume) text += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) { limited = true; child.kill() } })
  child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new Error('PROVIDER_UNAVAILABLE')) })
  child.once('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve({ code: code ?? -1, text, limited }) })
})
async function smallJson(path: string): Promise<Record<string, unknown>> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error('PROVIDER_CONFIG_UNSAFE')
  return JSON.parse(await readFile(path, 'utf8'))
}
function validSession(value: unknown): value is ProviderSession {
  if (!value || typeof value !== 'object') return false
  const v = value as ProviderSession
  return typeof v.session_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v.session_id) && typeof v.agent === 'string' && v.agent.toLowerCase() === 'codex' && typeof v.status === 'string' && typeof v.worktree_path === 'string'
}
const date = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined

export class EntireProvider {
  private pending?: { key: string; task: Promise<object> }
  private deadline = 0
  constructor(private readonly store: SessionStore, private readonly root: string, private readonly assertActive: () => void, private readonly run: CommandRunner = runReadOnly,
    private readonly validateTarget: () => Promise<void> = async () => {}) {}
  private command(exe: string, args: string[], cwd: string, limit: number, consume?: (chunk: Buffer) => boolean): Promise<CommandOutput> {
    this.assertActive()
    const remaining = this.deadline - Date.now()
    if (remaining <= 0) throw new Error('IMPORT_LIMIT_REACHED')
    return this.run(exe, args, cwd, limit, consume, remaining)
  }
  refresh(sessionId?: string): Promise<object> {
    this.assertActive()
    const key = sessionId ?? 'discovery'
    if (this.pending) return this.pending.key === key ? this.pending.task : Promise.resolve({ coverage: 'PARTIAL', code: 'BACKPRESSURE' })
    const task = this.perform(sessionId).finally(() => { this.pending = undefined })
    this.pending = { key, task }
    return task
  }
  private async preflight(): Promise<ProviderConfig> {
    let config: ProviderConfig
    try { config = await smallJson(join(dirname(this.store.path), 'session-context.provider.json')) as unknown as ProviderConfig }
    catch { throw new Error('PROVIDER_UNAVAILABLE') }
    if (config.enabled !== true || config.repositoryId !== this.store.repositoryId) throw new Error('CAPTURE_NOT_ENABLED')
    if (!isAbsolute(config.executable) || !/^entire(?:\.exe)?$/i.test(basename(config.executable)) || !/^[a-f0-9]{64}$/.test(config.sha256) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(config.version)) throw new Error('PROVIDER_CONFIG_UNSAFE')
    const executable = await realpath(config.executable)
    const executableStat = await lstat(executable)
    if (!executableStat.isFile() || executableStat.size > 256 * 1024 * 1024) throw new Error('PROVIDER_CONFIG_UNSAFE')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(executable)) hash.update(chunk)
    if (hash.digest('hex') !== config.sha256) throw new Error('PROVIDER_VERSION_MISMATCH')
    const localPath = join(this.root, '.entire', 'settings.local.json')
    let local: Record<string, unknown>
    try {
      const directory = await lstat(join(this.root, '.entire'))
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error()
      local = await smallJson(localPath)
    } catch { throw new Error('PROVIDER_CONFIG_UNSAFE') }
    if ((local.strategy_options as Record<string, unknown> | undefined)?.push_sessions !== false || local.enabled === false) throw new Error('PROVIDER_CONFIG_UNSAFE')
    const tracked = await this.command('git', ['-c', 'core.fsmonitor=false', 'ls-files', '--error-unmatch', '--', '.entire/settings.local.json'], this.root, 4096)
    if (tracked.code !== 1 || tracked.limited) throw new Error('PROVIDER_CONFIG_UNSAFE')
    const version = await this.command(executable, ['version'], this.root, 4096)
    if (version.code !== 0 || version.limited || !version.text.includes(config.version)) throw new Error('PROVIDER_VERSION_MISMATCH')
    for (const [args, flags] of [[['session', 'list', '--help'], ['--json']], [['session', 'info', '--help'], ['--json', '--transcript']]] as const) {
      const help = await this.command(executable, [...args], this.root, 32 * 1024)
      if (help.code !== 0 || help.limited || !flags.every(flag => help.text.includes(flag))) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
    }
    this.assertActive()
    return { ...config, executable }
  }
  private async perform(sessionId?: string): Promise<object> {
    this.deadline = Date.now() + 12_000
    try {
      await this.validateTarget()
      const known = sessionId ? this.store.session(sessionId) : undefined
      const config = await this.preflight()
      const args = known ? ['session', 'info', known.providerSessionId, '--json'] : ['session', 'list', '--json']
      const output = await this.command(config.executable, args, this.root, 1024 * 1024)
      this.assertActive()
      if (output.limited || output.code !== 0) throw new Error(output.limited ? 'IMPORT_LIMIT_REACHED' : 'PROVIDER_UNAVAILABLE')
      let values: unknown[]
      try { const parsed = JSON.parse(output.text); values = known ? [parsed] : Array.isArray(parsed) ? parsed : (() => { throw new Error() })() }
      catch { throw new Error('PROVIDER_SCHEMA_UNSUPPORTED') }
      let imported = 0, skipped = 0
      const root = await realpath(this.root)
      for (const value of values.slice(0, 500)) {
        if (!validSession(value)) { skipped++; continue }
        let observedPath: string
        try { observedPath = await realpath(value.worktree_path) } catch { skipped++; continue }
        if (observedPath !== root || (known && value.session_id !== known.providerSessionId)) { skipped++; continue }
        const terminal = value.status.toUpperCase() === 'ENDED' && !!date(value.ended_at)
        const metadata: SessionInput = { providerSessionId: value.session_id, providerVersion: config.version, agent: 'codex',
          state: terminal ? 'ENDED' : value.status.toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'UNKNOWN',
          startedAt: date(value.started_at), endedAt: terminal ? date(value.ended_at) : undefined,
          coverage: 'UNAVAILABLE', sourceDigest: digest(JSON.stringify({ id: value.session_id, status: value.status, ended: value.ended_at })), sourceBytes: 0 }
        if (known) {
          const parser = new CodexParser()
          const transcript = await this.command(config.executable, ['session', 'info', value.session_id, '--transcript'], this.root, 32 * 1024 * 1024, chunk => parser.push(chunk))
          this.assertActive()
          if (transcript.code !== 0 && !transcript.limited) throw new Error('PROVIDER_UNAVAILABLE')
          const parsed = parser.finish()
          if (!parsed.events.length || (parser.sessionId && parser.sessionId !== value.session_id) || (parser.cwd && await realpath(parser.cwd) !== root)) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
          await this.validateTarget()
          this.assertActive()
          const result = this.store.ingest({ ...metadata, ...parsed, coverage: transcript.limited ? 'PARTIAL' : parsed.coverage }, parsed.events, this.assertActive)
          await this.validateTarget()
          this.assertActive()
          this.store.maintain()
          return { ...result, imported: 1, lastObserved: new Date().toISOString(), sourceBytes: parsed.sourceBytes, provider: 'entire', provenance: 'OBSERVED_FROM_PROVIDER' }
        }
        if (!this.store.byProvider(value.session_id)) {
          await this.validateTarget()
          this.assertActive()
          this.store.ingest(metadata, [], this.assertActive); imported++
        }
      }
      await this.validateTarget()
      this.assertActive()
      this.store.maintain()
      return { imported, skipped, coverage: skipped || values.length > 500 ? 'PARTIAL' : 'COMPLETE', lastObserved: new Date().toISOString(), provider: 'entire', transcriptImported: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const allowed = ['PROVIDER_UNAVAILABLE', 'CAPTURE_NOT_ENABLED', 'PROVIDER_CONFIG_UNSAFE', 'PROVIDER_VERSION_MISMATCH', 'PROVIDER_SCHEMA_UNSUPPORTED', 'IMPORT_LIMIT_REACHED', 'CAPACITY_REACHED', 'SOURCE_PARTIAL_CONFLICT', 'SESSION_UNAVAILABLE', 'PROJECT_CONTEXT_CHANGED', 'WORKTREE_STALE', 'WORKTREE_NOT_DISCOVERED', 'WORKTREE_REPOSITORY_CHANGED', 'WORKTREE_IDENTITY_MISMATCH']
      return { coverage: 'UNAVAILABLE', code: allowed.includes(message) ? message : 'PROVIDER_UNAVAILABLE', lastObserved: new Date().toISOString(), imported: 0 }
    }
  }
}
