import type { DashErrorCode, DashRequest, DashSetType } from '../../../shared/types/dash-types'
import { DASH_FIELDS, DASH_PROTOCOL_VERSION } from '../../../shared/utils/dash-protocol'

export class DashError extends Error {
  constructor(
    public readonly code: DashErrorCode,
    message: string,
    public readonly step?: string
  ) {
    super(message)
  }
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
function fail(code: DashErrorCode, message: string): never {
  throw new DashError(code, message)
}
function keys(v: Record<string, unknown>, allowed: readonly string[]) {
  for (const key of Object.keys(v))
    if (!allowed.includes(key)) fail('UNKNOWN_FIELD', `Unknown field: ${key}`)
}
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim().length > 0)
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const fileFilters = ['path', 'language', 'extension', 'status', 'contextReference']
const elementFilters = [
  'name',
  'kind',
  'signature',
  'path',
  'visibility',
  'granularity',
  'retrievable'
]
const enums: Record<string, readonly (string | boolean | null)[]> = {
  status: ['indexed', 'modified'],
  kind: [
    'class',
    'function',
    'method',
    'interface',
    'enum',
    'typeAlias',
    'variable',
    'constant',
    'import',
    'export',
    'property',
    'parameter',
    'enumMember',
    'cssRule',
    'cssAtRule',
    'cssCustomProperty',
    'document',
    'section'
  ],
  visibility: ['public', 'private', 'protected', null],
  granularity: ['structural', 'member', 'syntax'],
  retrievable: [true, false]
}
export function validateDashRequest(
  input: unknown
):
  | { success: true; request: DashRequest }
  | { success: false; code: DashErrorCode; error: string } {
  try {
    if (!object(input)) fail('INVALID_STEP', 'Request must be an object')
    keys(input, ['protocol', 'intent', 'steps', 'emit', 'limits'])
    if (input.protocol !== DASH_PROTOCOL_VERSION) fail('UNKNOWN_PROTOCOL', 'Expected code-dash/v2')
    if (input.intent !== undefined && typeof input.intent !== 'string')
      fail('INVALID_STEP', 'intent must be text')
    if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 100)
      fail('INVALID_STEP', 'steps must contain 1–100 entries')
    const types = new Map<string, DashSetType>()
    for (const step of input.steps) {
      if (!object(step) || typeof step.id !== 'string' || !step.id.trim())
        fail('INVALID_STEP', 'Step requires id')
      if (types.has(step.id)) fail('DUPLICATE_STEP_ID', `Duplicate id: ${step.id}`)
      if (!object(step.expect)) fail('INVALID_STEP', `Explicit expect required: ${step.id}`)
      keys(step.expect, ['min', 'max'])
      if (
        !integer(step.expect.min) ||
        !integer(step.expect.max) ||
        step.expect.min > step.expect.max
      )
        fail('INVALID_STEP', 'Invalid cardinality interval')
      let type: DashSetType
      if ('find' in step) {
        keys(step, ['id', 'find', 'where', 'expect'])
        if (step.find !== 'file' && step.find !== 'element')
          fail('UNKNOWN_OPERATOR', 'Unknown find entity')
        if (!object(step.where) || !Object.keys(step.where).length)
          fail('INVALID_FILTER', 'find requires filters')
        keys(step.where, step.find === 'file' ? fileFilters : elementFilters)
        for (const [field, filter] of Object.entries(step.where)) {
          if (!object(filter) || !Object.keys(filter).length) fail('INVALID_FILTER', 'Empty filter')
          keys(
            filter,
            enums[field]
              ? ['exact', 'in']
              : ['exact', 'contains', 'containsAny', 'containsAll', 'startsWith']
          )
          for (const [op, value] of Object.entries(filter)) {
            if (enums[field]) {
              const values = op === 'in' ? value : [value]
              if (
                !Array.isArray(values) ||
                !values.length ||
                !values.every((x) => enums[field].includes(x))
              )
                fail('INVALID_FILTER', `Invalid ${field}`)
            } else if (op === 'containsAny' || op === 'containsAll') {
              if (!strings(value)) fail('INVALID_FILTER', 'Expected nonempty text array')
            } else if (typeof value !== 'string' || !value.trim())
              fail('INVALID_FILTER', 'Expected nonempty text')
          }
        }
        type = step.find === 'file' ? 'file-set' : 'element-set'
      } else if ('follow' in step) {
        keys(step, ['id', 'from', 'follow', 'expect'])
        if (typeof step.from !== 'string' || !types.has(step.from))
          fail('UNKNOWN_STEP_REFERENCE', 'from must reference a previous step')
        const relation = step.follow
        if (
          ![
            'contains',
            'containedBy',
            'imports',
            'importedBy',
            'extends',
            'extendedBy',
            'implements',
            'implementedBy',
            'dependencies',
            'references'
          ].includes(String(relation))
        )
          fail('UNKNOWN_OPERATOR', 'Unknown follow operator')
        const source = types.get(step.from)!
        if (
          relation === 'imports'
            ? source === 'reference-set'
            : relation === 'importedBy'
              ? source !== 'file-set'
              : source !== 'element-set'
        )
          fail('TYPE_MISMATCH', 'Incompatible follow input')
        type =
          relation === 'references'
            ? 'reference-set'
            : relation === 'imports' || relation === 'importedBy'
              ? 'file-set'
              : 'element-set'
      } else if ('set' in step) {
        keys(step, ['id', 'from', 'set', 'expect'])
        if (!['union', 'intersect', 'subtract'].includes(String(step.set)))
          fail('UNKNOWN_OPERATOR', 'Unknown set operator')
        if (!strings(step.from) || step.from.length < 2 || step.from.some((x) => !types.has(x)))
          fail('UNKNOWN_STEP_REFERENCE', 'set requires at least two previous steps')
        type = types.get(step.from[0])!
        if (step.from.some((x) => types.get(x) !== type)) fail('TYPE_MISMATCH', 'Set types differ')
      } else fail('INVALID_STEP', 'Expected find, follow or set')
      types.set(step.id, type)
    }
    if (!Array.isArray(input.emit) || !input.emit.length)
      fail('INVALID_STEP', 'emit must be nonempty')
    for (const emit of input.emit) {
      if (!object(emit)) fail('INVALID_STEP', 'Invalid emit')
      keys(emit, ['from', 'include'])
      if (typeof emit.from !== 'string' || !types.has(emit.from))
        fail('UNKNOWN_STEP_REFERENCE', 'Unknown emit step')
      const fields: readonly string[] = DASH_FIELDS[types.get(emit.from)!]
      if (!strings(emit.include) || emit.include.some((x) => !fields.includes(x)))
        fail('TYPE_MISMATCH', 'Invalid projection')
    }
    if (input.limits !== undefined) {
      if (!object(input.limits)) fail('INVALID_STEP', 'Invalid limits')
      keys(input.limits, ['maxTokens'])
      if (!integer(input.limits.maxTokens) || input.limits.maxTokens === 0)
        fail('INVALID_STEP', 'maxTokens must be positive')
    }
    return { success: true, request: input as unknown as DashRequest }
  } catch (error) {
    if (!(error instanceof DashError)) throw error
    return { success: false, code: error.code, error: error.message }
  }
}
