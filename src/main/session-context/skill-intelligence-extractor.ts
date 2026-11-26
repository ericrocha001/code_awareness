import { classifyStructuredOutput, extractTextValue } from './native-source-events'
import { digest, sanitize } from './privacy'
import type {
  SkillDeliveryGranularity,
  SkillEventInput,
  SkillObservationClass,
  SkillOperationStatus,
  SkillScope
} from './skill-intelligence-store'

export const SKILL_EXTRACTOR_VERSION = 'skill-extractor/v2'

export type CanonicalSkillTool =
  | 'get_academy_skill'
  | 'get_academy_skill_history'
  | 'list_academy_skills'
  | 'skills/get'
  | 'skills/list'
  | 'resources/read'

const EXACT_SKILL_TOOLS = new Set<CanonicalSkillTool>([
  'get_academy_skill',
  'get_academy_skill_history',
  'list_academy_skills',
  'skills/get',
  'skills/list',
  'resources/read'
])

const CONFIRMED_MCP_PREFIXES = [
  'mcp__code_awareness__',
  'mcp__code_awareness_local__',
  'mcp__code-awareness__',
  'mcp__code-awareness-local__'
]

const SHA256_RE = /^[a-f0-9]{64}$/i

export function resolveCanonicalSkillTool(toolName: string | undefined | null): CanonicalSkillTool | null {
  if (typeof toolName !== 'string' || toolName.length === 0) return null
  if (EXACT_SKILL_TOOLS.has(toolName as CanonicalSkillTool)) {
    return toolName as CanonicalSkillTool
  }
  for (const prefix of CONFIRMED_MCP_PREFIXES) {
    if (toolName.startsWith(prefix)) {
      const stripped = toolName.slice(prefix.length)
      if (EXACT_SKILL_TOOLS.has(stripped as CanonicalSkillTool)) {
        return stripped as CanonicalSkillTool
      }
      return null
    }
  }
  return null
}

export interface CompactSkillCallArgs {
  skillId?: string
  uri?: string
  view?: 'package' | 'manifest' | 'resource' | 'outline' | 'section' | 'search'
  path?: string
  selector?: string
  declaredVersion?: number
  declaredPackageHash?: string
  metadataOnly?: boolean
  textOffset?: number
  textLimit?: number
  offset?: number
  limit?: number
}

function parsePlainJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function parseJsonValue(raw: string): unknown | undefined {
  const trimmed = raw.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function safePositiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : undefined
}

function safeNonNegInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined
}

function safeShortString(v: unknown, maxLen = 256): string | undefined {
  if (typeof v !== 'string' || v.length === 0 || v.length > maxLen) return undefined
  return sanitize(v)
}

export function extractSkillCallMetadata(canonicalTool: CanonicalSkillTool, rawArgsText: string): CompactSkillCallArgs {
  const obj = parsePlainJsonObject(rawArgsText)
  if (!obj) return {}
  const viewRaw = obj.view
  const view =
    viewRaw === 'package' ||
    viewRaw === 'manifest' ||
    viewRaw === 'resource' ||
    viewRaw === 'outline' ||
    viewRaw === 'section' ||
    viewRaw === 'search'
      ? viewRaw
      : undefined
  const declaredPackageHash =
    typeof obj.expectedPackageHash === 'string' && SHA256_RE.test(obj.expectedPackageHash)
      ? obj.expectedPackageHash.toLowerCase()
      : undefined
  const uri = typeof obj.uri === 'string' && obj.uri.length <= 512 ? sanitize(obj.uri) : undefined
  return {
    ...(safeShortString(obj.skillId, 200) ? { skillId: safeShortString(obj.skillId, 200) } : {}),
    ...(uri ? { uri } : {}),
    ...(canonicalTool === 'get_academy_skill' && view ? { view } : {}),
    ...(safeShortString(obj.path, 256) ? { path: safeShortString(obj.path, 256) } : {}),
    ...(safeShortString(obj.selector, 256) ? { selector: safeShortString(obj.selector, 256) } : {}),
    ...(safePositiveInt(obj.version) !== undefined ? { declaredVersion: safePositiveInt(obj.version) } : {}),
    ...(declaredPackageHash ? { declaredPackageHash } : {}),
    ...(typeof obj.metadataOnly === 'boolean' ? { metadataOnly: obj.metadataOnly } : {}),
    ...(safeNonNegInt(obj.textOffset) !== undefined ? { textOffset: safeNonNegInt(obj.textOffset) } : {}),
    ...(safePositiveInt(obj.textLimit) !== undefined ? { textLimit: safePositiveInt(obj.textLimit) } : {}),
    ...(safeNonNegInt(obj.offset) !== undefined ? { offset: safeNonNegInt(obj.offset) } : {}),
    ...(safePositiveInt(obj.limit) !== undefined ? { limit: safePositiveInt(obj.limit) } : {})
  }
}

