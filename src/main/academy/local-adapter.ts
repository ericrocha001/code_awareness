import type { AcademyPackage, AcademySkillScope, AcademyCreateInput, AcademyUpdateInput } from '../../shared/types/academy-types'
import type { AcademyService } from './academy-service'
import { operation, type LocalChannelAdapter } from '../local-agent-channel/local-channel-types'
import { object, text, integer, strings, invalid } from '../local-agent-channel/request-validation'

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
      list: operation(input => {
        const value = object(input, ['status'])
        if (value.status !== undefined && value.status !== 'ACTIVE' && value.status !== 'ARCHIVED') invalid()
        return value.status as 'ACTIVE' | 'ARCHIVED' | undefined
      }, status => service.list(status)),
      get: operation(input => text(object(input, ['skillId']).skillId), skillId => ({ ...service.get(skillId), distribution: service.distribution.states(skillId).map(state => ({ destinationId: state.destinationId, target: state.target, status: state.status, canonicalVersion: state.canonicalVersion, distributedVersion: state.distributedVersion, distributedHash: state.distributedHash, errorCode: state.errorCode })) })),
      create: operation((input): AcademyCreateInput => {
        const value = object(input, ['package', 'scope', 'projectIds']), target = scope(value.scope)
        return { package: pkg(value.package), scope: target, projectIds: associations(target, value.projectIds), origin: 'LOCAL_CLI' }
      }, (request, context) => { if (!context.connected()) throw new Error('IPC_CLOSED'); return service.create(request, 'RECEIPT') }),
      update: operation((input): AcademyUpdateInput => {
        const value = object(input, ['skillId', 'expectedVersion', 'package', 'scope', 'projectIds'])
        if (value.projectIds !== undefined && value.scope === undefined) invalid()
        const target = value.scope === undefined ? undefined : scope(value.scope)
        return { skillId: text(value.skillId), expectedVersion: integer(value.expectedVersion), package: pkg(value.package), scope: target, projectIds: target === undefined ? undefined : associations(target, value.projectIds) ?? [], origin: 'LOCAL_CLI' }
      }, (request, context) => { if (!context.connected()) throw new Error('IPC_CLOSED'); return service.update(request, 'RECEIPT') })
    }
  }
}
