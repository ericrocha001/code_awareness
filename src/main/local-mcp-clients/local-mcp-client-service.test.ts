import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { editEntry, readEntry } from './config-editors'
import { LocalMcpClientService } from './local-mcp-client-service'
import { assertProfilePath, revision, writeConfig } from './safe-config-file'
import type { LocalMcpClientId } from '../../shared/types/local-mcp-client-types'

const directories: string[] = []
afterEach(async () => { directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); await new Promise(resolve => setTimeout(resolve, 20)) })
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'client-config-')); directories.push(home)
  const sourceBundle = join(home, 'bundle.cjs'); writeFileSync(sourceBundle, 'managed-bundle')
  for (const path of ['.codex', '.gemini', '.cline/data/settings', 'AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings']) mkdirSync(join(home, path), { recursive: true })
  const cline = join(home, '.cline/data/settings/cline_mcp_settings.json')
  writeFileSync(cline, '{"mcpServers":{"existing":{"command":"other","env":{"TOKEN":"keep"}}},"extra":true}')
  writeFileSync(join(home, 'AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'), '{"mcpServers":{},"theme":"keep"}')
  const options = { home, appData: join(home, 'AppData/Roaming'), localAppData: join(home, 'AppData/Local'),
    sourceBundle, command: process.execPath, profile: join(home, 'desktop-profile'), packaged: false, env: {}, probe: async () => {} }
  return { home, options, service: new LocalMcpClientService(options) }
}

describe('localized TOML/JSON editing', () => {
  const entry = { command: 'C:\\node.exe', args: ['C:\\launcher.cjs'] }
  it('preserves unrelated TOML bytes/comments, quoted tables and CRLF', () => {
    const before = '# user comment\r\nmodel="keep"\r\n[mcp_servers."other.server"]\r\ncommand="other" # keep me\r\n'
    const after = editEntry(before, true, 'code_awareness_local', entry)
    expect(after.startsWith(before)).toBe(true)
    expect(readEntry(after, true, 'code_awareness_local')).toEqual(entry)
    const removed = editEntry(after, true, 'code_awareness_local', undefined)
    expect(removed.startsWith(before)).toBe(true)
  })
  it('rejects malformed, duplicate and ambiguous layouts', () => {
    for (const text of ['{', '[]', '{"mcpServers":[]}', '{"mcpServers":{},"mcpServers":{}}']) expect(() => editEntry(text, false, 'managed', entry)).toThrow()
    expect(() => editEntry('[bad', true, 'managed', entry)).toThrow()
    expect(() => editEntry('mcp_servers={managed={command="custom"}}', true, 'managed', entry)).toThrow('UNSUPPORTED_TOML_LAYOUT')
  })
})

