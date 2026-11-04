import { lstat, realpath, mkdtemp, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CodexArchiveReadiness, CodexArchiveState } from '../../shared/types/codex-archive-types'
import type { AuthorizedCodexArchiveConnection } from './codex-archive'
import { CodexStdio, spawnCodex, codexCommand, type CodexProfile } from './codex-stdio'
import { digest } from './privacy'

interface Capabilities { version: string; supports: { archived: boolean; cwd: boolean; stateDbOnly: boolean } }
interface Transport { request: CodexStdio['request']; initialized(): void; close(): void }
interface Options {
  repositoryId: string; root: string; isCurrent: () => boolean
  changed: (connection: AuthorizedCodexArchiveConnection | undefined, readiness: CodexArchiveReadiness) => void
  approveProfile: (profile: CodexProfile) => Promise<boolean>
  approveAccount: (identity: string) => Promise<boolean>
  probe?: (profile: CodexProfile, signal: AbortSignal) => Promise<Capabilities>
  connect?: (profile: CodexProfile, invalidated: () => void) => Transport
}
async function identity(profile: CodexProfile): Promise<string> {
  try {
    if (!isAbsolute(profile.executable) || !isAbsolute(profile.directory) || /^[\\/]{2}/.test(profile.executable) || /^[\\/]{2}/.test(profile.directory) || (process.platform === 'win32' && !profile.executable.toLowerCase().endsWith('.exe'))) throw new Error('EXECUTABLE_UNAVAILABLE')
    const [exe, directory] = await Promise.all([lstat(profile.executable), lstat(profile.directory)])
    if (!exe.isFile() || exe.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink()) throw new Error('EXECUTABLE_UNAVAILABLE')
    return digest(JSON.stringify([await realpath(profile.executable), exe.dev, exe.ino, exe.size, exe.mtimeMs, exe.ctimeMs, await realpath(profile.directory), directory.dev, directory.ino]))
  } catch { throw new Error('EXECUTABLE_UNAVAILABLE') }
}
function schemaType(value: unknown, type: string): boolean {
  if (!value || typeof value !== 'object') return false
  const schema = value as { type?: unknown; anyOf?: unknown }
  return schema.type === type || Array.isArray(schema.type) && schema.type.includes(type) || Array.isArray(schema.anyOf) && schema.anyOf.some(item => schemaType(item, type))
}
export async function probeCodexArchive(profile: CodexProfile, root: string, signal: AbortSignal, command = codexCommand): Promise<Capabilities> {
  const text = await command(profile, ['--version'], root, signal)
  const version = /^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?)/.exec(text.trim())?.[1]
  if (!version) throw new Error('PROTOCOL_UNSUPPORTED')
  const directory = await mkdtemp(join(tmpdir(), 'code-awareness-codex-schema-'))
  try {
    await command(profile, ['app-server', 'generate-json-schema', '--out', directory], root, signal)
    for (const candidate of [join(directory, 'v2', 'ThreadListParams.json'), join(directory, 'ThreadListParams.json')]) {
      try {
        const stat = await lstat(candidate)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) continue
        const schema = JSON.parse(await readFile(candidate, 'utf8')), props = schema.properties
        if (schemaType(props?.archived, 'boolean') && schemaType(props?.cwd, 'string') && schemaType(props?.useStateDbOnly, 'boolean')) return { version, supports: { archived: true, cwd: true, stateDbOnly: true } }
      } catch {}
    }
    throw new Error('PROTOCOL_UNSUPPORTED')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
