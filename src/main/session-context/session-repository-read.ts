import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertArtifactAgent, type AgentAuthority } from '../continuum/agent-authority'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { assertProfilePath, assertUserOwnedAsync } from '../local-mcp-clients/safe-config-file'
import type { RepositoryCatalogService } from '../repository-catalog/repository-catalog-service'
import { SessionContextClient } from './client'
import type { SessionToolName } from './mcp'
import { boundedFile } from './native-hooks'
import { sessionStorePath } from './store'
import { sessionTargetResolver } from './target'

function assertNativeRead(name: SessionToolName, args: unknown) {
  const input = args as { source?: unknown; nativeSession?: unknown; selector?: { type?: unknown; provider?: unknown } } | null
  switch (name) {
    case 'list_agent_sessions':
      if (input?.source === 'NATIVE_HOOK') return
      break
    case 'inspect_agent_session':
    case 'list_agent_session_events':
    case 'read_agent_session_event':
      if (input?.nativeSession) return
      break
    case 'discover_execution_context':
      if (input?.selector?.type === 'SESSION' && ['codex-native', 'antigravity-native'].some(provider => provider === input.selector?.provider)) return
  }
  throw new Error('REPOSITORY_NOT_AUTHORIZED')
}

export function sessionRepositoryReader(
  catalog: Pick<RepositoryCatalogService, 'resolveAvailable'>,
  git: ConstructorParameters<typeof GitWorktreeRegistry>[1],
  storageBase: string,
  activeRepositoryId: string,
  workerPath?: string
) {
  return async (repositoryId: string, name: SessionToolName, args: unknown, authority: AgentAuthority) => {
    const authorize = () => {
      assertArtifactAgent(authority, activeRepositoryId)
      if (authority.worktreeId || repositoryId === activeRepositoryId) throw new Error('REPOSITORY_NOT_AUTHORIZED')
    }
    authorize()
    assertNativeRead(name, args)
    const checkout = () => {
      const record = catalog.resolveAvailable(repositoryId)
      if (record.id !== repositoryId || record.localCheckout?.gitState !== 'GIT') throw new Error('REPOSITORY_NOT_AUTHORIZED')
      return realpathSync(record.localCheckout.path)
    }
    const root = checkout()
    const storePath = sessionStorePath(storageBase, repositoryId)
    const configPath = join(dirname(storePath), 'session-context.provider.json')
    const readGrant = () => {
      assertProfilePath(configPath, storageBase)
      return boundedFile(configPath, 65536)
    }
    await assertUserOwnedAsync(configPath)
    const grant = readGrant()
    const settings = JSON.parse(grant)
    if (settings?.repositoryId !== repositoryId || !Array.isArray(settings.mcpSessionReaders) ||
      !settings.mcpSessionReaders.includes(activeRepositoryId)) throw new Error('REPOSITORY_NOT_AUTHORIZED')
    const assertCurrent = () => {
      authorize()
      assertProfilePath(storePath, storageBase)
      if (checkout() !== root || readGrant() !== grant) throw new Error('REPOSITORY_NOT_AUTHORIZED')
    }
    const isCurrent = () => {
      try { assertCurrent(); return true } catch { return false }
    }
    const registry = new GitWorktreeRegistry(root, git, { repositoryId, isActive: isCurrent })
    const resolver = sessionTargetResolver(registry, assertCurrent)
    const catalogCheckout = await resolver.current!()
    if (catalogCheckout.root !== root) throw new Error('REPOSITORY_NOT_AUTHORIZED')
    const client = new SessionContextClient(storageBase, repositoryId, root, isCurrent, workerPath, resolver,
      undefined, undefined, undefined, undefined, undefined, true)
    try {
      const result = await client.call(name, args)
      await catalogCheckout.validate()
      await assertUserOwnedAsync(configPath)
      assertCurrent()
      return result
    } finally { await client.dispose() }
  }
}
