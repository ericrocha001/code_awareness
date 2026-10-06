import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { installationId } from '../../shared/distribution/relay-protocol'
import { CodeMapService } from '../core/code-map-service'
import { ContextEngine } from '../core/context/context-engine'
import { bindProjectNavigation } from '../core/context/project-context-navigation'
import { WatcherService } from '../core/watcher-service'
import { ActiveProjectService } from '../core/active-project-service'
import { McpLifecycle } from './mcp-lifecycle'
import { ConnectionLifecycle } from './connection/connection-lifecycle'
import { RelayTransport } from './connection/relay-transport'
import { createMcpHttpServer } from './mcp-http-server'
import { ChannelMcpAdapter } from './channel-mcp-adapter'

const emit = (event: Record<string, unknown>) => process.stdout.write(`RELAY_OPERATION ${JSON.stringify(event)}\n`)
const repository = resolve(process.argv[2] ?? '.')
const endpoint = process.env.CODE_AWARENESS_RELAY_ENDPOINT
const identityFile = process.env.CODE_AWARENESS_RELAY_IDENTITY_FILE
if (!endpoint || !identityFile) throw new Error('RELAY_CONFIGURATION_REQUIRED')
const provisioned = JSON.parse(readFileSync(identityFile, 'utf8'))
const id = installationId(provisioned.installationId)
if (typeof provisioned.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(provisioned.credential)) throw new Error('INVALID_CREDENTIAL')

const watcher = new WatcherService()
const codeMap = new CodeMapService(watcher, { async generateCompressionMarkdown() { throw new Error('UNAVAILABLE') } })
const engine = new ContextEngine(codeMap)
const projects = new ActiveProjectService(codeMap)
const mcp = new McpLifecycle({
  log: (state) => emit({ mcp: state.status }),
  createServer: (navigation) => createMcpHttpServer(new ChannelMcpAdapter(navigation), (entry) => {
    emit({ tool: entry.tool, latencyMs: entry.durationMs, bytes: entry.responseSize, success: entry.success })
  })
})
const transport = new RelayTransport(endpoint, { getId: () => id, getCredential: () => provisioned.credential })
const connection = new ConnectionLifecycle(mcp, transport, () => ({}), (state) => emit({ connection: state.status }))
projects.onBeforeChange(() => mcp.quiesce())
projects.onChanged(({ project }) => project ? mcp.activate(project.id, bindProjectNavigation(engine, project.path)) : mcp.deactivate())

function status(): void {
  emit({ project: basename(repository), mcp: mcp.getState().status, connection: connection.getState().status, installationId: id })
}

try {
  await codeMap.openRepository(repository)
  await codeMap.awaitMaintenance(repository)
  const project = codeMap.getOpenProjects().find((entry) => entry.path === repository.replace(/\\/g, '/'))
  if (!project) throw new Error('PROJECT_UNAVAILABLE')
  await projects.activate(project.id)
  if (!(await connection.connect()).success) throw new Error('RELAY_CONNECT_FAILED')
  status()
  const input = createInterface({ input: process.stdin })
  const close = () => input.close()
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  for await (const line of input) {
    if (line.trim() === 'stop') break
    if (line.trim() === 'disconnect') await connection.disconnect()
    if (line.trim() === 'connect') await connection.connect()
    status()
  }
  input.close()
} catch {
  emit({ error: 'RELAY_RUNTIME_FAILED' })
  process.exitCode = 1
} finally {
  await connection.dispose()
  await projects.dispose()
  await mcp.dispose()
  codeMap.closeAll()
  watcher.stop()
}
