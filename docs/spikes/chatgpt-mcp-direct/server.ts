import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { CompressionPort } from '../../../src/main/core/compression-port'
import { CodeMapService } from '../../../src/main/core/code-map-service'
import { ContextEngine } from '../../../src/main/core/context/context-engine'
import { WatcherService } from '../../../src/main/core/watcher-service'
import { ContextNavigationMcpAdapter } from './context-navigation-mcp'
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
const logPath = resolve(process.env.CODE_AWARENESS_MCP_LOG_PATH ?? `${tmpdir()}/code-awareness-mcp-spike.ndjson`)
const unusedCompression: CompressionPort = {
  async generateCompressionMarkdown() {
    throw new Error('Compression is not available through the MCP spike')
  }
}
const watcher = new ReadOnlyWatcherService()
const codeMap = new CodeMapService(watcher, unusedCompression)

await codeMap.openRepository(repoPath)
await codeMap.awaitSnapshot(repoPath)
if (codeMap.getFiles(repoPath).length === 0) {
  await codeMap.indexRepository(repoPath)
}

const adapter = new ContextNavigationMcpAdapter(new ContextEngine(codeMap), repoPath)
const server = createMcpHttpServer(adapter, (entry) => {
  console.log(entry)
  appendFileSync(logPath, `${entry}\n`, 'utf8')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Code Awareness Context Navigation MCP bound to ${repoPath}`)
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
