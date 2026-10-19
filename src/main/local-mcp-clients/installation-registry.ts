import { join } from 'node:path'
import { LOCAL_MCP_CLIENT_IDS, type LocalMcpInstallation } from '../../shared/types/local-mcp-client-types'
import { assertProfilePath, assertUserOwnedAsync, revisionAsync, writeConfigAsync } from './safe-config-file'

export interface InstallationRecord { schemaVersion: 1; migrationCompleted: boolean; installations: LocalMcpInstallation[] }
const mechanisms = ['PLUGIN', 'CODEX_CLI', 'CONFIG_FALLBACK']
const installationEvidence = ['MANAGED_ENTRY', 'APPLY_CONNECT', 'APPLY_REPAIR']
const evidence = [...installationEvidence, 'APPLY_DISCONNECT', 'APPLY_MIGRATION', 'CONFIG_ABSENT', 'CONFIG_DIVERGENT', 'READ_INCONCLUSIVE']
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (): never => { throw new Error('REGISTRY_INVALID') }

function parse(content: string): InstallationRecord {
  let value: unknown
  try { value = JSON.parse(content) } catch { return invalid() }
  if (!object(value)) return invalid()
  if (value.schemaVersion !== 1) throw new Error('REGISTRY_VERSION_UNSUPPORTED')
  if (Object.keys(value).some(key => !['schemaVersion', 'migrationCompleted', 'installations'].includes(key)) || value.migrationCompleted !== undefined && typeof value.migrationCompleted !== 'boolean' || !Array.isArray(value.installations) || value.installations.length > LOCAL_MCP_CLIENT_IDS.length) return invalid()
  const ids = new Set()
  for (const row of value.installations) {
    if (!object(row) || Object.keys(row).some(key => !['id', 'mechanism', 'state', 'evidence', 'installationEvidence'].includes(key)) ||
      !LOCAL_MCP_CLIENT_IDS.includes(row.id as LocalMcpInstallation['id']) || ids.has(row.id) || !mechanisms.includes(row.mechanism as string) ||
      !['CONFIGURED', 'REMOVED', 'NEEDS_ATTENTION'].includes(row.state as string) || !evidence.includes(row.evidence as string) ||
      row.installationEvidence !== undefined && !installationEvidence.includes(row.installationEvidence as string) || row.state === 'CONFIGURED' && !installationEvidence.includes(row.installationEvidence as string)) return invalid()
    ids.add(row.id)
  }
  return { schemaVersion: 1, migrationCompleted: value.migrationCompleted === true, installations: value.installations as LocalMcpInstallation[] }
}

export class InstallationRegistry {
  readonly path: string
  private existed = false
  constructor(private readonly home: string, profile: string) { this.path = join(profile, 'local-mcp-installations.json') }
  async read() {
    try {
      assertProfilePath(this.path, this.home)
      await assertUserOwnedAsync(this.path)
      const file = await revisionAsync(this.path)
      if (file.content === null && this.existed) throw new Error('REGISTRY_MISSING')
      if (file.content !== null && file.content.length > 32768) return invalid()
      const record = file.content === null ? null : parse(file.content)
      if (record) this.existed = true
      return { file, record }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('REGISTRY_')) throw error
      if (error instanceof Error && ['PROFILE_OWNERSHIP_UNVERIFIED', 'OUTSIDE_USER_PROFILE', 'CONFIG_LINK_NOT_ALLOWED', 'UNSAFE_CONFIG_FILE'].includes(error.message)) throw new Error('REGISTRY_ACCESS_DENIED')
      throw new Error('REGISTRY_READ_FAILED')
    }
  }
  async update(changes: LocalMcpInstallation[], migrationCompleted: boolean) {
    const { file, record } = await this.read()
    const entries = new Map((record?.installations ?? []).map(row => [row.id, row]))
    for (const change of changes) entries.set(change.id, { ...change, ...(change.installationEvidence ? {} : entries.get(change.id)?.installationEvidence ? { installationEvidence: entries.get(change.id)!.installationEvidence } : {}) })
    const next = parse(JSON.stringify({ schemaVersion: 1, migrationCompleted: record?.migrationCompleted || migrationCompleted,
      installations: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)) }))
    if (JSON.stringify(next) !== JSON.stringify(record)) {
      try { await writeConfigAsync(this.path, this.home, file, JSON.stringify(next, null, 2) + '\n') }
      catch (error) { throw new Error(error instanceof Error && error.message === 'CONFIG_REVISION_CONFLICT' ? 'REGISTRY_CONFLICT' : 'PERSISTENCE_FAILED', { cause: error }) }
    }
    this.existed = true
    return next
  }
}
