import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { stableDestination } from '../../shared/local-mcp-installation.cjs'
import type { LocalMcpAction, LocalMcpClientId, LocalMcpClientState, LocalMcpInstallation, LocalMcpInstallationSnapshot, LocalMcpPreview } from '../../shared/types/local-mcp-client-types'
import { editEntry, readEntry, sameEntry, type McpEntry } from './config-editors'
import { assertProfilePath, assertRevision, assertUserOwned, assertUserOwnedAsync, revision, revisionAsync, type FileRevision } from './safe-config-file'
import { applyFiles, inspectPlugin, preparePlugin, pluginName, type FileChange, type PluginTarget } from './plugin-installation'
import { InstallationRegistry, type InstallationRecord } from './installation-registry'

interface Options {
  home: string
  appData: string
  localAppData: string
  sourceBundle: string
  command: string | null
  profile: string
  packaged: boolean
  launcherEnv?: Record<string, string>
  codexRegister?: (entry: McpEntry) => Promise<McpEntry>
  env?: NodeJS.ProcessEnv
  probe: (command: string, launcher: string, profile: string) => Promise<void>
}
interface Target { id: LocalMcpClientId; name: string; path: string; detected: boolean; toml: boolean; key: string; plugin?: PluginTarget; pluginPeer?: string }
interface Prepared { preview: LocalMcpPreview; target: Target; revision: FileRevision; launcherRevision: FileRevision; sourceRevision: FileRevision; output: string; owner: number; expires: number; steps?: FileChange[] }
const code = (error: unknown) => error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : 'INVALID_CLIENT_CONFIG'

