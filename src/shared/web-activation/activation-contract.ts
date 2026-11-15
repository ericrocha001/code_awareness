export const ACTIVATION_CONTRACT_PROTOCOL = 'code-awareness-activation/v1'
export const CALL_FENCE_LANGUAGE = 'code-awareness-call'
export const RESULT_FENCE_LANGUAGE = 'code-awareness-result'

export type ActivationMethod =
  | 'skills.load'
  | 'skills/list'
  | 'skills/get'
  | 'resources.read'
  | 'resources/read'
  | 'resources/list'
  | 'tools.schema'
  | 'tools/describe'
  | 'tools.call'
  | 'tools/call'

const SUPPORTED_ACTIVATION_METHODS = new Set<string>([
  'skills.load',
  'skills/list',
  'skills/get',
  'resources.read',
  'resources/read',
  'resources/list',
  'tools.schema',
  'tools/describe',
  'tools.call',
  'tools/call'
])

const INTERNAL_MODEL_PROJECTION_STRIP_KEYS = new Set<string>([
  'digest',
  'size',
  'ttlMs',
  'cacheScope',
  'catalogRevision',
  'contentHash',
  'packageHash',
  'securitySchemes'
])

export interface BootstrapSkillSummary {
  server: string
  name: string
  description: string
  uri?: string
  scope?: 'global' | 'project' | 'unknown'
}

export interface BootstrapToolSummary {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface ActivationBootstrapInput {
  site: 'deepseek' | 'qwen' | string
  mode: 'PROJECT' | 'GLOBAL_ONLY'
  projectId: string | null
  skills: readonly BootstrapSkillSummary[]
  tools?: readonly BootstrapToolSummary[]
  sessionNonce?: string
}

export interface AssistantTurnInput {
  role: 'assistant' | 'user' | 'system'
  isComplete: boolean
  text: string
  messageId?: string
  seenRequestIds?: ReadonlySet<string>
}

export interface ParsedActivationCall {
  protocol: typeof ACTIVATION_CONTRACT_PROTOCOL
  requestId: string
  method: ActivationMethod
  params: Record<string, unknown>
}

export interface RejectedActivationEnvelope {
  code:
    | 'MALFORMED_JSON'
    | 'INVALID_PROTOCOL'
    | 'INVALID_REQUEST_ID'
    | 'DUPLICATE_REQUEST_ID'
    | 'BATCHING_NOT_SUPPORTED'
    | 'UNSUPPORTED_METHOD'
    | 'INVALID_PARAMS'
  message: string
  raw: string
}

export interface ParseActivationTurnResult {
  ignoredReason?: 'NON_ASSISTANT_ROLE' | 'INCOMPLETE_TURN'
  calls: ParsedActivationCall[]
  rejected: RejectedActivationEnvelope[]
}

export interface ActivationEnvelopeResultPayload {
  protocol: typeof ACTIVATION_CONTRACT_PROTOCOL
  requestId: string
  server: string
  ok: boolean
  result?: unknown
  error?: {
    code: string
    message: string
  }
}

export function buildActivationBootstrapMessage(input: ActivationBootstrapInput): string {
  const scopeLabel =
    input.mode === 'PROJECT' && input.projectId
      ? `PROJECT (${input.projectId})`
      : 'GLOBAL_ONLY'

  const skillLines =
    input.skills.length > 0
      ? input.skills.map(
          (skill) =>
            `- ${skill.name}${skill.uri ? ` (${skill.uri})` : ''} [${skill.server}${skill.scope ? `, ${skill.scope}` : ''}]: ${skill.description}`
        )
      : ['- (no skills available in current scope)']

  return [
    `[Code Awareness Local Context — ${ACTIVATION_CONTRACT_PROTOCOL}]`,
    `Scope: ${scopeLabel} | Site: ${input.site}${input.sessionNonce ? ` | SessionEpoch: ${input.sessionNonce}` : ''}`,
    '',
    'Skill bodies, MCP tool inventories/schemas, and workspace files are NOT preloaded.',
    'Activate a skill ONLY when the user request clearly benefits from it; otherwise answer directly without emitting any call block.',
    'To activate a skill, output ONE fenced `code-awareness-call` JSON block calling `skills.load` and wait for `code-awareness-result`:',
    '',
    '```code-awareness-call',
    `{"protocol":"${ACTIVATION_CONTRACT_PROTOCOL}","requestId":"req-1","method":"skills.load","params":{"uri":"<skill-uri>"}}`,
    '```',
    '',
    'Rules:',
    '- One request per envelope (`requests[]` batching is not supported).',
    '- `skills.load` delivers verified `SKILL.md` and a short inventory of read-only tools.',
    '- Request tool schemas on demand via `tools.schema` before `tools.call`.',
    '- Never invent or cite unverified rules, files, or tool results.',
    '',
    'Available Skills Catalog (name + description + uri):',
    ...skillLines,
    '',
    'Reply briefly confirming readiness so I can ask my question.'
  ].join('\n')
}

interface ExtractedFenceBlock {
  info: string
  body: string
}

function extractTopLevelCallBlocks(markdown: string): ExtractedFenceBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: ExtractedFenceBlock[] = []