function account(value: unknown): string {
  if (!value || typeof value !== 'object' || !('account' in value)) throw new Error('ACCOUNT_IDENTITY_UNAVAILABLE')
  const a = (value as { account?: { type?: string; email?: string; id?: string } }).account
  const id = a?.id ?? (a?.type === 'chatgpt' ? a.email : undefined)
  if (a?.type !== 'chatgpt' || typeof id !== 'string' || !id || id.length > 320 || /[\r\n\x00-\x1f]/.test(id)) throw new Error('ACCOUNT_IDENTITY_UNAVAILABLE')
  return a!.type + ':' + id
}
export class CodexArchiveBridge {
  private epoch = 0
  private abort?: AbortController
  private transport?: Transport
  private connection?: AuthorizedCodexArchiveConnection
  private readiness: CodexArchiveReadiness = { state: 'NOT_CONFIGURED' }
  constructor(private readonly options: Options) {}
  inspect(): CodexArchiveReadiness { return { ...this.readiness } }
  private publish(state: CodexArchiveState, version?: string): CodexArchiveReadiness {
    this.readiness = { state, ...(version ? { version } : {}) }
    this.options.changed(this.connection, this.inspect()); return this.inspect()
  }
  disable(state: CodexArchiveState = 'NOT_CONFIGURED'): CodexArchiveReadiness {
    this.epoch++; this.abort?.abort(); this.abort = undefined
    const transport = this.transport; this.transport = undefined; this.connection = undefined; transport?.close()
    return this.publish(state)
  }
  async enable(profile: CodexProfile): Promise<CodexArchiveReadiness> {
    this.disable('UNAUTHORIZED')
    const epoch = this.epoch, abort = new AbortController(); this.abort = abort
    let ownedTransport: Transport | undefined
    const active = () => { if (!this.options.isCurrent() || epoch !== this.epoch || abort.signal.aborted) throw new Error('UNAUTHORIZED') }
    try {
      active()
      if (!await this.options.approveProfile(profile)) return this.inspect()
      active(); this.publish('CONNECTING')
      const pin = await identity(profile)
      active()
      const capabilities = await (this.options.probe?.(profile, abort.signal) ?? probeCodexArchive(profile, this.options.root, abort.signal))
      active()
      if (!capabilities.version || !capabilities.supports.archived || !capabilities.supports.cwd || !capabilities.supports.stateDbOnly) throw new Error('PROTOCOL_UNSUPPORTED')
      if (await identity(profile) !== pin) throw new Error('EXECUTABLE_UNAVAILABLE')
      active()
      const invalidated = () => { if (epoch === this.epoch) this.disable('PROVIDER_UNREACHABLE') }
      const transport = this.options.connect?.(profile, invalidated) ?? new CodexStdio(spawnCodex(profile, ['app-server'], this.options.root), invalidated)
      ownedTransport = transport
      this.transport = transport
      const initialized = await transport.request('initialize', { clientInfo: { name: 'code_awareness_archive', title: 'Code Awareness Archive Metadata', version: '1.0.0' } }, abort.signal)
      active()
      if (!initialized || typeof initialized !== 'object' || !('userAgent' in initialized) || typeof initialized.userAgent !== 'string' || !initialized.userAgent.includes(capabilities.version)) throw new Error('PROTOCOL_UNSUPPORTED')
      transport.initialized()
      const readAccount = async (signal: AbortSignal) => account(await transport.request('account/read', { refreshToken: false }, signal))
      const observedAccount = await readAccount(abort.signal)
      active()
      if (!await this.options.approveAccount(observedAccount)) throw new Error('UNAUTHORIZED')
      active()
      const profileIdentity = await realpath(profile.directory)
      const authorizedRoot = await realpath(this.options.root)
      if (await identity(profile) !== pin) throw new Error('EXECUTABLE_UNAVAILABLE')
      active()
      this.connection = { repositoryId: this.options.repositoryId, accountIdentity: digest(JSON.stringify([profileIdentity, observedAccount])), version: capabilities.version, supports: { archived: true, cwd: true },
        request: async (method, params, signal) => {
          active()
          if (method !== 'thread/list' || params.archived !== true || params.cwd !== authorizedRoot || !Number.isSafeInteger(params.limit) || params.limit > 20 || params.limit < 1 || (params.cursor?.length ?? 0) > 512 || Object.keys(params).some(key => !['archived', 'cwd', 'limit', 'cursor'].includes(key))) throw new Error('PROTOCOL_UNSUPPORTED')
          try {
            if (await identity(profile) !== pin || await readAccount(signal) !== observedAccount) throw new Error('ACCOUNT_IDENTITY_UNAVAILABLE')
            const result = await transport.request('thread/list', { ...params, useStateDbOnly: true }, signal)
            active()
            if (await identity(profile) !== pin || await readAccount(signal) !== observedAccount) throw new Error('ACCOUNT_IDENTITY_UNAVAILABLE')
            active(); if (signal.aborted) throw new Error('PROVIDER_UNREACHABLE')
            return result
          } catch (error) {
            if (epoch === this.epoch) this.disable(error instanceof Error && error.message === 'ACCOUNT_IDENTITY_UNAVAILABLE' ? 'ACCOUNT_IDENTITY_UNAVAILABLE' : 'PROVIDER_UNREACHABLE')
            throw error
          }
        } }
      return this.publish('READY', capabilities.version)
    } catch (error) {
      if (epoch !== this.epoch) { ownedTransport?.close(); return this.inspect() }
      const state = error instanceof Error && ['UNAUTHORIZED', 'EXECUTABLE_UNAVAILABLE', 'PROTOCOL_UNSUPPORTED', 'ACCOUNT_IDENTITY_UNAVAILABLE'].includes(error.message) ? error.message as CodexArchiveState : 'PROVIDER_UNREACHABLE'
      return this.disable(state)
    }
  }
}