describe('safe profile transitions', () => {
  it('recognizes the existing canonical bootstrap configuration without adding profile arguments', async () => {
    const { options, home } = fixture()
    const service = new LocalMcpClientService({ ...options, profile: join(options.appData, 'code-awareness') })
    mkdirSync(dirname(service.launcher), { recursive: true }); writeFileSync(service.launcher, 'managed-bundle')
    const text = `[mcp_servers.code_awareness_local]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([service.launcher])}\n`
    writeFileSync(join(home, '.codex/config.toml'), text)
    const preview = await service.preview('codex', 'connect')
    expect(preview).toMatchObject({ changes: false, conflict: false })
    await service.apply(preview.token, true, false)
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe(text)
  }, 20000)
  it.each(['codex', 'antigravity', 'cline', 'cline-vscode'] as LocalMcpClientId[])('previews, connects idempotently and disconnects %s without changing other MCPs', async id => {
    const { service, home } = fixture()
    const target = (await service.detect()).find(row => row.id === id)!
    const original = existsSync(target.path) ? readFileSync(target.path, 'utf8') : undefined
    const preview = await service.preview(id, 'connect', 7)
    expect(existsSync(service.launcher)).toBe(false)
    await expect(service.apply(preview.token, false, false, 7)).rejects.toThrow('CONFIRMATION_REQUIRED')
    await expect(service.apply(preview.token, true, false, 8)).rejects.toThrow('CONFIRMATION_REQUIRED')
    expect((await service.apply(preview.token, true, false, 7)).configuration).toBe('INSTALLED')
    const installed = readFileSync(target.path, 'utf8')
    const repeated = await service.preview(id, 'connect')
    expect(repeated.changes).toBe(false)
    await service.apply(repeated.token, true, false)
    expect(readFileSync(target.path, 'utf8')).toBe(installed)
    expect((await service.verify(id)).clientUse).toBe('NOT_CONFIRMED')
    const disconnect = await service.preview(id, 'disconnect')
    expect((await service.apply(disconnect.token, true, false)).configuration).toBe('ABSENT')
    if (original) {
      const result = readFileSync(target.path, 'utf8')
      expect(JSON.parse(result)).toEqual(JSON.parse(original))
      if (original.includes('other')) expect(JSON.parse(result).mcpServers.existing.env.TOKEN).toBe('keep')
    }
    expect(service.launcher.startsWith(home)).toBe(true)
  }, 60000)
  it('requires explicit conflict choice, never leaks private existing fields and preserves concurrent edits', async () => {
    const { service, home } = fixture()
    const path = join(home, '.codex/config.toml')
    writeFileSync(path, '[mcp_servers.code_awareness_local]\ncommand="custom"\nargs=["private-token"]\n')
    const preview = await service.preview('codex', 'repair')
    expect(preview.conflict).toBe(true)
    expect(JSON.stringify(preview)).not.toContain('private-token')
    await expect(service.apply(preview.token, true, false)).rejects.toThrow('EXPLICIT_CONFLICT_CHOICE_REQUIRED')
    writeFileSync(path, '# concurrent user edit\n')
    await expect(service.apply(preview.token, true, true)).rejects.toThrow('CONFIG_REVISION_CONFLICT')
    expect(readFileSync(path, 'utf8')).toBe('# concurrent user edit\n')
  }, 30000)
  it('does not fabricate Cline profiles or packaged readiness and keeps session failures independent of config', async () => {
    const { options, service, home } = fixture()
    const denied = new LocalMcpClientService({ ...options, packaged: true })
    await expect(denied.preview('codex', 'connect')).rejects.toThrow('PACKAGED_NODE_RUNTIME_UNSUPPORTED')
    rmSync(join(home, '.cline'), { recursive: true })
    expect((await service.detect()).find(row => row.id === 'cline')?.configuration).toBe('UNSUPPORTED')
    const preview = await service.preview('codex', 'connect'); await service.apply(preview.token, true, false)
    const installed = readFileSync(join(home, '.codex/config.toml'), 'utf8')
    const failing = new LocalMcpClientService({ ...options, probe: async () => { throw new Error('MCP_SESSION_INVALIDATED') } })
    expect(await failing.verify('codex')).toMatchObject({ configuration: 'INSTALLED', bootstrap: 'ERROR', diagnostic: 'MCP_SESSION_INVALIDATED', clientUse: 'NOT_CONFIRMED' })
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe(installed)
  }, 30000)
  it('rejects external paths and junctions; rolls back a failed publish without overwriting a concurrent writer', () => {
    const { home } = fixture()
    expect(() => assertProfilePath(join(dirname(home), 'outside.json'), home)).toThrow('OUTSIDE_USER_PROFILE')
    const real = join(home, 'real'); mkdirSync(real)
    const link = join(home, 'link'); symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => assertProfilePath(join(link, 'config.json'), home)).toThrow('CONFIG_LINK_NOT_ALLOWED')
    const path = join(home, 'config.json'); writeFileSync(path, 'original')
    expect(() => writeConfig(path, home, revision(path), 'new', undefined, () => { throw new Error('simulated failure') })).toThrow('simulated failure')
    expect(readFileSync(path, 'utf8')).toBe('original')
    expect(() => writeConfig(path, home, revision(path), 'new', undefined, () => writeFileSync(path, 'concurrent'))).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('concurrent')
  }, 30000)
})
