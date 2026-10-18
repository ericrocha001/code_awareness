import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readEntry, editEntry, sameEntry, type McpEntry } from './config-editors'
import { assertProfilePath, assertRevision, assertUserOwned, removeConfig, revision, writeConfig, type FileRevision } from './safe-config-file'

export const pluginName = 'code-awareness-local'
export interface FileChange { path: string; before: FileRevision; after: string | null }
export interface PluginTarget { path: string; legacy: string; cline: boolean }
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const assertArgument = (value: string) => {
  if (/["\r\n\0]/.test(value)) throw new Error('INVALID_LAUNCHER_PATH')
}

export function pluginFiles(target: PluginTarget, entry: McpEntry): Record<string, string> {
  const manifest = target.cline
    ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: pluginName }
    : { name: pluginName, description: 'Code Awareness MCP Local' }
  if (!target.cline) return { 'plugin.json': json(manifest), 'mcp_config.json': json({ mcpServers: { [pluginName]: entry } }) }
  if (Object.keys(entry.env ?? {}).some(key => key !== 'ELECTRON_RUN_AS_NODE') || entry.env?.ELECTRON_RUN_AS_NODE && entry.env.ELECTRON_RUN_AS_NODE !== '1') throw new Error('INVALID_LAUNCHER_ENV')
  if (!(entry.args.length === 1 || entry.args.length === 3 && entry.args[1] === '--profile')) throw new Error('INVALID_LAUNCHER_ARGUMENTS')
  ;[entry.command, ...entry.args].forEach(assertArgument)
  // The portable contract requires a plugin-relative executable. No caller arguments enter this fixed Windows shim.
  const shim = ['@echo off', 'setlocal DisableDelayedExpansion',
    `"%CODE_AWARENESS_RUNTIME%" "%CODE_AWARENESS_LAUNCHER%"${entry.args.length === 3 ? ' --profile "%CODE_AWARENESS_PROFILE%"' : ''}`, ''].join('\r\n')
  return { 'plugin.json': json(manifest), 'mcp.json': json({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { [pluginName]: { type: 'stdio', command: './launch.cmd', args: [], env: { ...entry.env,
      CODE_AWARENESS_RUNTIME: entry.command, CODE_AWARENESS_LAUNCHER: entry.args[0], ...(entry.args.length === 3 ? { CODE_AWARENESS_PROFILE: entry.args[2] } : {}) } } } }), 'launch.cmd': shim }
}

function read(path: string, home: string) {
  assertProfilePath(path, home); assertUserOwned(path)
  return revision(path)
}

export function preparePlugin(target: PluginTarget, entry: McpEntry, home: string, disconnect: boolean) {
  const root = dirname(target.path)
  const files = pluginFiles(target, entry)
  assertProfilePath(root, home); assertUserOwned(root)
  if (existsSync(root) && readdirSync(root).some(name => !(name in files))) throw new Error('PLUGIN_OWNERSHIP_UNVERIFIED')
  const snapshots = Object.keys(files).map(name => ({ path: join(root, name), before: read(join(root, name), home), after: disconnect ? null : files[name] }))
  const manifest = snapshots[0]
  if (manifest.before.content !== null && manifest.before.content !== files['plugin.json']) throw new Error('PLUGIN_OWNERSHIP_UNVERIFIED')
  const component = snapshots.find(row => row.path.endsWith(target.cline ? 'mcp.json' : 'mcp_config.json'))!
  if (component.before.content !== null) {
    const existing = readEntry(component.before.content, false, pluginName)
    const expected = readEntry(files[target.cline ? 'mcp.json' : 'mcp_config.json'], false, pluginName)
    const parsed = JSON.parse(component.before.content)
    if (Object.keys(parsed.mcpServers ?? {}).some(key => key !== pluginName) || Object.keys(parsed).some(key => !['$schema', 'mcpServers'].includes(key))) throw new Error('PLUGIN_OWNERSHIP_UNVERIFIED')
    if (!sameEntry(existing, expected as McpEntry)) throw new Error('PLUGIN_OWNERSHIP_UNVERIFIED')
  }
  const shim = snapshots.find(row => row.path.endsWith('launch.cmd'))
  if (shim?.before.content !== null && shim?.before.content !== undefined && shim.before.content !== files['launch.cmd']) throw new Error('PLUGIN_OWNERSHIP_UNVERIFIED')
  const legacy = read(target.legacy, home)
  const keys = ['code-awareness-local', 'code_awareness_local']
  let legacyOutput = legacy.content
  let migration = false
  for (const key of keys) {
    const old = readEntry(legacyOutput, false, key)
    if (old === undefined) continue
    const value = old as McpEntry
    if (!value || !Array.isArray(value.args) || value.args[0] !== entry.args[0] || Object.keys(value).some(key => !['command', 'args', 'env', 'disabled', 'autoApprove'].includes(key)) || value.env && !sameEntry({ command: '', args: [], env: value.env }, { command: '', args: [], env: { ELECTRON_RUN_AS_NODE: '1' } })) throw new Error('LEGACY_ENTRY_OWNERSHIP_UNVERIFIED')
    migration = true
    legacyOutput = editEntry(legacyOutput, false, key, undefined)
  }
  const changes = snapshots.some(row => row.before.content !== row.after) || legacyOutput !== legacy.content
  const steps: FileChange[] = changes ? [
    { ...manifest, after: null },
    ...snapshots.slice(1),
    { path: target.legacy, before: legacy, after: legacyOutput },
    ...(disconnect ? [] : [manifest])
  ] : []
  return { steps, migration, configured: snapshots.every(row => row.before.content === files[row.path.slice(root.length + 1)]), changes }
}

export function applyFiles(steps: FileChange[], home: string, beforeStep?: (path: string) => void): void {
  const expected = new Map<string, FileRevision>()
  for (const step of steps) if (!expected.has(step.path)) {
    assertProfilePath(step.path, home); assertUserOwned(step.path); assertRevision(step.path, step.before)
    expected.set(step.path, step.before)
  }
  const completed: { path: string; before: FileRevision; after: FileRevision }[] = []
  let attempted: { path: string; before: FileRevision } | undefined
  try {
    for (const step of steps) {
      const before = expected.get(step.path)!
      attempted = { path: step.path, before }
      beforeStep?.(step.path)
      if (step.after === null) removeConfig(step.path, home, before)
      else writeConfig(step.path, home, before, step.after)
      const after = revision(step.path)
      if (after.content !== step.after) throw new Error('CONFIG_REVISION_CONFLICT')
      completed.push({ path: step.path, before, after }); expected.set(step.path, after)
      attempted = undefined
    }
  } catch (error) {
    if (attempted) {
      try { assertRevision(attempted.path, attempted.before) }
      catch { throw new Error('INSTALLATION_RECOVERY_REQUIRED') }
    }
    // Stop rollback at a concurrent edit: restoring a legacy entry past this boundary could expose a duplicate server.
    for (const row of completed.reverse()) {
      try {
        if (row.before.content === null) removeConfig(row.path, home, row.after)
        else writeConfig(row.path, home, row.after, row.before.content)
        const previous = completed.find(other => other !== row && other.path === row.path)
        if (previous) previous.after = revision(row.path)
      } catch { throw new Error('INSTALLATION_RECOVERY_REQUIRED') }
    }
    throw error
  }
}