function unwrapMcpResultEnvelope(rawOutput: string): {
  envelopeIsError: boolean
  resultObj?: Record<string, unknown>
  resultArray?: unknown[]
  textPayload: string
  jsonParseFailed: boolean
} {
  const trimmed = rawOutput.trim()
  if (!trimmed) {
    return { envelopeIsError: false, textPayload: '', jsonParseFailed: false }
  }
  const parsed = parseJsonValue(trimmed)
  if (parsed === undefined) {
    const looksLikeTruncatedJson = trimmed.startsWith('{') || trimmed.startsWith('[')
    return { envelopeIsError: false, textPayload: rawOutput, jsonParseFailed: looksLikeTruncatedJson }
  }
  if (Array.isArray(parsed)) {
    return { envelopeIsError: false, resultArray: parsed, textPayload: rawOutput, jsonParseFailed: false }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { envelopeIsError: false, textPayload: rawOutput, jsonParseFailed: false }
  }
  const obj = parsed as Record<string, unknown>
  const envelopeIsError = obj.isError === true

  // MCP CallToolResult envelope with structuredContent or content[]
  if ('structuredContent' in obj && obj.structuredContent && typeof obj.structuredContent === 'object' && !Array.isArray(obj.structuredContent)) {
    const textFromContent = Array.isArray(obj.content) ? extractTextValue(obj.content) : rawOutput
    return {
      envelopeIsError,
      resultObj: obj.structuredContent as Record<string, unknown>,
      textPayload: textFromContent || rawOutput,
      jsonParseFailed: false
    }
  }
  if (Array.isArray(obj.content)) {
    const textFromContent = extractTextValue(obj.content)
    const innerParsed = parseJsonValue(textFromContent)
    if (innerParsed && typeof innerParsed === 'object' && !Array.isArray(innerParsed)) {
      return {
        envelopeIsError,
        resultObj: innerParsed as Record<string, unknown>,
        textPayload: textFromContent,
        jsonParseFailed: false
      }
    }
    if (Array.isArray(innerParsed)) {
      return {
        envelopeIsError,
        resultArray: innerParsed,
        textPayload: textFromContent,
        jsonParseFailed: false
      }
    }
    const innerTruncated = textFromContent.trim().startsWith('{') || textFromContent.trim().startsWith('[')
    return {
      envelopeIsError,
      textPayload: textFromContent,
      jsonParseFailed: innerTruncated
    }
  }

  return {
    envelopeIsError,
    resultObj: obj,
    textPayload: rawOutput,
    jsonParseFailed: false
  }
}

function inferSkillScope(resultObj?: Record<string, unknown>, uri?: string): SkillScope {
  const scopeRaw = resultObj?.scope
  if (scopeRaw === 'GLOBAL' || scopeRaw === 'PROJECT') return scopeRaw
  if (uri?.startsWith('skill://global/')) return 'GLOBAL'
  if (uri?.startsWith('skill://project/')) return 'PROJECT'
  return 'UNKNOWN'
}

