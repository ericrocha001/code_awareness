import { CONTINUUM_AGENT_TOOLS, executeContinuumAgent, parseContinuumAgentRequest, parseAgentArtifactUpdate } from './continuum-agent'
import { authorizeArtifactAgent } from './agent-authority'
import { GitService } from '../core/git-service'
import { GitWorktreeRegistry } from '../git-operations/git-worktree-registry'
import { GitBranchInventory } from '../git-operations/git-branch-inventory'
import { operation, type LocalChannelAdapter, type LocalRequestContext } from '../local-agent-channel/local-channel-types'
import { object, text, integer } from '../local-agent-channel/request-validation'
import type { RepositoryContinuumSession } from './project-continuum-session'
import type { ListArtifactsFilter } from './continuum-types'
import { validateSuggestionQuery } from './artifact-suggestions'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { VISUAL_MAX_BYTES } from './visual-media'
import { executeGetVisualArtifact } from './continuum-mcp'
import { navigationQuery } from './artifact-navigation'
import type { Artifact } from './continuum-types'
import { publicationFields } from './artifact-publication'
import { authenticatedSessionWitness, deliveryContextRequest, type DeliveryAnchor, type ObserveDelivery } from '../../shared/types/delivery-context-types'

export class ContinuumLocalAdapter implements LocalChannelAdapter {
  readonly domain = 'continuum'
  private registry?: { session: object; value: GitWorktreeRegistry }
  readonly operations: LocalChannelAdapter['operations']
  constructor(private readonly session: RepositoryContinuumSession,
    private readonly handoffCoverage?: (artifact: Artifact, target: { worktreeId: string; generation: string }) => Promise<object>,
    private readonly executionPreflight?: (target: { worktreeId: string; generation: string; executionId: string }) => Promise<object | undefined>) {
    const selection = (input: unknown, keys: string[]) => {
      const value = object(input, ['repositoryId', 'worktreeId', ...keys])
      return { value, repositoryId: value.repositoryId, worktreeId: value.worktreeId }
    }
    this.operations = {
      ...Object.fromEntries(CONTINUUM_AGENT_TOOLS.map(tool => [tool.name, operation(input => {
        const request = selection(input, [...Object.keys(tool.inputSchema.properties ?? {}), 'deliveryContext', 'sessionWitness'])
        const { repositoryId: _repository, worktreeId: _worktree, deliveryContext, sessionWitness, ...args } = request.value
        parseContinuumAgentRequest(tool.name, args)
        return { ...request, deliveryContext, sessionWitness, args }
      }, async (request, context) => {
        const service = await this.service(request, context)
        const authority = this.authority(request, context)
        return executeContinuumAgent(service, tool.name, request.args, () => context.connected(), authority, this.observeDelivery(request, service, context))
      })])),
      inspect_artifact_structure: operation(input => {
        const request = selection(input, ['artifactId', 'sectionId', 'includeBlocks', 'limit', 'cursor'])
        const { repositoryId: _repository, worktreeId: _worktree, ...query } = request.value
        return { ...request, query: navigationQuery(query, false) }
      }, async (request, context) => (await this.service(request, context)).inspectStructure(request.query)),
      read_artifact_section: operation(input => {
        const request = selection(input, ['artifactId', 'sectionId', 'expectedRevision', 'includeDescendants', 'blockId', 'cursor'])
        const { repositoryId: _repository, worktreeId: _worktree, ...query } = request.value
        return { ...request, query: navigationQuery(query, true) }
      }, async (request, context) => (await this.service(request, context)).readSection(request.query)),
      bind_execution: operation(input => {
        const request = selection(input, ['executionId', 'sourceArtifactId', 'worktreeGeneration'])
        return { ...request, executionId: text(request.value.executionId), sourceArtifactId: text(request.value.sourceArtifactId), generation: text(request.value.worktreeGeneration) }
      }, async (request, context) => {
        const service = await this.service(request, context)
        const active = this.session.getActiveSession()!
        const git = new GitService(), identity = { repositoryId: active.repositoryId, isActive: () => this.session.getActiveSession() === active && context.connected() }
        const reader = new GitBranchInventory(active.repositoryPath, git, this.getRegistry(active), identity)
        const bound = await service.bindExecutionBranch(request.executionId, request.sourceArtifactId, async () => {
          if (await this.service(request, context, false) !== service) throw new Error('REPOSITORY_MISMATCH')
          return reader.executionSnapshot(String(request.worktreeId), request.generation)
        })
        if (!this.executionPreflight) return bound
        const sessionPreflight = await this.executionPreflight({
          worktreeId: String(request.worktreeId),
          generation: request.generation,
          executionId: request.executionId
        }).catch(() => undefined)
        return sessionPreflight ? { ...bound, sessionPreflight } : bound
      }),
      suggestions: operation(input => {
        const request = selection(input, ['query'])
        return { ...request, query: validateSuggestionQuery(request.value.query) }
      }, async (request, context) => (await this.service(request, context)).suggestions(request.query)),
      publish_visual: operation(input => {
        const request = selection(input, ['rawMarkdown', 'filePath'])
        return { ...request, rawMarkdown: text(request.value.rawMarkdown), filePath: text(request.value.filePath) }
      }, async (request, context) => {
        const service = await this.service(request, context)
        if (!isAbsolute(request.filePath)) throw new Error('INVALID_FILE')
        const handle = await open(request.filePath, 'r')
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size < 1 || stat.size > VISUAL_MAX_BYTES) throw new Error('VISUAL_SIZE_LIMIT')
          const data = Buffer.alloc(stat.size + 1)
          let bytesRead = 0
          while (bytesRead < data.length) {
            const chunk = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead)
            if (!chunk.bytesRead) break
            bytesRead += chunk.bytesRead
          }
          const after = await handle.stat()
          if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('INVALID_FILE')
          if (await this.service(request, context, false) !== service) throw new Error('REPOSITORY_MISMATCH')
          return { ...await service.publishVisual(request.rawMarkdown, data.subarray(0, bytesRead)), state: 'PERSISTED' }
        } finally { await handle.close() }
      }),
      get_visual: operation(input => {
        const request = selection(input, ['artifactId'])
        return { ...request, artifactId: text(request.value.artifactId) }
      }, async (request, context) => executeGetVisualArtifact(await this.service(request, context), { artifactId: request.artifactId })),
      status: operation(input => object(input, []), async () => {
        const active = this.session.getActiveSession()
        if (!active) return { available: true, repository: null }
        const discovery = await this.getRegistry(active).discover()
        if (this.session.getActiveSession() !== active) throw new Error('REPOSITORY_MISMATCH')
        return { available: true, repository: { repositoryId: active.repositoryId, checkout: active.repositoryPath }, worktrees: discovery.worktrees.filter(w => !w.missing && !w.prunable).map(w => ({ worktreeId: w.worktreeId, generation: w.generation, path: w.path })) }
      }),
      list: operation(input => { const request = selection(input, ['filter']); return { ...request, filter: request.value.filter === undefined ? undefined : object(request.value.filter, ['tag', 'query', 'kind', 'status', 'metadata', 'metadataKeys', 'relatedToArtifactId', 'relationKind', 'direction', 'updatedAfter', 'updatedBefore', 'limit', 'cursor']) as ListArtifactsFilter } }, async (request, context) => (await this.service(request, context)).list(request.filter)),
      get: operation(input => { const request = selection(input, ['artifactId']); return { ...request, artifactId: text(request.value.artifactId) } }, async (request, context) => {
        const artifact = (await this.service(request, context)).get(request.artifactId)
        if (!artifact) throw new Error('ARTIFACT_NOT_FOUND')
        return artifact
      }),
      publish: operation(input => { const request = selection(input, ['rawMarkdown', 'name', 'description', 'kind', 'deliveryContext', 'sessionWitness']); const { rawMarkdown, repositoryId: _repository, worktreeId: _worktree, deliveryContext, sessionWitness, ...fields } = request.value; return { ...request, deliveryContext, sessionWitness, rawMarkdown: text(rawMarkdown), fields: publicationFields(fields) } }, async (request, context) => {
        const service = await this.service(request, context)
        const authority = this.authority(request, context)
        if (authority.deliveryContextError) throw new Error('DELIVERY_CONTEXT_INVALID')
        let anchor: DeliveryAnchor | undefined
        if (authority.deliveryContext) {
          anchor = await service.prepareDeliveryContext(authority, authority.deliveryContext, this.observeDelivery(request, service, context))
        }
        const receipt = service.publish(request.rawMarkdown, request.fields, authority, anchor)
        const artifact = service.get(receipt.artifactId)!
        let sessionCoverage: object | undefined
        if (artifact.metadata.kind === 'IMPLEMENTATION_HANDOFF' && this.handoffCoverage) {
          try {
            const target = await this.getRegistry(this.session.getActiveSession()!).revalidateSelection(String(request.worktreeId))
            if (await this.service(request, context, false) !== service) throw new Error('REPOSITORY_MISMATCH')
            sessionCoverage = await this.handoffCoverage(artifact, { worktreeId: target.worktreeId, generation: target.generation })
          } catch { sessionCoverage = { coverage: 'UNAVAILABLE', code: 'SESSION_COVERAGE_UNAVAILABLE' } }
        }
        return { ...receipt, state: 'PERSISTED', ...(sessionCoverage ? { sessionCoverage } : {}) }
      }),
      update: operation(input => {
        const request = selection(input, ['artifactId', 'expectedRevision', 'rawMarkdown', 'name', 'description', 'kind', 'lifecycle', 'deliveryContext', 'sessionWitness'])
        const { repositoryId: _repository, worktreeId: _worktree, deliveryContext, sessionWitness, ...args } = request.value
        return { ...request, deliveryContext, sessionWitness, args: parseAgentArtifactUpdate(args) }
      }, async (request, context) => {
        const service = await this.service(request, context)
        const { artifactId, expectedRevision, rawMarkdown, lifecycle, ...fields } = request.args
        return service.updateAgent(this.authority(request, context), artifactId, expectedRevision, rawMarkdown, fields, lifecycle, this.observeDelivery(request, service, context))
      })
    }
  }
  private getRegistry(active: NonNullable<ReturnType<RepositoryContinuumSession['getActiveSession']>>): GitWorktreeRegistry {
    if (this.registry?.session !== active) this.registry = { session: active, value: new GitWorktreeRegistry(active.repositoryPath, new GitService(), { repositoryId: active.repositoryId, isActive: () => this.session.getActiveSession() === active }) }
    return this.registry.value
  }
  private observeDelivery(request: { repositoryId: unknown; worktreeId: unknown }, service: ReturnType<RepositoryContinuumSession['getActiveService']>, context: LocalRequestContext): ObserveDelivery {
    return async () => {
      const active = this.session.getActiveSession()!
      const target = await this.getRegistry(active).revalidateSelection(String(request.worktreeId))
      if (await this.service(request, context, false) !== service) throw new Error('REPOSITORY_MISMATCH')
      const git = new GitService(), identity = { repositoryId: active.repositoryId, isActive: () => this.session.getActiveSession() === active && context.connected() }
      return new GitBranchInventory(active.repositoryPath, git, this.getRegistry(active), identity).executionSnapshot(target.worktreeId, target.generation)
    }
  }
  private authority(request: { repositoryId: unknown; worktreeId: unknown; deliveryContext?: unknown; sessionWitness?: unknown }, context: LocalRequestContext) {
    const active = this.session.getActiveSession()
    if (!active || !context.principal || request.repositoryId !== active.repositoryId) throw new Error('AGENT_UNAUTHORIZED')
    let deliveryContextError: string | undefined
    let deliveryContext: import('../../shared/types/delivery-context-types').DeliveryContextRequest | undefined
    if (request.deliveryContext !== undefined) {
      const parsed = deliveryContextRequest.safeParse(request.deliveryContext)
      if (!parsed.success) deliveryContextError = 'DELIVERY_CONTEXT_MALFORMED'
      else deliveryContext = parsed.data
    }
    let sessionWitness: import('../../shared/types/delivery-context-types').AuthenticatedSessionWitness | undefined
    if (request.sessionWitness !== undefined) {
      const parsed = authenticatedSessionWitness.safeParse(request.sessionWitness)
      if (!parsed.success) deliveryContextError ??= 'SESSION_WITNESS_INVALID'
      else sessionWitness = parsed.data
    }
    const scope = deliveryContext || deliveryContextError || sessionWitness
      ? { ...(deliveryContext ? { deliveryContext } : {}), ...(deliveryContextError ? { deliveryContextError } : {}), ...(sessionWitness ? { sessionWitness } : {}) }
      : undefined
    return authorizeArtifactAgent(context.principal, active.repositoryId, () => this.session.getActiveSession() === active && context.connected(), String(request.worktreeId), scope)
  }
  private async service(request: { repositoryId: unknown; worktreeId: unknown }, context: LocalRequestContext, discover = true) {
    const active = this.session.getActiveSession()
    if (!active) throw new Error('NO_ACTIVE_REPOSITORY')
    if (request.repositoryId !== active.repositoryId) throw new Error('REPOSITORY_MISMATCH')
    if (typeof request.worktreeId !== 'string') throw new Error('WORKTREE_UNLINKED')
    const registry = this.getRegistry(active)
    try {
      if (discover) await registry.discover()
      await registry.revalidateSelection(request.worktreeId)
    } catch { throw new Error('WORKTREE_UNLINKED') }
    if (this.session.getActiveSession() !== active) throw new Error('REPOSITORY_MISMATCH')
    if (!context.connected()) throw new Error('IPC_CLOSED')
    return this.session.getActiveService()!
  }
}
