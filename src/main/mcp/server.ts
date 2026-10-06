import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { CompressionPort } from '../core/compression-port'
import { CodeMapService } from '../core/code-map-service'
import { ContextEngine } from '../core/context/context-engine'
import { WatcherService } from '../core/watcher-service'
import { ChannelMcpAdapter } from './channel-mcp-adapter'
import { createMcpHttpServer } from './mcp-http-server'

class ReadOnlyWatcherService extends WatcherService {
  override subscribe(): () => void {
    return () => undefined
  }
}

const repoPathArgument = process.argv[2] ?? process.env.CODE_AWARENESS_MCP_REPO_PATH
if (!repoPathArgument) {
  throw new Error('Provide the bound repository path as the first argument or CODE_AWARENESS_MCP_REPO_PATH')
}

const repoPath = resolve(repoPathArgument)
const port = Number(process.env.CODE_AWARENESS_MCP_PORT ?? 8765)
const logPath = resolve(process.env.CODE_AWARENESS_MCP_LOG_PATH ?? `${tmpdir()}/code-awareness-mcp.ndjson`)
const unavailableCompression: CompressionPort = {
  async generateCompressionMarkdown() {
    throw new Error('Compression is not available through the MCP server')
  }
}
const watcher = new ReadOnlyWatcherService()
const codeMap = new CodeMapService(watcher, unavailableCompression)

await codeMap.openRepository(repoPath)
await codeMap.awaitSnapshot(repoPath)
if (codeMap.getFiles(repoPath).length === 0) {
  await codeMap.indexRepository(repoPath)
}

const adapter = new ChannelMcpAdapter(new ContextEngine(codeMap), repoPath)
const server = createMcpHttpServer(adapter, (entry) => {
  const serialized = JSON.stringify(entry)
  console.log(serialized)
  appendFileSync(logPath, `${serialized}\n`, 'utf8')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Code Awareness MCP bound to ${repoPath}`)
  console.log(`Listening on http://127.0.0.1:${port}/mcp`)
  console.log(`Operational log: ${logPath}`)
})

function close(): void {
  server.close(() => {
    codeMap.closeAll()
    watcher.stop()
    process.exit(0)
  })
}

process.on('SIGINT', close)
process.on('SIGTERM', close)
