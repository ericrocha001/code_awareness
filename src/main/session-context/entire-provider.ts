import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { sourceTimestamp as date } from './source-time'
import { digest } from './privacy'
import { entireAgent, supportsEntireMetadata } from './entire-schema'
import { parseEntireAgentList, type EntireCapture } from './entire-integrations'
import { checkpointTranscriptSource } from './checkpoint-transcript'
import { withParser } from 'stream-json/streamers/StreamArray'
import { EntireTranscriptStream, ENTIRE_TRANSCRIPT_NORMALIZERS, normalizeEntireRecord, type ReferencedEvent } from './entire-transcript'
import { localEntireSource, entireFileIdentity, readEntireField, type EntireSource } from './entire-source'
import { readLiteralPage, type OpenLiteralBody } from './literal-reader'
import type { ReferenceSource } from './session-references'
import type { TranscriptField } from './entire-transcript'
import type { SessionStore } from './store'
import type { SessionInput, SessionRow, CoverageReasons, EventRow } from './types'
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
  let consumerError: Error | undefined
  const cancel = () => { limited = true; child.kill() }
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { timedOut = true; cancel() }, Math.max(1, Math.min(10_000, timeoutMs)))
  child.stdout.on('data', (chunk: Buffer) => {
    if (limited) return
    bytes += chunk.length
    if (bytes > limit) { limitReason = 'STDOUT_LIMIT'; limited = true; child.kill(); return }
    try {
      if (consume && !consume(chunk)) { limitReason = 'CONSUMER_LIMIT'; limited = true; child.kill(); return }
    } catch (error) { consumerError = error instanceof Error ? error : new Error('STREAM_UNAVAILABLE'); limited = true; child.kill(); return }
    if (!consume) text += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) { limitReason ??= 'STDERR_LIMIT'; limited = true; child.kill() } })
  child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new Error('PROVIDER_UNAVAILABLE')) })
  child.once('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (consumerError) reject(consumerError); else resolve({ code: code ?? -1, text, limited, ...(limitReason ? { limitReason } : {}), ...(timedOut ? { timedOut } : {}) }) })
})
async function smallJson(path: string): Promise<Record<string, unknown>> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error('PROVIDER_CONFIG_UNSAFE')
  return JSON.parse(await readFile(path, 'utf8'))
}
function validSession(value: unknown): value is ProviderSession {
  if (!value || typeof value !== 'object') return false
  const v = value as ProviderSession
  return typeof v.session_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v.session_id) && typeof v.agent === 'string' && /^[A-Za-z][A-Za-z0-9 _-]{0,79}$/.test(v.agent) && typeof v.status === 'string' && typeof v.worktree_path === 'string'
}