  let activeOuterFence: { char: '`' | '~'; length: number } | null = null
  let activeCallFence: { char: '`' | '~'; length: number; info: string; lines: string[] } | null = null

  for (const rawLine of lines) {
    if (activeCallFence) {
      const closeMatch = new RegExp(`^ {0,3}${activeCallFence.char}{${activeCallFence.length},}[ \\t]*$`).exec(rawLine)
      if (closeMatch) {
        blocks.push({ info: activeCallFence.info, body: activeCallFence.lines.join('\n') })
        activeCallFence = null
      } else {
        activeCallFence.lines.push(rawLine)
      }
      continue
    }

    if (activeOuterFence) {
      const closeMatch = new RegExp(`^ {0,3}${activeOuterFence.char}{${activeOuterFence.length},}[ \\t]*$`).exec(rawLine)
      if (closeMatch) {
        activeOuterFence = null
      }
      continue
    }

    // Ignore blockquotes so quoted tutorial examples inside assistant answers are never executed
    if (/^\s*>/.test(rawLine)) {
      continue
    }

    const openMatch = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(rawLine)
    if (!openMatch) {
      continue
    }

    const fenceToken = openMatch[1]
    const fenceChar = fenceToken[0] as '`' | '~'
    const info = openMatch[2].trim()

    if (info === CALL_FENCE_LANGUAGE) {
      activeCallFence = { char: fenceChar, length: fenceToken.length, info, lines: [] }
    } else {
      activeOuterFence = { char: fenceChar, length: fenceToken.length }
    }
  }

  return blocks
}

function validateMethodParams(
  method: ActivationMethod,
  params: Record<string, unknown>
): string | null {
  switch (method) {
    case 'skills.load':
    case 'skills/get': {
      const hasName = typeof params.name === 'string' && params.name.trim().length > 0
      const hasUri = typeof params.uri === 'string' && params.uri.trim().length > 0
      return hasName || hasUri ? null : `${method} requires non-empty params.name or params.uri`
    }
    case 'resources.read':
    case 'resources/read': {
      return typeof params.uri === 'string' && params.uri.trim().length > 0
        ? null
        : `${method} requires non-empty params.uri`
    }
    case 'tools.schema':
    case 'tools/describe': {
      const hasSingle = typeof params.name === 'string' && params.name.trim().length > 0
      const hasList =
        Array.isArray(params.names) &&
        params.names.some((entry) => typeof entry === 'string' && entry.trim().length > 0)
      return hasSingle || hasList
        ? null
        : `${method} requires non-empty params.name or non-empty params.names array`
    }
    case 'tools.call':
    case 'tools/call': {
      return typeof params.name === 'string' && params.name.trim().length > 0
        ? null
        : `${method} requires non-empty params.name`
    }
    default:
      return null
  }
}

