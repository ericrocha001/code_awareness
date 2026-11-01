import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { CodexParser } from './codex-parser'
import { sourceTimestamp as date } from './source-time'
import { digest } from './privacy'
import type { SessionStore } from './store'
import type { SessionInput, SessionRow, CoverageReasons } from './types'
import { projectLiveSessions, projectLiveUsage, type LiveSessionQuery, type LiveSessionToolName } from './entire-live'
import type { LiveSessionTarget } from './target'

interface ProviderConfig { enabled: true; repositoryId: string; executable: string; sha256: string; version: string }
const verifiedLiveExecutables = new Map<string, string>()
async function executableIdentity(executable: string): Promise<string> {
  const stat = await lstat(executable, { bigint: true })
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}
interface ProviderSession { session_id: string; agent: string; status: string; worktree_path: string; started_at?: string; ended_at?: string }
export interface CommandOutput { code: number; text: string; limited: boolean; timedOut?: boolean; limitReason?: 'STDOUT_LIMIT' | 'STDERR_LIMIT' | 'CONSUMER_LIMIT' }
export type CommandRunner = (executable: string, args: string[], cwd: string, limit: number, consume?: (chunk: Buffer) => boolean, timeoutMs?: number, signal?: AbortSignal) => Promise<CommandOutput>
export const runReadOnly: CommandRunner = (executable, args, cwd, limit, consume, timeoutMs = 10_000, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('PROJECT_CONTEXT_CHANGED')); return }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|ENTIRE_)/i.test(key)))
  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, NO_COLOR: '1', CI: '1', ENTIRE_LOG_LEVEL: 'error' } })
  let text = '', bytes = 0, limited = false, stderrBytes = 0, timedOut = false
  let limitReason: CommandOutput['limitReason']
  const cancel = () => { limited = true; child.kill() }
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { timedOut = true; cancel() }, Math.max(1, Math.min(10_000, timeoutMs)))
  child.stdout.on('data', (chunk: Buffer) => {
    if (limited) return
    bytes += chunk.length
    if (bytes > limit) { limitReason = 'STDOUT_LIMIT'; limited = true; child.kill(); return }
    if (consume && !consume(chunk)) { limitReason = 'CONSUMER_LIMIT'; limited = true; child.kill(); return }
    if (!consume) text += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) { limitReason ??= 'STDERR_LIMIT'; limited = true; child.kill() } })
  child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new Error('PROVIDER_UNAVAILABLE')) })
  child.once('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve({ code: code ?? -1, text, limited, ...(limitReason ? { limitReason } : {}), ...(timedOut ? { timedOut } : {}) }) })
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

export class EntireProvider {
  private pending?: { key: string; task: Promise<object> }
  private deadline = 0
  private phase = 'preflight'
  constructor(private readonly store: SessionStore | Pick<SessionStore, 'path' | 'repositoryId'>, private readonly root: string, private readonly assertActive: () => void, private readonly run: CommandRunner = runReadOnly,
    private readonly validateTarget: () => Promise<void> = async () => {},
    private readonly observePhase: (phase: string) => void = () => {}) {}
  private mark(phase: string): void { this.phase = phase; this.observePhase(phase) }
  private assertDeadline(): void { if (Date.now() >= this.deadline) throw Object.assign(new Error('PROVIDER_TIMEOUT'), { phase: this.phase }) }
  private assertWithinDeadline(): void { this.assertActive(); this.assertDeadline() }
  private async validate(): Promise<void> {
    this.mark('target-validation')
    this.assertWithinDeadline()
    await this.validateTarget()
    this.assertWithinDeadline()
  }
  private async command(exe: string, args: string[], cwd: string, limit: number, consume?: (chunk: Buffer) => boolean): Promise<CommandOutput> {
    this.assertWithinDeadline()
    this.mark(args.includes('--transcript') ? 'transcript' : args.includes('--help') ? 'cli-schema' : args.includes('--json') ? 'metadata' : args[0] === 'version' ? 'version' : 'privacy')
    const remaining = this.deadline - Date.now()
    const output = await this.run(exe, args, cwd, limit, consume, remaining)
    this.assertWithinDeadline()
    if (output.timedOut) throw new Error('PROVIDER_TIMEOUT')
    return output
  }
  refresh(sessionId?: string): Promise<object> {
    this.assertActive()
    const key = sessionId ?? 'discovery'
    if (this.pending) return this.pending.key === key ? this.pending.task : Promise.resolve({ coverage: 'PARTIAL', code: 'BACKPRESSURE' })
    const task = this.perform(sessionId).finally(() => { this.pending = undefined })
    this.pending = { key, task }
    return task
  }
  private async preflight(live = false): Promise<ProviderConfig> {
    let config: ProviderConfig
    try { config = await smallJson(join(dirname(this.store.path), 'session-context.provider.json')) as unknown as ProviderConfig }
    catch { throw new Error('PROVIDER_UNAVAILABLE') }
    if (config.enabled !== true || config.repositoryId !== this.store.repositoryId) throw new Error('CAPTURE_NOT_ENABLED')
    if (!isAbsolute(config.executable) || !/^entire(?:\.exe)?$/i.test(basename(config.executable)) || !/^[a-f0-9]{64}$/.test(config.sha256) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(config.version)) throw new Error('PROVIDER_CONFIG_UNSAFE')
    const executable = await realpath(config.executable)
    const executableStat = await lstat(executable, { bigint: true })
    if (!executableStat.isFile() || executableStat.size > 256 * 1024 * 1024) throw new Error('PROVIDER_CONFIG_UNSAFE')
    const signature = [executableStat.dev, executableStat.ino, executableStat.size, executableStat.mtimeNs, executableStat.ctimeNs, config.sha256, config.version].join(':')
    const verified = live && verifiedLiveExecutables.get(executable) === signature
    if (!verified) {
      this.mark('executable-hash')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(executable)) { this.assertDeadline(); hash.update(chunk) }
      this.assertWithinDeadline()
      if (hash.digest('hex') !== config.sha256) throw new Error('PROVIDER_VERSION_MISMATCH')
    }
    const localPath = join(this.root, '.entire', 'settings.local.json')
    let local: Record<string, unknown>
    try {
      const directory = await lstat(join(this.root, '.entire'))
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error()
      local = await smallJson(localPath)
    } catch { throw new Error('PROVIDER_CONFIG_UNSAFE') }
    if ((local.strategy_options as Record<string, unknown> | undefined)?.push_sessions !== false || local.enabled === false) throw new Error('PROVIDER_CONFIG_UNSAFE')
    if (live && local.telemetry !== false) throw new Error('PROVIDER_CONFIG_UNSAFE')
    const tracked = await this.command('git', ['-c', 'core.fsmonitor=false', 'ls-files', '--error-unmatch', '--', '.entire/settings.local.json'], this.root, 4096)
    if (tracked.code !== 1 || tracked.limited) throw new Error('PROVIDER_CONFIG_UNSAFE')
    if (!verified) {
      const version = await this.command(executable, ['version'], this.root, 4096)
      if (version.code !== 0 || version.limited || !version.text.includes(config.version)) throw new Error('PROVIDER_VERSION_MISMATCH')
      const checks = live ? [[['session', 'list', '--help'], ['--json']], [['session', 'info', '--help'], ['--json']], [['session', 'tokens', '--help'], ['--json']]] : [[['session', 'list', '--help'], ['--json']], [['session', 'info', '--help'], ['--json', '--transcript']]]
      for (const [args, flags] of checks) {
        const help = await this.command(executable, [...args], this.root, 32 * 1024)
        if (help.code !== 0 || help.limited || !flags.every(flag => help.text.includes(flag))) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
      }
      if (live) {
        if (signature !== [await executableIdentity(executable), config.sha256, config.version].join(':')) throw new Error('PROVIDER_VERSION_MISMATCH')
        if (verifiedLiveExecutables.size >= 16) verifiedLiveExecutables.clear()
        verifiedLiveExecutables.set(executable, signature)
      }
    }
    this.assertWithinDeadline()
    return { ...config, executable }
  }
  async queryLive(name: LiveSessionToolName, q: LiveSessionQuery, targets: LiveSessionTarget[]): Promise<object> {
    this.deadline = Date.now() + 12_000
    await this.validate()
    const config = await this.preflight(true)
    const identity = await executableIdentity(config.executable)
    if (config.version !== '0.12.2') throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
    const json = async (args: string[]) => {
      if (await executableIdentity(config.executable) !== identity) throw new Error('PROVIDER_VERSION_MISMATCH')
      const output = await this.command(config.executable, args, this.root, 1024 * 1024)
      if (await executableIdentity(config.executable) !== identity) throw new Error('PROVIDER_VERSION_MISMATCH')
      if (output.limited) throw new Error('PROVIDER_OUTPUT_LIMIT')
      if (output.code !== 0) throw new Error('PROVIDER_UNAVAILABLE')
      try { return JSON.parse(output.text) as unknown } catch { throw new Error('PROVIDER_SCHEMA_UNSUPPORTED') }
    }
    let result: object
    if (name === 'discover_entire_sessions') {
      result = await projectLiveSessions(name, await json(['session', 'list', '--json']), q, targets, () => this.assertWithinDeadline())
    } else {
      if (!('providerSessionId' in q)) throw new Error('INVALID_ARGUMENT')
      const info = await json(['session', 'info', q.providerSessionId, '--json'])
      const detail = await projectLiveSessions('inspect_entire_session', info, { ...q, includeFiles: name === 'inspect_entire_session' && 'includeFiles' in q ? q.includeFiles : false, fileLimit: 'fileLimit' in q ? q.fileLimit : 10 }, targets, () => this.assertWithinDeadline())
      result = name === 'inspect_entire_session' ? detail : { source: 'ENTIRE_LIVE', providerSessionId: q.providerSessionId,
        ...projectLiveUsage(await json(['session', 'tokens', q.providerSessionId, '--json']), q.providerSessionId) }
    }
    await this.validate()
    const finalConfig = await this.preflight(true)
    if (finalConfig.executable !== config.executable || finalConfig.sha256 !== config.sha256 || finalConfig.version !== config.version) throw new Error('PROVIDER_VERSION_MISMATCH')
    return result
  }
  private async perform(sessionId?: string): Promise<object> {
    this.deadline = Date.now() + (sessionId ? 12_000 : 10_000)
    let known: SessionRow | undefined
    try {
      if (!('ingest' in this.store)) throw new Error('SESSION_CONTEXT_UNAVAILABLE')
      const store = this.store
      await this.validate()
      known = sessionId ? store.session(sessionId) : undefined
      this.mark('preflight')
      const config = await this.preflight()
      const args = known ? ['session', 'info', known.providerSessionId, '--json'] : ['session', 'list', '--json']
      const output = await this.command(config.executable, args, this.root, 1024 * 1024)
      this.assertWithinDeadline()
      if (output.limited || output.code !== 0) throw new Error(output.limited ? 'IMPORT_LIMIT_REACHED' : 'PROVIDER_UNAVAILABLE')
      let values: unknown[]
      try { const parsed = JSON.parse(output.text); values = known ? [parsed] : Array.isArray(parsed) ? parsed : (() => { throw new Error() })() }
      catch { throw new Error('PROVIDER_SCHEMA_UNSUPPORTED') }
      let imported = 0, skipped = 0
      const discoveryReasons: CoverageReasons = {}
      const skip = (reason: 'INVALID_SESSION_METADATA' | 'SOURCE_PATH_UNAVAILABLE' | 'FOREIGN_SOURCE') => { skipped++; discoveryReasons[reason] = (discoveryReasons[reason] ?? 0) + 1 }
      const root = await realpath(this.root)
      for (const value of values.slice(0, 500)) {
        if (!validSession(value)) { skip('INVALID_SESSION_METADATA'); continue }
        let observedPath: string
        try { if (!isAbsolute(value.worktree_path)) throw new Error(); observedPath = await realpath(value.worktree_path) } catch { skip('SOURCE_PATH_UNAVAILABLE'); continue }
        if (observedPath !== root || (known && value.session_id !== known.providerSessionId)) { skip('FOREIGN_SOURCE'); continue }
        const terminal = value.status.toUpperCase() === 'ENDED' && !!date(value.ended_at)
        const metadata: SessionInput = { providerSessionId: value.session_id, providerVersion: config.version, agent: 'codex',
          state: terminal ? 'ENDED' : value.status.toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'UNKNOWN',
          startedAt: date(value.started_at), endedAt: terminal ? date(value.ended_at) : undefined,
          coverage: 'UNAVAILABLE', importState: 'METADATA_ONLY', coverageReasons: { TRANSCRIPT_NOT_IMPORTED: 1 }, sourceDigest: digest(JSON.stringify({ id: value.session_id, status: value.status, ended: value.ended_at })), sourceBytes: 0 }
        if (known) {
          const parser = new CodexParser(cwd => { if (!isAbsolute(cwd)) throw new Error('SOURCE_IDENTITY_UNAVAILABLE'); return realpathSync(cwd) })
          const transcript = await this.command(config.executable, ['session', 'info', value.session_id, '--transcript'], this.root, 32 * 1024 * 1024, chunk => parser.push(chunk))
          this.assertWithinDeadline()
          if (transcript.code !== 0 && !transcript.limited) throw new Error('PROVIDER_UNAVAILABLE')
          this.mark('parsing')
          const parsed = parser.finish()
          this.assertWithinDeadline()
          if (parser.identityConflict || (parser.sessionId && parser.sessionId !== value.session_id) || (parser.cwd && await realpath(parser.cwd) !== root)) throw new Error('SOURCE_IDENTITY_CONFLICT')
          if (!parser.sessionId || parser.identityUnavailable) throw new Error('SOURCE_IDENTITY_UNAVAILABLE')
          const sourceObservation = parser.observation(metadata.startedAt, metadata.endedAt)
          if (transcript.limited) {
            sourceObservation.identity = 'UNKNOWN'
            if (sourceObservation.streamTime.windowRelation === 'WITHIN_PROVIDER_WINDOW') sourceObservation.streamTime.windowRelation = 'UNAVAILABLE'
          }
          const coverageReasons: CoverageReasons = { ...parsed.coverageReasons }
          if (transcript.limitReason === 'STDERR_LIMIT') throw new Error('STREAM_UNAVAILABLE')
          if (transcript.limitReason === 'STDOUT_LIMIT') coverageReasons.IMPORT_LIMIT = (coverageReasons.IMPORT_LIMIT ?? 0) + 1
          else if (transcript.limited && !Object.keys(coverageReasons).length) coverageReasons.STREAM_LIMIT = 1
          await this.validate()
          this.assertWithinDeadline()
          this.mark('sqlite-ingest')
          const result = store.ingest({ ...metadata, ...parsed, sourceObservation, importState: 'TRANSCRIPT_IMPORTED', coverageReasons, coverage: transcript.limited ? 'PARTIAL' : parsed.coverage }, parsed.events, () => this.assertWithinDeadline())
          await this.validate()
          this.assertWithinDeadline()
          this.mark('sqlite-maintenance')
          store.maintain()
          return { ...result, imported: 1, lastObserved: new Date().toISOString(), sourceBytes: parsed.sourceBytes, provider: 'entire', provenance: 'OBSERVED_FROM_PROVIDER' }
        }
        if (!store.byProvider(value.session_id)) {
          await this.validate()
          this.assertWithinDeadline()
          store.ingest(metadata, [], () => this.assertWithinDeadline()); imported++
        }
      }
      await this.validate()
      this.assertWithinDeadline()
      store.maintain()
      if (values.length > 500) discoveryReasons.SESSION_LIMIT = values.length - 500
      return { imported, skipped, coverageReasons: discoveryReasons, coverage: skipped || values.length > 500 ? 'PARTIAL' : 'COMPLETE', lastObserved: new Date().toISOString(), provider: 'entire', importMode: 'METADATA_ONLY', transcriptImported: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const allowed = ['STREAM_UNAVAILABLE', 'SOURCE_IDENTITY_CONFLICT', 'SOURCE_IDENTITY_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'SESSION_CONTEXT_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'CAPTURE_NOT_ENABLED', 'PROVIDER_CONFIG_UNSAFE', 'PROVIDER_VERSION_MISMATCH', 'PROVIDER_SCHEMA_UNSUPPORTED', 'IMPORT_LIMIT_REACHED', 'CAPACITY_REACHED', 'SOURCE_PARTIAL_CONFLICT', 'SESSION_UNAVAILABLE', 'PROJECT_CONTEXT_CHANGED', 'WORKTREE_STALE', 'WORKTREE_NOT_DISCOVERED', 'WORKTREE_REPOSITORY_CHANGED', 'WORKTREE_IDENTITY_MISMATCH']
      const coverageReasons: CoverageReasons = message === 'SOURCE_IDENTITY_CONFLICT' || message === 'SOURCE_IDENTITY_UNAVAILABLE' ? { [message]: 1 }
        : message === 'STREAM_UNAVAILABLE' || (this.phase === 'transcript' && message === 'PROVIDER_UNAVAILABLE') ? { STREAM_UNAVAILABLE: 1 } : {}
      return { coverage: 'UNAVAILABLE', importState: known?.importState ?? 'UNKNOWN', coverageReasons, code: allowed.includes(message) ? message : 'PROVIDER_UNAVAILABLE', ...(message === 'PROVIDER_TIMEOUT' ? { phase: this.phase } : {}), lastObserved: new Date().toISOString(), imported: 0 }
    }
  }
}
