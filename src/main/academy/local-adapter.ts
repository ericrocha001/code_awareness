import type { AcademyHistoryOptions, AcademyPackage, AcademySkillScope, AcademyCreateInput, AcademyUpdateInput } from '../../shared/types/academy-types'
import type { AcademyService } from './academy-service'
import { operation, type LocalChannelAdapter } from '../local-agent-channel/local-channel-types'
import { object, text, integer, strings, invalid } from '../local-agent-channel/request-validation'
import { projectAcademyGitStatus } from './git/academy-git-sync-service'

function scope(value: unknown): AcademySkillScope { if (value !== 'GLOBAL' && value !== 'PROJECT') invalid(); return value }
function pkg(value: unknown): AcademyPackage {
  const raw = object(value, ['skillMd', 'artifacts']), artifacts = object(raw.artifacts)
  if (Object.values(artifacts).some(value => typeof value !== 'string')) invalid()
  return { skillMd: text(raw.skillMd), artifacts: artifacts as Record<string, string> }
}

export class AcademyLocalAdapter implements LocalChannelAdapter {
  readonly domain = 'academy'
  readonly operations: LocalChannelAdapter['operations']
  constructor(private readonly service: AcademyService) {
    const associations = (target: AcademySkillScope, ids: unknown): string[] | undefined => {
      if (target === 'PROJECT' && ids === undefined) invalid()
      const projects = ids === undefined ? undefined : strings(ids)
      if (target === 'PROJECT' && !projects?.length) invalid()
      if (target === 'GLOBAL' && projects?.length) invalid()
      const valid = new Set(service.store.listDestinations().map(destination => destination.id))
      if (projects?.some(id => !valid.has(id))) throw new Error('PROJECT_NOT_FOUND')
      return projects
    }
    this.operations = {
      git_status: operation(input => object(input, []), () => { if (!service.gitSync) throw new Error('GIT_SYNC_NOT_CONFIGURED'); return projectAcademyGitStatus(service.gitSync.getStatus()) }),
      git_fetch: operation(input => object(input, []), async () => { if (!service.gitSync) throw new Error('GIT_SYNC_NOT_CONFIGURED'); return projectAcademyGitStatus(await service.gitSync.fetch()) }),
      git_update: operation(input => object(input, []), async () => { if (!service.gitSync) throw new Error('GIT_SYNC_NOT_CONFIGURED'); return projectAcademyGitStatus(await service.gitSync.syncNow()) }),
      git_publish: operation(input => { const value = object(input, ['localHead', 'remoteHead', 'confirmed']); if (value.confirmed !== true) invalid(); return { localHead: text(value.localHead), remoteHead: text(value.remoteHead) } }, async expected => { if (!service.gitSync) throw new Error('GIT_SYNC_NOT_CONFIGURED'); return projectAcademyGitStatus(await service.gitSync.publish(expected)) }),
      git_draft: operation(input => text(object(input, ['name']).name), name => service.gitSync?.getDraft(name)),
      git_conflict_begin: operation(input => { const value = object(input, ['remoteHead', 'localHead']); return { remote: text(value.remoteHead), local: text(value.localHead) } }, value => service.gitSync?.resolveManagedConflict(value.remote, value.local)),
      git_conflict_review: operation(input => text(object(input, ['path']).path), path => service.gitSync?.reviewGitConflict(path)),
      git_conflict_resolve: operation(input => {
        const value = object(input, ['path', 'head', 'revision', 'content', 'confirmed'])
        if (value.confirmed !== true || typeof value.content !== 'string') invalid()
        return { path: text(value.path), head: text(value.head), revision: text(value.revision), content: value.content, confirmed: true }
      }, value => service.gitSync?.resolveGitConflict(value)),
      git_candidate_publish: operation(input => {
        const value = object(input, ['branch', 'expectedHead', 'confirmed'])
        if (value.confirmed !== true) invalid()
        return { branch: text(value.branch), expectedHead: text(value.expectedHead), confirmed: true }
      }, value => service.gitSync?.publishCandidate(value)),
      history: operation(input => {
        const { skillId, ...options } = object(input, ['skillId', 'metadataOnly', 'version'])
        return { skillId: text(skillId), options: options as AcademyHistoryOptions }
      }, ({ skillId, options }) => service.history(skillId, options)),
      change_impact: operation(input => input, input => service.analyzeChangeImpact(input)),
      verify_change_impact: operation(input => input, input => service.verifyChangeImpact(input)),
      list: operation(input => {
        const value = object(input, ['status'])
        if (value.status !== undefined && value.status !== 'ACTIVE' && value.status !== 'DISABLED' && value.status !== 'ARCHIVED') invalid()
        return value.status as 'ACTIVE' | 'DISABLED' | 'ARCHIVED' | undefined
      }, status => service.list(status)),
      set_academy_skill_enabled: operation(input => {
        const value = object(input, ['skillId', 'enabled', 'expectedStateRevision'])
        if (typeof value.enabled !== 'boolean') invalid()
        return { skillId: text(value.skillId), enabled: value.enabled, expectedStateRevision: integer(value.expectedStateRevision) }
      }, (request, context) => {
        if (!context.connected()) throw new Error('IPC_CLOSED')
        return service.setEnabled(request.skillId, request.enabled, request.expectedStateRevision)
      }),
      archive: operation(input => {
        const value = object(input, ['skillId', 'expectedVersion'])
        return { skillId: text(value.skillId), expectedVersion: integer(value.expectedVersion) }
      }, (request, context) => {
        if (!context.connected()) throw new Error('IPC_CLOSED')
        return service.archive(request.skillId, request.expectedVersion)
      }),
      restore: operation(input => {
        const value = object(input, ['skillId', 'expectedVersion'])
        return { skillId: text(value.skillId), expectedVersion: integer(value.expectedVersion) }
      }, (request, context) => {
        if (!context.connected()) throw new Error('IPC_CLOSED')
        return service.restore(request.skillId, request.expectedVersion)
      }),
      get: operation(input => text(object(input, ['skillId']).skillId), skillId => ({ ...service.get(skillId), distribution: service.distribution.states(skillId).map(state => ({ destinationId: state.destinationId, target: state.target, status: state.status, canonicalVersion: state.canonicalVersion, distributedVersion: state.distributedVersion, distributedHash: state.distributedHash, errorCode: state.errorCode })) })),
      create: operation((input): AcademyCreateInput => {
        const value = object(input, ['package', 'scope', 'projectIds', 'expectedDraftCommitSha']), target = scope(value.scope)
        return { package: pkg(value.package), scope: target, projectIds: associations(target, value.projectIds), expectedDraftCommitSha: value.expectedDraftCommitSha === undefined ? undefined : text(value.expectedDraftCommitSha), origin: 'LOCAL_CLI' }
      }, (request, context) => { if (!context.connected()) throw new Error('IPC_CLOSED'); return service.saveNewSkill(request, 'RECEIPT') }),
      update: operation((input): AcademyUpdateInput => {
        const value = object(input, ['skillId', 'expectedVersion', 'package', 'scope', 'projectIds', 'expectedDraftCommitSha'])
        if (value.projectIds !== undefined && value.scope === undefined) invalid()
        const target = value.scope === undefined ? undefined : scope(value.scope)
        return { skillId: text(value.skillId), expectedVersion: integer(value.expectedVersion), package: pkg(value.package), scope: target, projectIds: target === undefined ? undefined : associations(target, value.projectIds) ?? [], expectedDraftCommitSha: value.expectedDraftCommitSha === undefined ? undefined : text(value.expectedDraftCommitSha), origin: 'LOCAL_CLI' }
      }, (request, context) => { if (!context.connected()) throw new Error('IPC_CLOSED'); return service.saveSkill(request, 'RECEIPT') }),
      delivery_status: operation(input => {
        const value = object(input, ['skillId', 'expectedVersion'])
        return {
          skillId: text(value.skillId),
          expectedVersion: value.expectedVersion === undefined ? undefined : integer(value.expectedVersion)
        }
      }, ({ skillId, expectedVersion }) => service.getDeliveryStatus(skillId, expectedVersion))
    }
  }
}
