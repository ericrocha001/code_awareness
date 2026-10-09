import type { CodeMapElement, CodeMapFile } from '../../../shared/types'
import type {
  DashFilter,
  DashRequest,
  DashResolutionReport,
  DashSetType
} from '../../../shared/types/dash-types'
import type { CodeMapReadinessCapability } from '../code-map-service'
import type { PersistedSymbolReference } from '../symbol-reference-resolver'
import { projectFileRelationships } from '../context/file-relationships'
import type { DashMapPort } from './dash-map-port'
import { DashError } from './dash-request-validator'

export type DashEntity = CodeMapFile | CodeMapElement | PersistedSymbolReference
export interface DashSet {
  type: DashSetType
  entities: DashEntity[]
}
export function normalizeDashText(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-\s]+/g, ' ')
    .trim()
    .toLowerCase()
}
function matches(value: unknown, filter: DashFilter): boolean {
  return Object.entries(filter).every(([op, operand]) => {
    if (op === 'in') return (operand as unknown[]).includes(value)
    if (typeof operand !== 'string' && !Array.isArray(operand))
      return op === 'exact' && value === operand
    if (typeof value !== 'string') return false
    const normalized = normalizeDashText(value)
    const contains = (x: string) => normalized.includes(normalizeDashText(x))
    switch (op) {
      case 'exact':
        return normalized === normalizeDashText(operand as string)
      case 'contains':
        return contains(operand as string)
      case 'startsWith':
        return normalized.startsWith(normalizeDashText(operand as string))
      case 'containsAny':
        return (operand as string[]).some(contains)
      case 'containsAll':
        return (operand as string[]).every(contains)
      default:
        return false
    }
  })
}
export const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
export class DashQueryResolver {
  private readonly satisfied = new Set<CodeMapReadinessCapability>()
  private files?: CodeMapFile[]
  private elements?: CodeMapElement[]
  constructor(
    private readonly map: DashMapPort,
    private readonly repo: string
  ) {}
  async ready(capability: CodeMapReadinessCapability) {
    if (this.satisfied.has(capability)) return
    await this.map.awaitReadiness(this.repo, capability)
    const levels: CodeMapReadinessCapability[] = [
      'FILE_INVENTORY',
      'STRUCTURE',
      'RELATIONSHIPS',
      'SYMBOL_REFERENCES'
    ]
    for (const level of levels.slice(0, levels.indexOf(capability) + 1)) this.satisfied.add(level)
    this.files = undefined
    this.elements = undefined
  }
  getFiles() {
    return (this.files ??= this.map.getFiles(this.repo))
  }
  getElements() {
    return (this.elements ??= this.map.getElements(this.repo))
  }
  path(entity: DashEntity): string {
    if ('relativePath' in entity) return entity.relativePath
    const fileId = 'fileId' in entity ? entity.fileId : entity.sourceFileId
    const file = this.getFiles().find((f) => f.id === fileId)
    if (!file) throw new DashError('NOT_FOUND', 'Entity owner is unavailable')
    return file.relativePath
  }
  canonical(type: DashSetType, entities: DashEntity[]): DashSet {
    const unique = [...new Map(entities.map((x) => [x.id, x])).values()]
    unique.sort(
      (a, b) =>
        compareText(this.path(a), this.path(b)) ||
        ('location' in a && 'location' in b
          ? a.location.start.line - b.location.start.line ||
            a.location.start.column - b.location.start.column ||
            a.location.start.byte - b.location.start.byte
          : 0) ||
        (type === 'reference-set'
          ? compareText((a as PersistedSymbolReference).kind, (b as PersistedSymbolReference).kind)
          : 0) ||
        compareText(a.id, b.id)
    )
    return { type, entities: unique }
  }
  async resolve(request: DashRequest, report: DashResolutionReport): Promise<Map<string, DashSet>> {
    const sets = new Map<string, DashSet>()
    for (const step of request.steps) {
      let result: DashSet
      if ('find' in step) {
        await this.ready(step.find === 'file' ? 'FILE_INVENTORY' : 'STRUCTURE')
        const entities = step.find === 'file' ? this.getFiles() : this.getElements()
        result = this.canonical(
          step.find === 'file' ? 'file-set' : 'element-set',
          entities.filter((entity) =>
            Object.entries(step.where).every(([field, filter]) =>
              matches(
                field === 'path'
                  ? this.path(entity)
                  : field === 'signature'
                    ? (entity as CodeMapElement).declarationSignature
                    : (entity as unknown as Record<string, unknown>)[field],
                filter
              )
            )
          )
        )
      } else if ('set' in step) {
        const inputs = step.from.map((id) => sets.get(id)!)
        const rest = inputs.slice(1).map((set) => new Set(set.entities.map((x) => x.id)))
        result = this.canonical(
          inputs[0].type,
          step.set === 'union'
            ? inputs.flatMap((x) => x.entities)
            : inputs[0].entities.filter((x) =>
                step.set === 'intersect'
                  ? rest.every((ids) => ids.has(x.id))
                  : rest.every((ids) => !ids.has(x.id))
              )
        )
      } else {
        const input = sets.get(step.from)!
        const relation = step.follow
        await this.ready(
          relation === 'contains' || relation === 'containedBy'
            ? 'STRUCTURE'
            : relation === 'dependencies' || relation === 'references'
              ? 'SYMBOL_REFERENCES'
              : 'RELATIONSHIPS'
        )
        const ids = new Set(input.entities.map((x) => x.id))
        if (relation === 'contains' || relation === 'containedBy') {
          const parents = new Set(
            input.entities.map((x) => (x as CodeMapElement).parentElementId).filter(Boolean)
          )
          result = this.canonical(
            'element-set',
            this.getElements().filter((x) =>
              relation === 'contains'
                ? !!x.parentElementId && ids.has(x.parentElementId)
                : parents.has(x.id)
            )
          )
        } else if (relation === 'references' || relation === 'dependencies') {
          const refs = input.entities.flatMap((x) =>
            relation === 'references'
              ? this.map.getSymbolReferencesByTargetElement(this.repo, x.id)
              : this.map.getSymbolReferencesBySourceElement(this.repo, x.id)
          )
          const targets = new Set(refs.map((x) => x.targetElementId))
          result =
            relation === 'references'
              ? this.canonical('reference-set', refs)
              : this.canonical(
                  'element-set',
                  this.getElements().filter((x) => targets.has(x.id))
                )
        } else if (relation === 'imports' || relation === 'importedBy') {
          const edges = this.map.getRelationships(this.repo)
          const targets = new Set<string>()
          if (input.type === 'element-set') {
            if (input.entities.some((x) => (x as CodeMapElement).kind !== 'import'))
              throw new DashError('TYPE_MISMATCH', 'imports requires import elements', step.id)
            for (const edge of edges)
              if (
                edge.type === 'imports' &&
                edge.sourceKind === 'element' &&
                ids.has(edge.sourceId) &&
                edge.targetKind === 'file'
              )
                targets.add(edge.targetId)
          } else {
            const graph = projectFileRelationships(this.getFiles(), this.getElements(), edges)
            for (const id of ids)
              for (const target of (relation === 'imports' ? graph.out : graph.in).get(id) ?? [])
                targets.add(target)
          }
          result = this.canonical(
            'file-set',
            this.getFiles().filter((x) => targets.has(x.id))
          )
        } else {
          const reverse = relation === 'extendedBy' || relation === 'implementedBy'
          const kind =
            relation === 'extends' || relation === 'extendedBy' ? 'extends' : 'implements'
          const targets = new Set(
            this.map
              .getRelationships(this.repo)
              .filter(
                (edge) =>
                  edge.type === kind &&
                  edge.sourceKind === 'element' &&
                  edge.targetKind === 'element' &&
                  ids.has(reverse ? edge.targetId : edge.sourceId)
              )
              .map((edge) => (reverse ? edge.sourceId : edge.targetId))
          )
          result = this.canonical(
            'element-set',
            this.getElements().filter((x) => targets.has(x.id))
          )
        }
      }
      report.steps.push({ id: step.id, type: result.type, count: result.entities.length })
      if (result.entities.length < step.expect.min || result.entities.length > step.expect.max)
        throw new DashError(
          result.entities.length === 0 ? 'NOT_FOUND' : 'CARDINALITY_MISMATCH',
          `Expected ${step.expect.min}–${step.expect.max}; found ${result.entities.length}`,
          step.id
        )
      sets.set(step.id, result)
    }
    return sets
  }
}