export function parseActivationCallEnvelopes(turn: AssistantTurnInput): ParseActivationTurnResult {
  if (turn.role !== 'assistant') {
    return { ignoredReason: 'NON_ASSISTANT_ROLE', calls: [], rejected: [] }
  }
  if (!turn.isComplete) {
    return { ignoredReason: 'INCOMPLETE_TURN', calls: [], rejected: [] }
  }

  const candidateBlocks = extractTopLevelCallBlocks(turn.text)
  const calls: ParsedActivationCall[] = []
  const rejected: RejectedActivationEnvelope[] = []
  const turnSeenIds = new Set<string>()

  for (const block of candidateBlocks) {
    const raw = block.body.trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      rejected.push({
        code: 'MALFORMED_JSON',
        message: 'Failed to parse JSON inside code-awareness-call block',
        raw
      })
      continue
    }

    if (Array.isArray(parsed)) {
      rejected.push({
        code: 'BATCHING_NOT_SUPPORTED',
        message: 'Only one request per envelope is allowed; array batching is not supported',
        raw
      })
      continue
    }

    if (!parsed || typeof parsed !== 'object') {
      rejected.push({
        code: 'INVALID_PARAMS',
        message: 'Envelope payload must be a JSON object',
        raw
      })
      continue
    }

    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.requests)) {
      rejected.push({
        code: 'BATCHING_NOT_SUPPORTED',
        message: 'Only one request per envelope is allowed; requests[] batching is not supported',
        raw
      })
      continue
    }

    if (obj.protocol !== ACTIVATION_CONTRACT_PROTOCOL) {
      rejected.push({
        code: 'INVALID_PROTOCOL',
        message: `Expected protocol "${ACTIVATION_CONTRACT_PROTOCOL}"`,
        raw
      })
      continue
    }

    const requestId = typeof obj.requestId === 'string' ? obj.requestId.trim() : ''
    if (!requestId || requestId.length > 128) {
      rejected.push({
        code: 'INVALID_REQUEST_ID',
        message: 'Envelope requestId must be a non-empty string (<= 128 chars)',
        raw
      })
      continue
    }

    if (turnSeenIds.has(requestId) || turn.seenRequestIds?.has(requestId)) {
      rejected.push({
        code: 'DUPLICATE_REQUEST_ID',
        message: `Duplicate or replayed requestId "${requestId}"`,
        raw
      })
      continue
    }
    turnSeenIds.add(requestId)

    const method = typeof obj.method === 'string' ? obj.method.trim() : ''
    if (!SUPPORTED_ACTIVATION_METHODS.has(method)) {
      rejected.push({
        code: 'UNSUPPORTED_METHOD',
        message: `Method "${method}" is not supported by ${ACTIVATION_CONTRACT_PROTOCOL}`,
        raw
      })
      continue
    }

    const paramsValue = obj.params === undefined ? {} : obj.params
    if (!paramsValue || typeof paramsValue !== 'object' || Array.isArray(paramsValue)) {
      rejected.push({
        code: 'INVALID_PARAMS',
        message: 'Envelope params must be a JSON object when provided',
        raw
      })
      continue
    }

    const paramError = validateMethodParams(method as ActivationMethod, paramsValue as Record<string, unknown>)
    if (paramError) {
      rejected.push({
        code: 'INVALID_PARAMS',
        message: paramError,
        raw
      })
      continue
    }

    calls.push({
      protocol: ACTIVATION_CONTRACT_PROTOCOL,
      requestId,
      method: method as ActivationMethod,
      params: paramsValue as Record<string, unknown>
    })
  }

  return { calls, rejected }
}

export function sanitizeModelFacingValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return undefined
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeModelFacingValue(item, seen))
  }
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (INTERNAL_MODEL_PROJECTION_STRIP_KEYS.has(key)) continue
    if (entry === undefined) continue
    out[key] = sanitizeModelFacingValue(entry, seen)
  }
  return out
}

function maxBacktickRun(value: string): number {
  let max = 0
  for (const match of value.matchAll(/`+/g)) {
    if (match[0].length > max) {
      max = match[0].length
    }
  }
  return max
}

export function formatActivationResultEnvelope(payload: ActivationEnvelopeResultPayload): string {
  const safePayload: ActivationEnvelopeResultPayload = payload.ok
    ? { ...payload, result: sanitizeModelFacingValue(payload.result) }
    : payload
  // Escape closing slashes so literal XML/Markdown sequences inside returned text cannot spoof envelope closing tags
  const serialized = JSON.stringify(safePayload).replace(/<\//g, '<\\/')
  const fence = '`'.repeat(Math.max(3, maxBacktickRun(serialized) + 1))
  return [
    `${fence}${RESULT_FENCE_LANGUAGE}`,
    serialized,
    fence
  ].join('\n')
}