export class EntireProvider {
  private pending?: { key: string; task: Promise<object> }
  private deadline = 0
  private phase = 'preflight'
  constructor(private readonly store: SessionStore | Pick<SessionStore, 'path' | 'repositoryId'>, private readonly root: string, private readonly assertActive: () => void, private readonly run: CommandRunner = runReadOnly,
    private readonly validateTarget: () => Promise<void> = async () => {},
    private readonly observePhase: (phase: string) => void = () => {},
    private readonly targetIdentity?: { worktreeId: string; generation: string }) {}
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
  refresh(sessionId?: string, options: { migrateReferences?: boolean } = {}): Promise<object> {
    this.assertActive()
    const key = (sessionId ?? 'discovery') + (options.migrateReferences ? ':migrate-references' : '')
    if (this.pending) return this.pending.key === key ? this.pending.task : Promise.resolve({ coverage: 'PARTIAL', code: 'BACKPRESSURE' })
    const task = this.perform(sessionId, options.migrateReferences).finally(() => { this.pending = undefined })
    this.pending = { key, task }
    return task
  }
  private async preflight(live = false, reuseExecutable = false): Promise<ProviderConfig> {
    let config: ProviderConfig
    try { config = await smallJson(join(dirname(this.store.path), 'session-context.provider.json')) as unknown as ProviderConfig }
    catch { throw new Error('PROVIDER_UNAVAILABLE') }
    if (config.enabled !== true || config.repositoryId !== this.store.repositoryId) throw new Error('CAPTURE_NOT_ENABLED')
    if (!isAbsolute(config.executable) || !/^entire(?:\.exe)?$/i.test(basename(config.executable)) || !/^[a-f0-9]{64}$/.test(config.sha256) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(config.version)) throw new Error('PROVIDER_CONFIG_UNSAFE')
    const executable = await realpath(config.executable)
    const executableStat = await lstat(executable, { bigint: true })
    if (!executableStat.isFile() || executableStat.size > 256 * 1024 * 1024) throw new Error('PROVIDER_CONFIG_UNSAFE')
    const signature = [executableStat.dev, executableStat.ino, executableStat.size, executableStat.mtimeNs, executableStat.ctimeNs, config.sha256, config.version].join(':')
    const capabilityKey = executable + (live ? ':live' : ':references')
    const verified = (live || reuseExecutable) && verifiedLiveExecutables.get(capabilityKey) === signature
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
      if (live || reuseExecutable) {
        if (signature !== [await executableIdentity(executable), config.sha256, config.version].join(':')) throw new Error('PROVIDER_VERSION_MISMATCH')
        if (verifiedLiveExecutables.size >= 16) verifiedLiveExecutables.clear()
        verifiedLiveExecutables.set(capabilityKey, signature)
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
    if (!supportsEntireMetadata(config.version)) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
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
  async inspectCapture(): Promise<EntireCapture> {
    this.deadline = Date.now() + 12_000
    let integrations: EntireCapture['integrations']
    try {
      await this.validate()
      const config = await this.preflight(true)
      if (config.version !== '0.12.2') throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
      const agents = await this.command(config.executable, ['agent', 'list'], this.root, 32768)
      if (agents.code !== 0 || agents.limited) throw new Error('INTEGRATION_UNAVAILABLE')
      integrations = parseEntireAgentList(agents.text)
      const help = await this.command(config.executable, ['session', 'current', '--help'], this.root, 16384)
      if (help.code !== 0 || help.limited || !help.text.includes('--json')) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
      const current = await this.command(config.executable, ['session', 'current', '--json'], this.root, 32768)
      if (current.code !== 0 || current.limited) return { configured: true, reason: 'SESSION_UNOBSERVED', integrations }
      let envelope
      try { envelope = JSON.parse(current.text) } catch { return { configured: true, reason: 'SESSION_UNOBSERVED', integrations } }
      if (!['caller-env', 'ancestry'].includes(envelope.resolution)) return { configured: true, reason: 'SESSION_UNOBSERVED', integrations }
      const selected = envelope.session ?? envelope
      const id = selected.session_id
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) return { configured: true, reason: 'SESSION_UNOBSERVED' }
      const output = await this.command(config.executable, ['session', 'info', id, '--json'], this.root, 32768)
      if (output.code !== 0 || output.limited) return { configured: true, reason: 'SESSION_UNOBSERVED' }
      let info
      try { info = JSON.parse(output.text) } catch { return { configured: true, reason: 'SESSION_UNOBSERVED' } }
      if (!validSession(info) || info.session_id !== id || await realpath(info.worktree_path) !== await realpath(this.root)) throw new Error('SOURCE_IDENTITY_CONFLICT')
      const metadata = info as ProviderSession & { turns?: unknown; pending_turns?: unknown }
      const turns = Array.isArray(metadata.turns) ? metadata.turns.length : typeof metadata.turns === 'number' && Number.isSafeInteger(metadata.turns) ? metadata.turns : 0
      const pending = Array.isArray(metadata.pending_turns) ? metadata.pending_turns.length : 0
      await this.validate()
      if (turns <= 0 && pending <= 0) return { configured: true, reason: 'SESSION_UNOBSERVED', integrations }
      return { configured: true, reason: 'CAPTURE_OBSERVED', providerSessionId: id, agent: entireAgent(info.agent), integrations }
    } catch (error) {
      const reason = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'PROVIDER_UNAVAILABLE'
      if (['WORKTREE_STALE', 'PROJECT_CONTEXT_CHANGED', 'SESSION_CONTEXT_TIMEOUT'].includes(reason)) throw error
      return { configured: false, reason, integrations }
    }
  }
  private async perform(sessionId?: string, migrateReferences = false): Promise<object> {
    this.deadline = Date.now() + (sessionId ? 12_000 : 10_000)
    let known: SessionRow | undefined
    try {
      if (!('ingest' in this.store)) throw new Error('SESSION_CONTEXT_UNAVAILABLE')
      const store = this.store
      await this.validate()
      known = sessionId ? store.session(sessionId) : undefined
        if (known?.provider && known.provider !== 'entire') throw new Error('TRANSCRIPT_PROVIDER_UNAVAILABLE')
      this.mark('preflight')
      const config = await this.preflight(false, true)
      if (!supportsEntireMetadata(config.version)) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
      if (!known) return await this.discoverMetadata(store, config)
      const args = known ? ['session', 'info', known.providerSessionId, '--json'] : ['session', 'list', '--json']
      const output = await this.command(config.executable, args, this.root, 1024 * 1024)
      this.assertWithinDeadline()
      if (output.limited || output.code !== 0) {
        if (known && await checkpointTranscriptSource(store, known, (exe, args, cwd, limit, consume) => this.command(exe, args, cwd, limit, consume), this.root, () => this.assertWithinDeadline())) {
          return await this.indexReferences(store, known, { providerSessionId: known.providerSessionId, providerVersion: config.version, agent: known.agent, state: known.state, coverage: known.coverage, sourceDigest: known.sourceDigest, sourceBytes: known.sourceBytes }, config, await realpath(this.root), migrateReferences)
        }
        throw new Error(output.limited ? 'IMPORT_LIMIT_REACHED' : 'PROVIDER_UNAVAILABLE')
      }
      let values: unknown[]
      try { const parsed = JSON.parse(output.text); values = known ? [parsed] : Array.isArray(parsed) ? parsed : (() => { throw new Error() })() }
      catch { throw new Error('PROVIDER_SCHEMA_UNSUPPORTED') }
      let imported = 0, skipped = 0
      const discoveryReasons: CoverageReasons = {}
      const skip = (reason: 'INVALID_SESSION_METADATA' | 'SOURCE_PATH_UNAVAILABLE' | 'FOREIGN_SOURCE') => { skipped++; discoveryReasons[reason] = (discoveryReasons[reason] ?? 0) + 1 }
      const root = await realpath(this.root)
      for (const value of values) {
        if (!validSession(value)) { skip('INVALID_SESSION_METADATA'); continue }
        let observedPath: string
        try { if (!isAbsolute(value.worktree_path)) throw new Error(); observedPath = await realpath(value.worktree_path) } catch { skip('SOURCE_PATH_UNAVAILABLE'); continue }
        if (observedPath !== root || (known && (value.session_id !== known.providerSessionId || entireAgent(value.agent) !== known.agent))) { skip('FOREIGN_SOURCE'); continue }
        const terminal = value.status.toUpperCase() === 'ENDED' && !!date(value.ended_at)
        const metadata: SessionInput = { providerSessionId: value.session_id, providerVersion: config.version, agent: entireAgent(value.agent),
          state: terminal ? 'ENDED' : value.status.toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'UNKNOWN',
          startedAt: date(value.started_at), endedAt: terminal ? date(value.ended_at) : undefined,
          coverage: 'UNAVAILABLE', importState: 'METADATA_ONLY', coverageReasons: { TRANSCRIPT_NOT_IMPORTED: 1 }, sourceDigest: digest(JSON.stringify({ id: value.session_id, status: value.status, ended: value.ended_at })), sourceBytes: 0 }
        if (known) {
          return await this.indexReferences(store, known, metadata, config, root, migrateReferences)
        }
        const existing = store.byProvider(value.session_id, 'entire', metadata.agent)
        if (!existing) {
          await this.validate()
          this.assertWithinDeadline()
          const result = store.ingest(metadata, [], () => this.assertWithinDeadline())
          if (this.targetIdentity) store.observeWorktree(result.sessionId, this.targetIdentity, () => this.assertWithinDeadline())
          imported++
        } else if (this.targetIdentity) {
          await this.validate()
          store.observeWorktree(existing.id, this.targetIdentity, () => this.assertWithinDeadline())
        }
      }
      await this.validate()
      this.assertWithinDeadline()
      store.maintain()
      return { imported, skipped, coverageReasons: discoveryReasons, coverage: skipped ? 'PARTIAL' : 'COMPLETE', lastObserved: new Date().toISOString(), provider: 'entire', importMode: 'METADATA_ONLY', transcriptImported: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const allowed = ['STREAM_UNAVAILABLE', 'SOURCE_IDENTITY_CONFLICT', 'SOURCE_IDENTITY_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'SESSION_CONTEXT_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'TRANSCRIPT_PROVIDER_UNAVAILABLE', 'CAPTURE_NOT_ENABLED', 'PROVIDER_CONFIG_UNSAFE', 'PROVIDER_VERSION_MISMATCH', 'PROVIDER_SCHEMA_UNSUPPORTED', 'IMPORT_LIMIT_REACHED', 'CAPACITY_REACHED', 'SOURCE_PARTIAL_CONFLICT', 'SESSION_UNAVAILABLE', 'SESSION_EVICTED', 'PROJECT_CONTEXT_CHANGED', 'WORKTREE_STALE', 'WORKTREE_NOT_DISCOVERED', 'WORKTREE_REPOSITORY_CHANGED', 'WORKTREE_IDENTITY_MISMATCH', 'LEGACY_MIGRATION_REQUIRED', 'SOURCE_REVISION_CHANGED', 'SOURCE_REFERENCE_REQUIRED']
      const coverageReasons: CoverageReasons = message === 'SOURCE_IDENTITY_CONFLICT' || message === 'SOURCE_IDENTITY_UNAVAILABLE' ? { [message]: 1 }
        : message === 'STREAM_UNAVAILABLE' || (this.phase === 'transcript' && message === 'PROVIDER_UNAVAILABLE') ? { STREAM_UNAVAILABLE: 1 } : {}
      const migrationFailure = ['LEGACY_SOURCE_RECOVERY_REQUIRED', 'LEGACY_SOURCE_IDENTITY_CONFLICT', 'LEGACY_HISTORY_INTEGRITY_ERROR', 'LEGACY_LITERAL_MISMATCH', 'SOURCE_READER_NO_PROGRESS', 'REVISION_CONFLICT'].includes(message)
      return { coverage: 'UNAVAILABLE', importState: known?.importState ?? 'UNKNOWN', coverageReasons, code: allowed.includes(message) || migrationFailure ? message : 'PROVIDER_UNAVAILABLE', ...(message === 'PROVIDER_TIMEOUT' ? { phase: this.phase } : {}), lastObserved: new Date().toISOString(), imported: 0 }
    }
  }
  private async discoverMetadata(store: SessionStore, config: ProviderConfig): Promise<object> {
    const root = await realpath(this.root), stream = withParser()
    let imported = 0, skipped = 0, failure: Error | undefined
    const reasons: CoverageReasons = {}
    const skip = (reason: 'INVALID_SESSION_METADATA' | 'SOURCE_PATH_UNAVAILABLE' | 'FOREIGN_SOURCE') => { skipped++; reasons[reason] = (reasons[reason] ?? 0) + 1 }
    stream.on('error', () => { failure ??= new Error('PROVIDER_SCHEMA_UNSUPPORTED') })
    stream.on('data', ({ value }: { value: unknown }) => {
      if (failure) return
      try {
        this.assertWithinDeadline()
        if (!validSession(value)) { skip('INVALID_SESSION_METADATA'); return }
        let observed: string
        try { if (!isAbsolute(value.worktree_path)) throw new Error(); observed = realpathSync(value.worktree_path) } catch { skip('SOURCE_PATH_UNAVAILABLE'); return }
        if (observed !== root) { skip('FOREIGN_SOURCE'); return }
        const agent = entireAgent(value.agent), existing = store.byProvider(value.session_id, 'entire', agent)
        const terminal = value.status.toUpperCase() === 'ENDED' && !!date(value.ended_at)
        const result = existing ? { sessionId: existing.id } : store.ingest({ providerSessionId: value.session_id, providerVersion: config.version, agent,
          state: terminal ? 'ENDED' : value.status.toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'UNKNOWN', startedAt: date(value.started_at), endedAt: terminal ? date(value.ended_at) : undefined,
          importState: 'METADATA_ONLY', coverage: 'PARTIAL', sourceDigest: digest(JSON.stringify([value.session_id, agent, value.status, value.ended_at])), sourceBytes: 0 }, [], () => this.assertWithinDeadline())
        if (!existing) imported++
        if (this.targetIdentity) store.observeWorktree(result.sessionId, this.targetIdentity, () => this.assertWithinDeadline())
      } catch (error) { failure = error instanceof Error ? error : new Error('PROVIDER_UNAVAILABLE') }
    })
    try {
      const output = await this.command(config.executable, ['session', 'list', '--json'], root, Number.MAX_SAFE_INTEGER, chunk => { if (failure) return false; stream.write(chunk); return !failure })
      if (output.text) stream.write(output.text)
      stream.end()
      if (!stream.readableEnded && !failure) await new Promise<void>(resolve => { stream.once('end', resolve); stream.once('error', () => resolve()) })
      if (failure) throw failure
      if (output.code !== 0 || output.limited) throw new Error('PROVIDER_UNAVAILABLE')
      await this.validate()
      return { imported, skipped, coverageReasons: reasons, coverage: skipped ? 'PARTIAL' : 'COMPLETE', lastObserved: new Date().toISOString(), provider: 'entire', importMode: 'METADATA_ONLY', transcriptImported: false }
    } finally { stream.destroy() }
  }
  private async indexReferences(store: SessionStore, known: SessionRow, metadata: SessionInput, config: ProviderConfig, root: string, migrateReferences = false): Promise<object> {
    if (config.version !== '0.12.2') throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
    if (!Object.hasOwn(ENTIRE_TRANSCRIPT_NORMALIZERS, metadata.agent)) throw new Error('PROVIDER_SCHEMA_UNSUPPORTED')
    const agent = metadata.agent as keyof typeof ENTIRE_TRANSCRIPT_NORMALIZERS
    const source: EntireSource = await localEntireSource(root, known.providerSessionId) ?? await checkpointTranscriptSource(store, known, (exe, args, cwd, limit, consume) => this.command(exe, args, cwd, limit, consume), root, () => this.assertWithinDeadline()) ?? { kind: 'ENTIRE_CLI', agent, providerSessionId: known.providerSessionId }
    if (source.kind !== 'ENTIRE_CHECKPOINT' && this.targetIdentity) source.target = this.targetIdentity
    const runId = store.references.begin(known.id, source, ENTIRE_TRANSCRIPT_NORMALIZERS[agent])
    let pending: ReferencedEvent[] = []
    const flush = () => { if (pending.length) { store.references.append(runId, pending); pending = [] } }
    let identityObserved = agent === 'antigravity'
    const parser = new EntireTranscriptStream(record => {
      const id = record.metadata['payload/id'] ?? record.metadata.thread_id ?? record.metadata.sessionId
      if (id && id !== known.providerSessionId) throw new Error('SOURCE_IDENTITY_CONFLICT')
      if (id === known.providerSessionId) identityObserved = true
      const cwd = record.metadata['payload/cwd'] ?? record.metadata.cwd
      if (cwd && (!isAbsolute(cwd) || realpathSync(cwd) !== root)) throw new Error('SOURCE_IDENTITY_CONFLICT')
      pending.push(...normalizeEntireRecord(agent, record, (id, tool) => store.references.tool(runId, id, tool)))
      if (pending.length >= 256) flush()
    }, undefined, () => this.assertWithinDeadline())
    try {
      if (source.kind === 'ENTIRE_FILE') {
        for await (const chunk of createReadStream(source.path, { highWaterMark: 65536 })) parser.push(chunk)
        if (await entireFileIdentity(source.path) !== source.identity) throw new Error('SOURCE_REVISION_CHANGED')
      } else {
        const output = source.kind === 'ENTIRE_CHECKPOINT'
          ? await this.command('git', ['--no-replace-objects', 'cat-file', '-p', source.blob], root, Number.MAX_SAFE_INTEGER, chunk => parser.push(chunk))
          : await this.command(config.executable, ['session', 'info', known.providerSessionId, '--transcript'], root, Number.MAX_SAFE_INTEGER, chunk => parser.push(chunk))
        if (output.limited || output.code !== 0) throw new Error('STREAM_UNAVAILABLE')
      }
      const parsed = await parser.finish(); flush()
      if (!identityObserved) throw new Error('SOURCE_IDENTITY_UNAVAILABLE')
      await this.validate()
      const finalConfig = await this.preflight(false, true)
      if (finalConfig.sha256 !== config.sha256 || finalConfig.version !== config.version || finalConfig.executable !== config.executable) throw new Error('PROVIDER_VERSION_MISMATCH')
      if (store.references.legacyPayloads(known.id)) {
        if (!migrateReferences) throw new Error('LEGACY_MIGRATION_REQUIRED')
        const candidateSource: ReferenceSource = { locator: source, sourceDigest: parsed.sourceDigest, sourceBytes: parsed.sourceBytes, normalizer: ENTIRE_TRANSCRIPT_NORMALIZERS[agent], revision: known.revision + 1 }
        const verification = await store.references.verifyLegacy(runId, parsed.sourceDigest, async (legacy, candidate, offset) => {
          const id = digest(JSON.stringify([known.id, parsed.sourceDigest, legacy.ordinal]))
          return this.readEvent(known, { ...legacy, id } as EventRow, offset, 8192, { source: candidateSource, fields: candidate.fields })
        }, () => this.assertWithinDeadline(), () => this.deadline - Date.now() < 750)
        if (!verification.complete) { store.references.discard(runId); return { coverage: 'PARTIAL', code: 'LEGACY_MIGRATION_IN_PROGRESS', verified: verification.verified, payloadsPreserved: true } }
      }
      const result = store.references.commit(runId, parsed.sourceDigest, parsed.sourceBytes, () => this.assertWithinDeadline(), parsed.coverage)
      const migration = migrateReferences ? store.references.finalizeLegacySchema(() => this.assertWithinDeadline()) : undefined
      if (this.targetIdentity) store.observeWorktree(result.sessionId, this.targetIdentity, () => this.assertWithinDeadline())
      return { ...result, ...(migration ? { migration } : {}), imported: 1, provider: 'entire', importState: 'TRANSCRIPT_REFERENCED', coverage: 'COMPLETE', transcriptImported: false, sourceBytes: parsed.sourceBytes, peakScalarBytes: parsed.peakScalarBytes, sourceCoverage: 'SOURCE_VERIFIED' }
    } catch (error) { store.references.discard(runId); throw error }
  }
  async readEvent(session: SessionRow, event: EventRow, offset: number, pageBytes = 8192, candidate?: { source: ReferenceSource; fields: TranscriptField[] }): Promise<Awaited<ReturnType<typeof readLiteralPage>>> {
    if (!candidate) this.deadline = Date.now() + 12_000
    if (!('references' in this.store)) throw new Error('SOURCE_UNAVAILABLE')
    const store = this.store, source = candidate?.source ?? store.references.source(session.id), fields = candidate?.fields ?? store.references.fields(event.id)
    if (!source || !fields) throw new Error('SOURCE_UNAVAILABLE')
    await this.validate()
    const config = await this.preflight(false, true)
    const locator = source.locator
    const checkCheckpoint = async () => {
      if (locator.kind !== 'ENTIRE_CHECKPOINT') return
      if (!/^[A-Za-z0-9]{10,40}$/.test(locator.checkpointId) || ![locator.refRevision, locator.blob].every(value => /^[a-f0-9]{40,64}$/.test(value)) || locator.agent !== session.agent || locator.providerSessionId !== session.providerSessionId || !Number.isSafeInteger(locator.sessionIndex) || locator.sessionIndex < 0) throw new Error('SOURCE_IDENTITY_CONFLICT')
      const revision = await this.command('git', ['--no-replace-objects', 'rev-parse', '--verify', 'refs/entire/checkpoints/' + locator.checkpointId.slice(-2) + '/' + locator.checkpointId], this.root, 4096)
      if (revision.code !== 0 || revision.limited || revision.text.trim() !== locator.refRevision) throw new Error('SOURCE_REVISION_CHANGED')
    }
    await checkCheckpoint()
    if (locator.kind === 'ENTIRE_FILE') {
      const sourceRoot = dirname(dirname(dirname(dirname(locator.path))))
      if (join(sourceRoot, '.entire', 'metadata', session.providerSessionId, 'full.jsonl') !== locator.path) throw new Error('SOURCE_IDENTITY_CONFLICT')
      const roots: string[] = []
      for (const root of sourceRoot === await realpath(this.root) ? [] : [this.root, sourceRoot]) {
        const common = await this.command('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--path-format=absolute', '--git-common-dir'], root, 4096)
        if (common.code !== 0 || common.limited) throw new Error('SOURCE_UNAVAILABLE')
        roots.push(await realpath(common.text.trim()))
      }
      if (roots.length && roots[0] !== roots[1]) throw new Error('FOREIGN_SOURCE')
      if (await entireFileIdentity(locator.path) !== locator.identity) throw new Error('SOURCE_REVISION_CHANGED')
    }
    const openBody: OpenLiteralBody = async (consume, start) => {
      if (locator.kind === 'ENTIRE_FILE') {
        const first = start?.fieldIndex ?? 0
        for (let index = first; index < fields.length; index++) {
          const field = fields[index]
          if (index > first && !consume('\n', { fieldIndex: -1, decodedByte: 0, rawByte: 0 })) break
          let decodedByte = index === first ? start?.decodedByte ?? 0 : 0
          if (!consume('', { fieldIndex: index, decodedByte, rawByte: index === first ? start?.rawByte ?? field.startByte : field.startByte })) break
          let keep = true
          for await (const chunk of readEntireField(locator, field, () => this.assertWithinDeadline(), index === first ? start?.rawByte : undefined)) {
            decodedByte += Buffer.byteLength(chunk.text)
            if (!consume(chunk.text, { fieldIndex: index, decodedByte, rawByte: chunk.rawEnd })) { keep = false; break }
          }
          if (!keep) break
        }
        if (await entireFileIdentity(locator.path) !== locator.identity) throw new Error('SOURCE_REVISION_CHANGED')
      } else {
        let currentField = -1, observed = 0
        const stream = new EntireTranscriptStream(() => {}, (position, path, text) => {
          if (position !== event.sourcePosition) return
          const index = fields.findIndex(field => field.path === path)
          if (index < 0) return
          if (index !== currentField) { if (currentField >= 0) consume('\n', { fieldIndex: -1, decodedByte: 0, rawByte: 0 }); currentField = index; observed++ }
          consume(text, { fieldIndex: index, decodedByte: 0, rawByte: 0 })
        }, () => this.assertWithinDeadline())
        const output = locator.kind === 'ENTIRE_CHECKPOINT'
          ? await this.command('git', ['--no-replace-objects', 'cat-file', '-p', locator.blob], this.root, Number.MAX_SAFE_INTEGER, chunk => stream.push(chunk))
          : await this.command(config.executable, ['session', 'info', session.providerSessionId, '--transcript'], this.root, Number.MAX_SAFE_INTEGER, chunk => stream.push(chunk))
        if (output.limited || output.code !== 0) throw new Error('SOURCE_UNAVAILABLE')
        const actual = await stream.finish()
        if (actual.sourceDigest !== source.sourceDigest || observed < fields.filter(field => field.bytes > 0).length) throw new Error('SOURCE_REVISION_CHANGED')
      }
    }
    const result = await readLiteralPage(store.references, event.id, source, fields, offset, openBody, () => this.assertWithinDeadline(), pageBytes)
    if (locator.kind === 'ENTIRE_FILE' && await entireFileIdentity(locator.path) !== locator.identity) throw new Error('SOURCE_REVISION_CHANGED')
    await checkCheckpoint()
    await this.validate()
    const finalConfig = await this.preflight(false, true)
    if (finalConfig.sha256 !== config.sha256 || finalConfig.version !== config.version || finalConfig.executable !== config.executable) throw new Error('PROVIDER_VERSION_MISMATCH')
    return result
  }
}
