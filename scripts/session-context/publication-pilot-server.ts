import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { ArtifactStore } from '../../src/main/continuum/artifact-store'
import { ContinuumService } from '../../src/main/continuum/continuum-service'
import { PUBLISH_ARTIFACT_TOOL, UPDATE_ARTIFACT_TOOL, GET_ARTIFACT_TOOL, executePublishArtifact, executeUpdateArtifact, executeGetArtifact } from '../../src/main/continuum/continuum-mcp'
import { SESSION_CONTEXT_TOOLS } from '../../src/main/session-context/mcp'
import { SessionContextClient } from '../../src/main/session-context/client'
import { GitWorktreeRegistry } from '../../src/main/git-operations/git-worktree-registry'
import { GitService } from '../../src/main/core/git-service'
import { sessionTargetResolver } from '../../src/main/session-context/target'
import { installNativeHooks } from '../../src/main/session-context/native-hook-installation'

async function main() {
  const [mode, root, repositoryId, workerPath, nodePath, hookPath] = process.argv.slice(2)
  const registry = new GitWorktreeRegistry(root, new GitService(), { repositoryId, isActive: () => true })
  if (mode === 'prepare') {
    const record = await registry.current()
    installNativeHooks({ repositoryId, record, commandPath: hookPath, nodePath, authorized: true })
    process.stdout.write(JSON.stringify({ prepared: true, hookEvents: 7 }) + '\n')
    return
  }
  if (mode !== 'serve') throw new Error('INVALID_PILOT_MODE')
  const store = new ArtifactStore(join(root, 'continuum.db'), repositoryId), service = new ContinuumService(store)
  const client = new SessionContextClient(root, repositoryId, root, () => true, workerPath, sessionTargetResolver(registry, () => {}), 20000, undefined, undefined, {
    readReceipt: async id => service.readPublicationReceipt(id),
    associate: async value => service.associatePublication(value),
    invalidate: async (id, state) => { service.invalidatePublication(id, state) }
  })
  const lines = createInterface({ input: process.stdin })
  let active = Promise.resolve()
  lines.on('line', line => {
    active = active.then(async () => {
      const request = JSON.parse(line) as { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: unknown } }
      if (request.id === undefined) return
      let result: unknown
      if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'continuum-publication-pilot', version: '1' } }
      else if (request.method === 'ping') result = {}
      else if (request.method === 'tools/list') result = { tools: [PUBLISH_ARTIFACT_TOOL, UPDATE_ARTIFACT_TOOL, GET_ARTIFACT_TOOL, ...SESSION_CONTEXT_TOOLS.filter(tool => tool.name === 'discover_execution_context')] }
      else if (request.method === 'tools/call') {
        const { name, arguments: args } = request.params!
        if (name === 'publish_artifact' || name === 'update_artifact') {
          result = name === 'publish_artifact' ? executePublishArtifact(service, args) : executeUpdateArtifact(service, args)
          const response = result as { isError?: boolean; content: { type: string; text: string }[] }
          if (!response.isError) writeFileSync(join(root, name === 'publish_artifact' ? 'publication.json' : 'update.json'), response.content[0].text, { flag: 'wx' })
        } else if (name === 'get_artifact') result = executeGetArtifact(service, args)
        else if (name === 'discover_execution_context') result = await client.call(name, args)
        else throw new Error('INVALID_PILOT_TOOL')
      } else throw new Error('INVALID_PILOT_METHOD')
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
    }).catch(() => { process.exitCode = 1 })
  })
  lines.on('close', () => { void active.finally(async () => { await client.dispose(); store.close() }) })
}
void main().catch(() => { process.stderr.write('PILOT_SERVER_FAILED\n'); process.exitCode = 1 })
