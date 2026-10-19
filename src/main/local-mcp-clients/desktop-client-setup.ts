import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { LocalMcpClientService } from './local-mcp-client-service'
import { codexRegistrar, discoverCodex } from './codex-registration'
import { stableDestination } from '../../shared/local-mcp-installation.cjs'

export function createDesktopClientSetup(app: { isPackaged: boolean; getAppPath(): string; getPath(name: 'appData' | 'userData'): string }, resources: string) {
  let command: string | null = null
  const launcherEnv = app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : undefined
  if (app.isPackaged) {
    try {
      const executable = stableDestination(process.execPath)
      const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 3000,
        env: { ...process.env, ...launcherEnv } }).trim()
      if (/^v(2\d|[3-9]\d)\./.test(version)) command = executable
    } catch {}
  } else {
    const candidates = [process.env.npm_node_execpath, process.env.ProgramFiles && join(process.env.ProgramFiles, 'nodejs', 'node.exe')]
    for (const candidate of candidates) {
      if (!candidate || !isAbsolute(candidate) || !existsSync(candidate)) continue
      try {
        const version = execFileSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).trim()
        if (/^v(2[2-9]|[3-9]\d)\./.test(version)) { command = candidate; break }
      } catch {}
    }
  }
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  let codexRegister: ReturnType<typeof codexRegistrar> | undefined
  try { const binary = discoverCodex(localAppData); if (binary) codexRegister = codexRegistrar(binary, homedir()) } catch {}
  return new LocalMcpClientService({ home: homedir(), appData: app.getPath('appData'),
    localAppData,
    sourceBundle: app.isPackaged ? join(resources, 'local-mcp', 'launcher.cjs') : join(app.getAppPath(), 'out', 'local-mcp', 'launcher.cjs'),
    command, launcherEnv, codexRegister, profile: app.getPath('userData'), packaged: app.isPackaged,
    probe: async (node, launcher, profile) => {
      const client = new Client({ name: 'code-awareness-local-setup-probe', version: '1' })
      const transport = new StdioClientTransport({ command: node, args: [launcher, '--profile', profile], env: { ...process.env, ...launcherEnv } as Record<string, string>, stderr: 'pipe' })
      let sessionInvalidated = false
      transport.stderr?.on('data', chunk => { if (String(chunk).includes('MCP_SESSION_INVALIDATED')) sessionInvalidated = true })
      try {
        await client.connect(transport, { timeout: 15000 })
        const result = await client.callTool({ name: 'get_runtime_identity', arguments: {} }, undefined, { timeout: 15000 })
        if (result.isError) throw new Error('BOOTSTRAP_PROBE_FAILED')
      } catch { throw new Error(sessionInvalidated ? 'MCP_SESSION_INVALIDATED' : 'BOOTSTRAP_PROBE_FAILED') }
      finally { await client.close() }
    }
  })
}