export class LocalMcpClientService {
  private readonly prepared = new Map<string, Prepared>()
  private readonly registry: InstallationRegistry
  private record: InstallationRecord | null = null
  private initialization?: Promise<void>
  private migrationStarted = false
  private queue: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(snapshot: LocalMcpInstallationSnapshot) => void>()
  private current: LocalMcpInstallationSnapshot = { revision: 0, restoration: 'RESTORING', installations: [] }
  readonly launcher: string
  constructor(private readonly options: Options) {
    this.launcher = stableDestination(join(options.localAppData, 'CodeAwareness', 'mcp', 'v1', 'launcher.cjs'))
    this.registry = new InstallationRegistry(options.home, options.profile)
  }
  onSnapshotChanged(listener: (snapshot: LocalMcpInstallationSnapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(restoration: LocalMcpInstallationSnapshot['restoration'], diagnostic?: string) {
    this.current = { revision: this.current.revision + 1, restoration, installations: structuredClone(this.record?.installations ?? []), ...(diagnostic ? { diagnostic } : {}) }
    for (const listener of this.listeners) { try { listener(structuredClone(this.current)) } catch {} }
  }
  private initialize() {
    return this.initialization ??= (async () => {
      try { this.record = (await this.registry.read()).record; this.emit(this.record?.migrationCompleted ? 'READY' : 'RESTORING') }
      catch (error) { this.emit('ERROR', code(error)) }
    })()
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }
  async snapshot(): Promise<LocalMcpInstallationSnapshot> {
    await this.initialize()
    if (!this.record?.migrationCompleted && !this.migrationStarted && this.current.restoration !== 'ERROR') {
      this.migrationStarted = true
      void this.serialize(async () => {
        const latest = (await this.registry.read()).record
        if (latest?.migrationCompleted) { this.record = latest; this.emit('READY'); return }
        await this.persist(await this.inspectAll(), 'MANAGED_ENTRY', true)
      }).catch(error => this.emit('ERROR', code(error)))
    }
    return structuredClone(this.current)
  }
  private async persist(states: LocalMcpClientState[], evidence: LocalMcpInstallation['evidence'], migrationCompleted = false, migratedId?: LocalMcpClientId) {
    const changes: LocalMcpInstallation[] = []
    for (const state of states) {
      const previous = this.record?.installations.find(row => row.id === state.id)
      const base = { id: state.id, mechanism: state.mechanism ?? 'CONFIG_FALLBACK', ...(previous?.installationEvidence ? { installationEvidence: previous.installationEvidence } : {}) } as LocalMcpInstallation
      if (state.configuration === 'INSTALLED') {
        const proof = evidence === 'APPLY_CONNECT' || evidence === 'APPLY_REPAIR' ? evidence : 'MANAGED_ENTRY'
        changes.push({ ...base, state: 'CONFIGURED', evidence: proof, installationEvidence: base.installationEvidence ?? proof })
      } else if (evidence === 'APPLY_DISCONNECT' && state.configuration === 'ABSENT') changes.push({ ...base, state: 'REMOVED', evidence })
      else if (state.configuration === 'ERROR' || state.configuration === 'CONFLICT' || previous?.state === 'CONFIGURED' || previous?.state === 'NEEDS_ATTENTION') {
        changes.push({ ...base, state: 'NEEDS_ATTENTION', evidence: state.configuration === 'ABSENT' ? 'CONFIG_ABSENT' : state.configuration === 'CONFLICT' ? 'CONFIG_DIVERGENT' : 'READ_INCONCLUSIVE' })
      }
    }
    if (migratedId) {
      const previous = this.record?.installations.find(row => row.id === migratedId)
      if (previous) changes.push({ ...previous, state: 'REMOVED', evidence: 'APPLY_MIGRATION' })
    }
    try {
      this.record = await this.registry.update(changes, migrationCompleted)
      this.emit(this.record.migrationCompleted ? 'READY' : 'RESTORING')
      states.forEach(state => { state.persistence = 'SAVED' })
    } catch {
      this.emit('ERROR', 'PERSISTENCE_FAILED')
      states.forEach(state => { state.persistence = 'FAILED'; state.diagnostic = 'PERSISTENCE_FAILED' })
    }
  }
  private targets(): Target[] {
    const { home, appData, env = process.env } = this.options
    const cline = env.CLINE_MCP_SETTINGS_PATH || join(env.CLINE_DATA_DIR || join(env.CLINE_DIR || join(home, '.cline'), 'data'), 'settings', 'cline_mcp_settings.json')
    const vscode = join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
    const antigravity = join(home, '.gemini', 'config', 'plugins', pluginName, 'plugin.json')
    const clinePlugin = join(home, '.agents', 'plugins', pluginName, 'plugin.json')
    const legacyAg = join(home, '.gemini', 'config', 'mcp_config.json')
    return [
      { id: 'codex', name: 'Codex', path: join(home, '.codex', 'config.toml'), detected: existsSync(join(home, '.codex')), toml: true, key: 'code_awareness_local' },
      { id: 'antigravity', name: 'Antigravity 2.0 · plugin', path: antigravity, detected: existsSync(join(home, '.gemini')), toml: false, key: pluginName, plugin: { path: antigravity, legacy: legacyAg, cline: false } },
      { id: 'antigravity-settings', name: 'IDE · configuração (fallback)', path: legacyAg, detected: existsSync(legacyAg), toml: false, key: pluginName, pluginPeer: antigravity },
      { id: 'cline', name: 'Desktop · Agent Plugin v1', path: clinePlugin, detected: existsSync(join(home, '.cline')), toml: false, key: pluginName, plugin: { path: clinePlugin, legacy: cline, cline: true } },
      { id: 'cline-settings', name: 'Desktop · configuração (fallback)', path: cline, detected: existsSync(cline), toml: false, key: pluginName, pluginPeer: clinePlugin },
      { id: 'cline-vscode', name: 'Cline · VS Code', path: vscode, detected: existsSync(vscode), toml: false, key: 'code-awareness-local' }
    ]
  }
  private target(id: LocalMcpClientId) {
    const target = this.targets().find(item => item.id === id)
    if (!target) throw new Error('UNKNOWN_CLIENT')
    return target
  }
  private desired(target: Target): McpEntry {
    if (!this.options.command || !isAbsolute(this.options.command) || !existsSync(this.options.command)) throw new Error('NODE_RUNTIME_UNAVAILABLE')
    if (this.options.packaged) {
      if (this.options.launcherEnv?.ELECTRON_RUN_AS_NODE !== '1') throw new Error('PACKAGED_NODE_RUNTIME_UNSUPPORTED')
      stableDestination(this.options.command)
    }
    const canonical = resolve(this.options.profile).toLowerCase() === resolve(this.options.appData, 'code-awareness').toLowerCase()
    return { command: this.options.command, args: canonical ? [this.launcher] : [this.launcher, '--profile', this.options.profile],
      ...(this.options.launcherEnv ? { env: this.options.launcherEnv } : {}),
      ...(target.plugin || !target.id.startsWith('cline') ? {} : { disabled: false, autoApprove: [] }) }
  }
  private read(target: Target) {
    assertProfilePath(target.path, this.options.home)
    assertUserOwned(target.path)
    const file = revision(target.path)
    return { file, entry: readEntry(file.content, target.toml, target.key) }
  }
  private legacyAlias(target: Target, content: string | null): { output: string | null; migration: boolean } {
    const alias = target.key === 'code_awareness_local' ? 'code-awareness-local' : 'code_awareness_local'
    const entry = readEntry(content, target.toml, alias) as McpEntry | undefined
    if (entry === undefined) return { output: content, migration: false }
    if (!entry || !Array.isArray(entry.args) || entry.args[0] !== this.launcher) throw new Error('LEGACY_ENTRY_OWNERSHIP_UNVERIFIED')
    return { output: editEntry(content, target.toml, alias, undefined), migration: true }
  }
  private async inspectAll() {
    const states: LocalMcpClientState[] = []
    for (const target of this.targets()) states.push(await this.inspect(target))
    return states
  }
  async detect(): Promise<LocalMcpClientState[]> {
    await this.initialize()
    return this.serialize(async () => {
      const states = await this.inspectAll()
      await this.persist(states, 'MANAGED_ENTRY', true)
      return states
    })
  }
  private async inspect(target: Target): Promise<LocalMcpClientState> {
    const state: LocalMcpClientState = { id: target.id, name: target.name, path: target.path, detected: target.detected,
      configuration: 'ABSENT', launcherPresent: false, bootstrap: 'NOT_CHECKED', clientUse: 'NOT_CONFIRMED', recognition: 'NOT_CONFIRMED', reconnection: 'NOT_CONFIRMED',
      mechanism: target.plugin ? 'PLUGIN' : target.id === 'codex' && this.options.codexRegister ? 'CODEX_CLI' : 'CONFIG_FALLBACK' }
    try {
      assertProfilePath(this.launcher, this.options.home)
      state.launcherPresent = existsSync(this.launcher)
      if (!target.detected) { state.configuration = 'UNSUPPORTED'; state.diagnostic = 'CLIENT_PROFILE_NOT_IDENTIFIED'; return state }
      if (target.plugin) {
        const plan = await inspectPlugin(target.plugin, this.desired(target), this.options.home)
        state.configuration = plan.configured && !plan.migration ? 'INSTALLED' : existsSync(target.path) || plan.migration ? 'CONFLICT' : 'ABSENT'
        if (plan.migration) state.diagnostic = 'LEGACY_MIGRATION_AVAILABLE'
      } else {
        assertProfilePath(target.path, this.options.home); await assertUserOwnedAsync(target.path)
        const file = await revisionAsync(target.path), entry = readEntry(file.content, target.toml, target.key)
        const alias = this.legacyAlias(target, file.content)
        state.configuration = entry === undefined ? 'ABSENT' : sameEntry(entry, this.desired(target)) ? 'INSTALLED' : 'CONFLICT'
        if (alias.migration) {
          const aliasKey = target.key === 'code_awareness_local' ? 'code-awareness-local' : 'code_awareness_local'
          state.configuration = entry === undefined && sameEntry(readEntry(file.content, target.toml, aliasKey), this.desired(target)) ? 'INSTALLED' : 'CONFLICT'
          state.diagnostic = 'LEGACY_MIGRATION_AVAILABLE'
        }
        if (target.pluginPeer && existsSync(target.pluginPeer)) { state.configuration = 'UNSUPPORTED'; state.diagnostic = 'PLUGIN_ALREADY_INSTALLED' }
      }
      if (state.configuration === 'INSTALLED' && !state.launcherPresent) state.diagnostic = 'LAUNCHER_UNAVAILABLE'
    } catch (error) { state.configuration = 'ERROR'; state.diagnostic = code(error) }
    return state
  }
  async verify(id: LocalMcpClientId): Promise<LocalMcpClientState> {
    await this.initialize()
    return this.serialize(async () => {
      const state = await this.verifyNow(id)
      await this.persist([state], 'MANAGED_ENTRY')
      return state
    })
  }
  private async verifyNow(id: LocalMcpClientId): Promise<LocalMcpClientState> {
    const state = await this.inspect(this.target(id))
    if (state.configuration !== 'INSTALLED') return state
    if (!state.launcherPresent) { state.diagnostic = 'LAUNCHER_UNAVAILABLE'; return state }
    try { await this.options.probe(this.options.command!, this.launcher, this.options.profile); state.bootstrap = 'RESPONDS' }
    catch (error) { state.bootstrap = 'ERROR'; state.diagnostic = code(error) }
    return state
  }
  async preview(id: LocalMcpClientId, action: LocalMcpAction, owner = 0): Promise<LocalMcpPreview> {
    if (!['connect', 'repair', 'disconnect'].includes(action)) throw new Error('INVALID_ACTION')
    const target = this.target(id)
    if (!target.detected) throw new Error('CLIENT_PROFILE_NOT_IDENTIFIED')
    const desired = this.desired(target)
    if (target.pluginPeer && existsSync(target.pluginPeer)) throw new Error('PLUGIN_ALREADY_INSTALLED')
    const plugin = target.plugin ? preparePlugin(target.plugin, desired, this.options.home, action === 'disconnect') : undefined
    const { file, entry } = target.plugin ? { file: revision(target.path), entry: undefined } : this.read(target)
    const alias = target.plugin ? { output: file.content, migration: false } : this.legacyAlias(target, file.content)
    const matches = sameEntry(entry, desired)
    const owned = !!entry && typeof entry === 'object' && Array.isArray((entry as McpEntry).args) && (entry as McpEntry).args[0] === this.launcher
    if (action === 'disconnect' && entry !== undefined && !owned) throw new Error('ENTRY_OWNERSHIP_UNVERIFIED')
    const output = plugin ? '' : action === 'disconnect' ? entry === undefined ? alias.output ?? '' : editEntry(alias.output, target.toml, target.key, undefined) : matches ? alias.output! : editEntry(alias.output, target.toml, target.key, desired)
    assertProfilePath(this.launcher, this.options.home)
    assertUserOwned(this.launcher)
    const sourceRevision = revision(this.options.sourceBundle)
    if (sourceRevision.content === null) throw new Error('LAUNCHER_BUNDLE_UNAVAILABLE')
    const launcherRevision = revision(this.launcher)
    const preview: LocalMcpPreview = { token: randomUUID(), client: id, path: target.path, action,
      before: entry === undefined ? 'Nenhuma entrada' : matches ? JSON.stringify(desired, null, 2) : 'Entrada existente divergente (conteúdo privado omitido)',
      after: action === 'disconnect' ? 'Remover somente a entrada Code Awareness' : JSON.stringify(desired, null, 2),
      conflict: entry !== undefined && !matches && action !== 'disconnect', changes: output !== (file.content ?? '') || action !== 'disconnect' && sourceRevision.hash !== launcherRevision.hash,
      launcherPath: this.launcher, restartRequired: true }
    if (plugin) {
      preview.before = plugin.migration ? 'Entrada legada gerenciada: migrar sem duplicar o servidor' : plugin.configured ? 'Plugin gerenciado instalado' : 'Plugin ausente'
      preview.after = action === 'disconnect' ? 'Remover somente os arquivos do plugin gerenciado e a entrada legada gerenciada, se presente' : `Instalar plugin local em ${target.path}${plugin.migration ? ' e remover somente a entrada legada gerenciada' : ''}`
      preview.conflict = false
      preview.migration = plugin.migration
      preview.changes = plugin.changes || action !== 'disconnect' && sourceRevision.hash !== launcherRevision.hash
    }
    preview.mechanism = target.plugin ? 'PLUGIN' : id === 'codex' && this.options.codexRegister ? 'CODEX_CLI' : 'CONFIG_FALLBACK'
    if (alias.migration) {
      preview.migration = true
      preview.before = 'Entrada gerenciada com nome legado: migrar sem duplicar o servidor'
    }
    for (const [key, value] of this.prepared) if (value.expires < Date.now() || this.prepared.size >= 32) this.prepared.delete(key)
    this.prepared.set(preview.token, { preview, target, revision: file, launcherRevision, sourceRevision, output, owner, expires: Date.now() + 300000, steps: plugin?.steps })
    return preview
  }
  async apply(token: string, confirmed: boolean, replaceConflict: boolean, owner = 0): Promise<LocalMcpClientState> {
    await this.initialize()
    return this.serialize(async () => {
      await this.registry.read()
      const pending = this.prepared.get(token)
      const state = await this.applyNow(token, confirmed, replaceConflict, owner)
      const migratedId = pending?.preview.migration && pending.target.plugin ? pending.target.id === 'antigravity' ? 'antigravity-settings' : 'cline-settings' : undefined
      await this.persist([state], pending!.preview.action === 'disconnect' ? 'APPLY_DISCONNECT' : pending!.preview.action === 'repair' ? 'APPLY_REPAIR' : 'APPLY_CONNECT', false, migratedId)
      return state
    })
  }
  private async applyNow(token: string, confirmed: boolean, replaceConflict: boolean, owner: number): Promise<LocalMcpClientState> {
    const pending = this.prepared.get(token)
    if (!confirmed || !pending || pending.owner !== owner || pending.expires < Date.now()) throw new Error('CONFIRMATION_REQUIRED')
    if (pending.preview.conflict && !replaceConflict) throw new Error('EXPLICIT_CONFLICT_CHOICE_REQUIRED')
    this.prepared.delete(token)
    const { target, preview } = pending
    const desired = this.desired(target)
    if (target.pluginPeer && existsSync(target.pluginPeer)) throw new Error('PLUGIN_ALREADY_INSTALLED')
    if (target.id === 'codex' && preview.action !== 'disconnect' && preview.changes && this.options.codexRegister) {
      if (!sameEntry(await this.options.codexRegister(desired), desired)) throw new Error('CODEX_REGISTRATION_MISMATCH')
    }
    assertProfilePath(target.path, this.options.home)
    assertUserOwned(target.path)
    assertRevision(target.path, pending.revision)
    assertRevision(this.launcher, pending.launcherRevision)
    assertRevision(this.options.sourceBundle, pending.sourceRevision)
    if (!preview.changes) return this.inspect(target)
    const steps = pending.steps ?? [{ path: target.path, before: pending.revision, after: pending.output }]
    applyFiles([...(preview.action === 'disconnect' ? [] : [{ path: this.launcher, before: pending.launcherRevision, after: pending.sourceRevision.content }]), ...steps], this.options.home)
    return this.inspect(target)
  }
}