function parseSkillUriParts(uri?: string): { scope?: SkillScope; destinationId?: string; skillId?: string; resourcePath?: string } {
  if (!uri || !uri.startsWith('skill://')) return {}
  const rest = uri.slice('skill://'.length)
  const parts = rest.split('/')
  if (parts[0] === 'global' && parts.length >= 2) {
    return {
      scope: 'GLOBAL',
      skillId: parts[1] || undefined,
      resourcePath: parts.length >= 4 ? parts.slice(3).join('/') : undefined
    }
  }
  if (parts[0] === 'project' && parts.length >= 3) {
    return {
      scope: 'PROJECT',
      destinationId: parts[1] || undefined,
      skillId: parts[2] || undefined,
      resourcePath: parts.length >= 5 ? parts.slice(4).join('/') : undefined
    }
  }
  return {}
}

function extractResourceRange(
  resultObj: Record<string, unknown> | undefined,
  callArgs: CompactSkillCallArgs
): Record<string, unknown> | null {
  const rangeObj = resultObj?.range && typeof resultObj.range === 'object' && !Array.isArray(resultObj.range)
    ? (resultObj.range as Record<string, unknown>)
    : undefined
  const out: Record<string, unknown> = {}
  if (rangeObj) {
    if (typeof rangeObj.startLine === 'number') out.startLine = rangeObj.startLine
    if (typeof rangeObj.endLine === 'number') out.endLine = rangeObj.endLine
    if (typeof rangeObj.startOffset === 'number') out.startOffset = rangeObj.startOffset
    if (typeof rangeObj.endOffset === 'number') out.endOffset = rangeObj.endOffset
  }
  if (typeof resultObj?.offset === 'number') out.offset = resultObj.offset
  else if (callArgs.textOffset !== undefined) out.offset = callArgs.textOffset
  if (typeof resultObj?.totalCharacters === 'number') out.totalCharacters = resultObj.totalCharacters
  if (typeof resultObj?.nextOffset === 'number' || resultObj?.nextOffset === null) out.nextOffset = resultObj.nextOffset
  if (callArgs.textLimit !== undefined) out.textLimit = callArgs.textLimit
  return Object.keys(out).length > 0 ? out : null
}

export interface QualifySkillObservationParams {
  canonicalTool: CanonicalSkillTool
  callArgs?: CompactSkillCallArgs
  rawOutput?: string
  hasResult: boolean
  sessionId?: string | null
  executionId?: string | null
  nativeSessionId?: string | null
  repositoryId?: string | null
  provider?: string | null
  worktreeId?: string | null
  generation?: string | null
  sourceSurface: SkillEventInput['sourceSurface']
  sourceContract: string
  sourceNamespace?: string | null
  sourceRevision?: number | null
  callEventId?: string | null
  resultEventId?: string | null
  originalEventId?: string | null
  turnId?: string | null
  sessionBindingState: SkillEventInput['sessionBindingState']
  bindingAuthority?: string | null
  captureOrder?: number
  sourceTimestamp?: string | null
}

