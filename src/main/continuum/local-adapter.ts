import { GitService } from '../core/git-service'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { operation, type LocalChannelAdapter, type LocalRequestContext } from '../local-agent-channel/local-channel-types'
import { object, text, integer } from '../local-agent-channel/request-validation'
import type { RepositoryContinuumSession } from './project-continuum-session'
import type { ListArtifactsFilter } from './continuum-types'

export class ContinuumLocalAdapter implements LocalChannelAdapter {
  readonly domain = 'continuum'
  private registry?: { session: object; value: GitWorktreeRegistry }
  readonly operations: LocalChannelAdapter['operations']
  constructor(private readonly session: RepositoryContinuumSession) {
    const selection = (input: unknown, keys: string[]) => {
      const value = object(input, ['repositoryId', 'worktreeId', ...keys])
      return { value, repositoryId: value.repositoryId, worktreeId: value.worktreeId }
    }
    this.operations = {
      status: operation(input => object(input, []), async () => {
        const active = this.session.getActiveSession()
        if (!active) return { available: true, repository: null }
        const discovery = await this.getRegistry(active).discover()
        if (this.session.getActiveSession() !== active) throw new Error('REPOSITORY_MISMATCH')
        return { available: true, repository: { repositoryId: active.repositoryId, checkout: active.repositoryPath }, worktrees: discovery.worktrees.filter(w => !w.missing && !w.prunable).map(w => ({ worktreeId: w.worktreeId, path: w.path })) }
      }),
      list: operation(input => { const request = selection(input, ['filter']); return { ...request, filter: request.value.filter === undefined ? undefined : object(request.value.filter, ['query', 'kind', 'status', 'metadata', 'metadataKeys', 'relatedToArtifactId', 'relationKind', 'direction', 'updatedAfter', 'updatedBefore', 'limit', 'cursor']) as ListArtifactsFilter } }, async (request, context) => (await this.service(request, context)).list(request.filter)),
      get: operation(input => { const request = selection(input, ['artifactId']); return { ...request, artifactId: text(request.value.artifactId) } }, async (request, context) => {
        const artifact = (await this.service(request, context)).get(request.artifactId)
        if (!artifact) throw new Error('ARTIFACT_NOT_FOUND')
        return artifact
      }),
      publish: operation(input => { const request = selection(input, ['rawMarkdown']); return { ...request, rawMarkdown: text(request.value.rawMarkdown) } }, async (request, context) => ({ ...(await this.service(request, context)).publish(request.rawMarkdown), state: 'PERSISTED' })),
      update: operation(input => { const request = selection(input, ['artifactId', 'expectedRevision', 'rawMarkdown']); return { ...request, artifactId: text(request.value.artifactId), expectedRevision: integer(request.value.expectedRevision), rawMarkdown: text(request.value.rawMarkdown) } }, async (request, context) => ({ ...(await this.service(request, context)).update(request.artifactId, request.expectedRevision, request.rawMarkdown), state: 'PERSISTED' }))
    }
  }
  private getRegistry(active: NonNullable<ReturnType<RepositoryContinuumSession['getActiveSession']>>): GitWorktreeRegistry {
    if (this.registry?.session !== active) this.registry = { session: active, value: new GitWorktreeRegistry(active.repositoryPath, new GitService(), { repositoryId: active.repositoryId, isActive: () => this.session.getActiveSession() === active }) }
    return this.registry.value
  }
  private async service(request: { repositoryId: unknown; worktreeId: unknown }, context: LocalRequestContext) {
    const active = this.session.getActiveSession()
    if (!active) throw new Error('NO_ACTIVE_REPOSITORY')
    if (request.repositoryId !== active.repositoryId) throw new Error('REPOSITORY_MISMATCH')
    if (typeof request.worktreeId !== 'string') throw new Error('WORKTREE_UNLINKED')
    const registry = this.getRegistry(active)
    try { await registry.discover(); await registry.revalidateSelection(request.worktreeId) } catch { throw new Error('WORKTREE_UNLINKED') }
    if (this.session.getActiveSession() !== active) throw new Error('REPOSITORY_MISMATCH')
    if (!context.connected()) throw new Error('IPC_CLOSED')
    return this.session.getActiveService()!
  }
}