export function qualifySkillToolObservation(params: QualifySkillObservationParams): SkillEventInput | null {
  const callArgs = params.callArgs ?? {}
  const rawOutput = params.hasResult ? (params.rawOutput ?? '') : ''
  const unwrapped = params.hasResult
    ? unwrapMcpResultEnvelope(rawOutput)
    : { envelopeIsError: false, textPayload: '', jsonParseFailed: false }
  const resultObj = unwrapped.resultObj
  const resultArray = unwrapped.resultArray

  const contentsFirst =
    resultObj && Array.isArray(resultObj.contents) && resultObj.contents[0] && typeof resultObj.contents[0] === 'object'
      ? (resultObj.contents[0] as Record<string, unknown>)
      : undefined

  const uri =
    callArgs.uri ??
    (typeof resultObj?.uri === 'string' ? sanitize(resultObj.uri) : undefined) ??
    (typeof contentsFirst?.uri === 'string' ? sanitize(contentsFirst.uri) : undefined)

  // For resources/read, only qualify explicit skill:// URIs
  if (params.canonicalTool === 'resources/read' && (!uri || !uri.startsWith('skill://'))) {
    return null
  }

  const uriParts = parseSkillUriParts(uri)
  const skillId =
    safeShortString(resultObj?.id, 200) ??
    safeShortString(resultObj?.skillId, 200) ??
    callArgs.skillId ??
    uriParts.skillId ??
    null
  const skillName = safeShortString(resultObj?.name, 200) ?? null

  const statusInfo = params.hasResult
    ? classifyStructuredOutput(unwrapped.textPayload || rawOutput)
    : { isError: false, status: 'UNKNOWN' as const, errorKind: 'UNPAIRED_TOOL_CALL' }
  const isError = unwrapped.envelopeIsError || statusInfo.isError

  // Version & packageHash must be confirmed from result, NEVER promoted from request args alone
  const resultVersion = safePositiveInt(resultObj?.currentVersion ?? resultObj?.version) ?? null
  const currentObj = resultObj?.current && typeof resultObj.current === 'object' && !Array.isArray(resultObj.current)
    ? (resultObj.current as Record<string, unknown>)
    : undefined
  const resultPackageHashRaw =
    typeof resultObj?.packageHash === 'string' ? resultObj.packageHash :
    typeof currentObj?.packageHash === 'string' ? currentObj.packageHash :
    null
  const resultPackageHash =
    resultPackageHashRaw && SHA256_RE.test(resultPackageHashRaw) ? resultPackageHashRaw.toLowerCase() : null

  const gaps = new Set<string>()
  let version = resultVersion
  let packageHash = resultPackageHash
  if (callArgs.declaredVersion !== undefined && resultVersion !== null && callArgs.declaredVersion !== resultVersion) {
    gaps.add('VERSION_CONFLICT')
    version = null
  }
  if (callArgs.declaredPackageHash !== undefined && resultPackageHash !== null && callArgs.declaredPackageHash !== resultPackageHash) {
    gaps.add('PACKAGE_HASH_CONFLICT')
    version = null
    packageHash = null
  }
  const versionStatus = version !== null ? 'EXACT' : 'VERSION_UNKNOWN'
  if (versionStatus === 'VERSION_UNKNOWN') gaps.add('VERSION_UNKNOWN')

  const resourcePath =
    safeShortString(resultObj?.path, 256) ??
    callArgs.path ??
    uriParts.resourcePath ??
    null
  const resourceSelector =
    safeShortString(resultObj?.selector, 256) ??
    callArgs.selector ??
    null
  const resourceRange = extractResourceRange(resultObj, callArgs)

  let resourceDigest: string | null = null
  if (typeof resultObj?.content === 'string') {
    resourceDigest = digest(resultObj.content)
  } else if (typeof contentsFirst?.text === 'string') {
    resourceDigest = digest(contentsFirst.text)
  } else if (params.canonicalTool === 'resources/read' && !isError && unwrapped.textPayload.length > 0 && !resultObj) {
    resourceDigest = digest(unwrapped.textPayload)
  }

  let observationClass: SkillObservationClass
  let operationStatus: SkillOperationStatus
  let deliveryGranularity: SkillDeliveryGranularity = 'NONE'
  let errorCode: string | null = statusInfo.errorKind ?? null

  if (!params.hasResult) {
    observationClass = 'ATTEMPT_FAILED_OR_REFUSED'
    operationStatus = 'UNKNOWN'
    errorCode = 'UNPAIRED_TOOL_CALL'
    gaps.add('TOOL_RESULT_MISSING')
  } else if (isError) {
    observationClass = 'ATTEMPT_FAILED_OR_REFUSED'
    operationStatus = statusInfo.status === 'REFUSAL' ? 'REFUSAL' : 'FAILURE'
    if (unwrapped.envelopeIsError && !errorCode) {
      errorCode = typeof resultObj?.code === 'string' ? resultObj.code : 'TOOL_ERROR'
    }
  } else if (unwrapped.jsonParseFailed || rawOutput.trim().length === 0) {
    observationClass = 'INDETERMINATE'
    operationStatus = 'UNKNOWN'
    errorCode = unwrapped.jsonParseFailed ? 'TRUNCATED_OR_INVALID_JSON' : 'EMPTY_TOOL_OUTPUT'
    gaps.add('INDETERMINATE_RESPONSE_SHAPE')
  } else if (params.canonicalTool === 'list_academy_skills' || params.canonicalTool === 'skills/list') {
    const validList =
      Boolean(resultArray) ||
      Boolean(resultObj && (Array.isArray(resultObj.items) || Array.isArray(resultObj.skills)))
    if (validList) {
      observationClass = 'DISCOVERED_MANIFEST_FETCHED'
      operationStatus = 'SUCCESS'
      deliveryGranularity = 'MANIFEST'
    } else {
      observationClass = 'INDETERMINATE'
      operationStatus = 'UNKNOWN'
      gaps.add('INDETERMINATE_RESPONSE_SHAPE')
    }
  } else if (params.canonicalTool === 'skills/get') {
    const validSkillGet = Boolean(resultObj && (typeof resultObj.uri === 'string' || typeof resultObj.id === 'string' || typeof resultObj.name === 'string'))
    if (validSkillGet) {
      observationClass = 'DISCOVERED_MANIFEST_FETCHED'
      operationStatus = 'SUCCESS'
      deliveryGranularity = 'MANIFEST'
    } else {
      observationClass = 'INDETERMINATE'
      operationStatus = 'UNKNOWN'
      gaps.add('INDETERMINATE_RESPONSE_SHAPE')
    }
  } else if (params.canonicalTool === 'get_academy_skill_history') {
    const hasFullPackage = Boolean(resultObj?.package && typeof resultObj.package === 'object' && !Array.isArray(resultObj.package))
    const isMetaList = Boolean(resultArray) || Boolean(resultObj && Array.isArray(resultObj.items))
    if (callArgs.metadataOnly === true || isMetaList) {
      observationClass = 'DISCOVERED_MANIFEST_FETCHED'
      operationStatus = 'SUCCESS'
      deliveryGranularity = 'MANIFEST'
    } else if (hasFullPackage && resultVersion !== null) {
      observationClass = 'CONTENT_DELIVERED'
      operationStatus = 'SUCCESS'
      deliveryGranularity = 'FULL_PACKAGE'
    } else {
      observationClass = 'INDETERMINATE'
      operationStatus = 'UNKNOWN'
      gaps.add('INDETERMINATE_RESPONSE_SHAPE')
    }
  } else if (params.canonicalTool === 'get_academy_skill') {
    const view = callArgs.view ?? (
      resultObj && Array.isArray(resultObj.files) ? 'manifest' :
      resultObj && Array.isArray(resultObj.entries) ? 'outline' :
      resultObj && Array.isArray(resultObj.matches) ? 'search' :
      resultObj && typeof resultObj.content === 'string' && typeof resultObj.selector === 'string' ? 'section' :
      resultObj && typeof resultObj.content === 'string' && typeof resultObj.path === 'string' ? 'resource' :
      'package'
    )
    if (view === 'manifest' || view === 'outline' || view === 'search') {
      const validDiscovery = Boolean(
        resultObj &&
        typeof (resultObj.skillId ?? resultObj.id) === 'string' &&
        (
          (view === 'manifest' && Array.isArray(resultObj.files)) ||
          (view === 'outline' && Array.isArray(resultObj.entries)) ||
          (view === 'search' && Array.isArray(resultObj.matches))
        )
      )
      if (validDiscovery) {
        observationClass = 'DISCOVERED_MANIFEST_FETCHED'
        operationStatus = 'SUCCESS'
        deliveryGranularity = 'MANIFEST'
      } else {
        observationClass = 'INDETERMINATE'
        operationStatus = 'UNKNOWN'
        gaps.add('INDETERMINATE_RESPONSE_SHAPE')
      }
    } else if (view === 'resource' || view === 'section') {
      const validFragment = Boolean(
        resultObj &&
        typeof (resultObj.skillId ?? resultObj.id) === 'string' &&
        typeof resultObj.path === 'string' &&
        typeof resultObj.content === 'string'
      )
      if (validFragment) {
        observationClass = 'CONTENT_DELIVERED'
        operationStatus = 'SUCCESS'
        deliveryGranularity = 'FRAGMENT'
      } else {
        observationClass = 'INDETERMINATE'
        operationStatus = 'UNKNOWN'
        gaps.add('INDETERMINATE_RESPONSE_SHAPE')
      }
    } else {
      const hasPackagePayload = Boolean(
        resultObj &&
        typeof resultObj.id === 'string' &&
        (
          (resultObj.current && typeof resultObj.current === 'object' && !Array.isArray(resultObj.current)) ||
          (resultObj.package && typeof resultObj.package === 'object' && !Array.isArray(resultObj.package))
        )
      )
      if (hasPackagePayload) {
        observationClass = 'CONTENT_DELIVERED'
        operationStatus = 'SUCCESS'
        deliveryGranularity = 'FULL_PACKAGE'
      } else {
        observationClass = 'INDETERMINATE'
        operationStatus = 'UNKNOWN'
        gaps.add('INDETERMINATE_RESPONSE_SHAPE')
      }
    }
  } else {
    // resources/read with skill:// URI
    const hasReadResourceContent =
      (contentsFirst && typeof contentsFirst.text === 'string' && contentsFirst.text.length > 0 &&
        (!contentsFirst.uri || (typeof contentsFirst.uri === 'string' && contentsFirst.uri.startsWith('skill://')))) ||
      (!resultObj && !resultArray && unwrapped.textPayload.trim().length > 0)
    if (hasReadResourceContent) {
      observationClass = 'CONTENT_DELIVERED'
      operationStatus = 'SUCCESS'
      deliveryGranularity = 'RESOURCE'
    } else {
      observationClass = 'INDETERMINATE'
      operationStatus = 'UNKNOWN'
      gaps.add('INDETERMINATE_RESPONSE_SHAPE')
    }
  }

  return {
    sessionId: params.sessionId ?? null,
    executionId: params.executionId ?? null,
    nativeSessionId: params.nativeSessionId ?? null,
    repositoryId: params.repositoryId ?? null,
    provider: params.provider ?? null,
    worktreeId: params.worktreeId ?? null,
    generation: params.generation ?? null,
    observationClass,
    skillId,
    skillName,
    skillScope: inferSkillScope(resultObj, uri) !== 'UNKNOWN' ? inferSkillScope(resultObj, uri) : (uriParts.scope ?? 'UNKNOWN'),
    destinationId: uriParts.destinationId ?? null,
    version,
    versionStatus,
    packageHash,
    resourceUri: uri ?? null,
    resourcePath,
    resourceSelector,
    resourceRange,
    resourceDigest,
    deliveryGranularity,
    sourceSurface: params.sourceSurface,
    sourceContract: params.sourceContract,
    sourceNamespace: params.sourceNamespace ?? null,
    sourceRevision: params.sourceRevision ?? null,
    callEventId: params.callEventId ?? null,
    resultEventId: params.resultEventId ?? null,
    originalEventId: params.originalEventId ?? params.resultEventId ?? params.callEventId ?? null,
    turnId: params.turnId ?? null,
    operation: params.canonicalTool,
    operationStatus,
    errorCode,
    sessionBindingState: params.sessionBindingState,
    bindingAuthority: params.bindingAuthority ?? null,
    captureOrder: params.captureOrder ?? 0,
    sourceTimestamp: params.sourceTimestamp ?? null,
    timestampKind: params.sourceTimestamp ? 'SOURCE_TIMESTAMP' : 'CAPTURE_TIME',
    extractorVersion: SKILL_EXTRACTOR_VERSION,
    gaps: [...gaps]
  }
}
