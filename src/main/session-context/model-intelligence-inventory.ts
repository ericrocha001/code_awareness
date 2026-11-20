export const MODEL_INTELLIGENCE_INVENTORY_VERSION = 'model-intelligence-inventory-v1' as const

export type FieldDisposition =
  | 'PERSISTED'
  | 'REFERENCED'
  | 'DERIVABLE'
  | 'UNAVAILABLE'
  | 'UNSUPPORTED'
  | 'EXCLUDED_PRIVACY'

export type FieldGranularity = 'session' | 'turn' | 'call' | 'checkpoint' | 'task' | 'subagent'

export type FieldObservability = 'reported' | 'observed' | 'requested' | 'unknown'

export type SourceSurface =
  | 'entire_session_list'
  | 'entire_session_info'
  | 'entire_session_tokens'
  | 'entire_session_current'
  | 'entire_checkpoint_top_metadata'
  | 'entire_checkpoint_session_metadata'
  | 'entire_transcript_codex'
  | 'entire_transcript_antigravity'
  | 'entire_transcript_claude_code'
  | 'entire_state'
  | 'codex_native_jsonl'
  | 'codex_native_app_server'
  | 'antigravity_native_step_jsonl'
  | 'antigravity_native_vscdb'
  | 'native_hook_envelope'

export interface ModelIntelligenceFieldSpec {
  id: string
  surface: SourceSurface
  fieldPath: string
  versions: readonly string[]
  granularity: FieldGranularity
  valueType: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'iso_timestamp' | 'sha256'
  observability: FieldObservability
  disposition: FieldDisposition
  targetStoreField?: string
  rationale: string
}

export const MODEL_INTELLIGENCE_FIELD_INVENTORY: readonly ModelIntelligenceFieldSpec[] = [
  // Entire CLI: session list / info / current / tokens
  {
    id: 'entire.session.id',
    surface: 'entire_session_list',
    fieldPath: 'session_id',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'session',
    valueType: 'string',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'sessions.providerSessionId',
    rationale: 'Primary provider session identifier across list, info, and current.'
  },
  {
    id: 'entire.session.agent',
    surface: 'entire_session_list',
    fieldPath: 'agent',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'session',
    valueType: 'string',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'sessions.agent',
    rationale: 'Normalized agent label (codex, claude-code, antigravity).'
  },
  {
    id: 'entire.session.status',
    surface: 'entire_session_list',
    fieldPath: 'status',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'session',
    valueType: 'string',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'sessions.state',
    rationale: 'Session lifecycle state (ACTIVE, ENDED, UNKNOWN).'
  },
  {
    id: 'entire.session.timestamps',
    surface: 'entire_session_info',
    fieldPath: 'started_at | ended_at',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'session',
    valueType: 'iso_timestamp',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'sessions.startedAt / sessions.endedAt',
    rationale: 'Bounded session start/end timestamps.'
  },
  {
    id: 'entire.session.worktree_path',
    surface: 'entire_session_list',
    fieldPath: 'worktree_path',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'session',
    valueType: 'string',
    observability: 'observed',
    disposition: 'REFERENCED',
    targetStoreField: 'session_associations.worktreeId',
    rationale: 'Validated against realpath(worktreeRoot) and stored as worktreeId/generation association.'
  },
  {
    id: 'entire.session.model',
    surface: 'entire_session_info',
    fieldPath: 'model',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'session',
    valueType: 'string',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'session_model_metadata.model',
    rationale: 'Optional primary or latest model reported by Entire session info.'
  },
  {
    id: 'entire.session.effort',
    surface: 'entire_session_info',
    fieldPath: 'effort | reasoning_effort',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'session',
    valueType: 'string',
    observability: 'unknown',
    disposition: 'UNAVAILABLE',
    rationale: 'Not emitted by Entire 0.12.2/0.13.4 session info CLI JSON.'
  },
  {
    id: 'entire.session.turns_counts',
    surface: 'entire_session_info',
    fieldPath: 'turns | pending_turns',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'turn',
    valueType: 'integer',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'session_model_metadata.turnCount',
    rationale: 'Structural turn/pending-turn counts used for capture observation and turn coverage.'
  },
  {
    id: 'entire.tokens.summary',
    surface: 'entire_session_tokens',
    fieldPath: 'tokens.{input,output,cache_read,cache_write,total,api_calls}',
    versions: ['0.13.4'],
    granularity: 'session',
    valueType: 'integer',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'session_usage_facts',
    rationale: 'Session-level token usage reported by Entire 0.13.4 tokens --json; cache fields preserved separately from total.'
  },
  {
    id: 'entire.tokens.signals',
    surface: 'entire_session_tokens',
    fieldPath: 'signals | recommendations',
    versions: ['0.13.4'],
    granularity: 'session',
    valueType: 'object',
    observability: 'reported',
    disposition: 'DERIVABLE',
    rationale: 'Derived advisory signals from Entire tokens command; facts remain authoritative.'
  },

  // Entire Checkpoints
  {
    id: 'entire.checkpoint.top_usage',
    surface: 'entire_checkpoint_top_metadata',
    fieldPath: 'token_usage',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'checkpoint',
    valueType: 'object',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'session_usage_facts (scope=checkpoint)',
    rationale: 'Checkpoint-window aggregated token usage; never summed blindly with session totals.'
  },
  {
    id: 'entire.checkpoint.session_model',
    surface: 'entire_checkpoint_session_metadata',
    fieldPath: 'model',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'checkpoint',
    valueType: 'string',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'session_model_metadata (scope=checkpoint)',
    rationale: 'Model identifier recorded per session inside checkpoint metadata.'
  },
  {
    id: 'entire.checkpoint.session_usage',
    surface: 'entire_checkpoint_session_metadata',
    fieldPath: 'token_usage',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'checkpoint',
    valueType: 'object',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'session_usage_facts (scope=checkpoint)',
    rationale: 'Per-session token usage inside a checkpoint window.'
  },
  {
    id: 'entire.checkpoint.intent',
    surface: 'entire_checkpoint_session_metadata',
    fieldPath: 'intent',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'checkpoint',
    valueType: 'string',
    observability: 'reported',
    disposition: 'EXCLUDED_PRIVACY',
    rationale: 'Free-text prompt/intent summary excluded from Model Intelligence persistence.'
  },

  // Entire Transcripts & Internal State
  {
    id: 'entire.transcript.byte_ranges',
    surface: 'entire_transcript_codex',
    fieldPath: 'fields[].{path,bytes,digest,startByte,endByte}',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'call',
    valueType: 'object',
    observability: 'observed',
    disposition: 'REFERENCED',
    targetStoreField: 'transcript_fields',
    rationale: 'Content stays in source file/blob; only byte offsets and SHA-256 digests are persisted.'
  },
  {
    id: 'entire.transcript.files',
    surface: 'entire_transcript_codex',
    fieldPath: 'files[]',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'call',
    valueType: 'array',
    observability: 'observed',
    disposition: 'PERSISTED',
    targetStoreField: 'event_files',
    rationale: 'Repo-relative sanitized file paths touched by tool calls.'
  },
  {
    id: 'entire.transcript.free_text',
    surface: 'entire_transcript_codex',
    fieldPath: 'payload.{message,arguments,input,output}|content|reasoning',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'call',
    valueType: 'string',
    observability: 'observed',
    disposition: 'EXCLUDED_PRIVACY',
    rationale: 'Raw prompts, assistant prose, tool arguments/outputs, and reasoning text are never stored in intelligence tables.'
  },
  {
    id: 'entire.state.ephemeral',
    surface: 'entire_state',
    fieldPath: '.git/entire-sessions/*.json',
    versions: ['0.12.2', '0.13.4'],
    granularity: 'session',
    valueType: 'object',
    observability: 'unknown',
    disposition: 'UNSUPPORTED',
    rationale: 'Internal Entire CLI runtime state is not a stable public read contract.'
  },

  // Codex Native JSONL & App-Server
  {
    id: 'codex.native.turn_context.model',
    surface: 'codex_native_jsonl',
    fieldPath: 'turn_context.payload.model',
    versions: ['0.169.0-alpha.11.1'],
    granularity: 'turn',
    valueType: 'string',
    observability: 'requested',
    disposition: 'PERSISTED',
    targetStoreField: 'session_model_metadata (scope=turn)',
    rationale: 'Model configured/requested at turn boundary; captures mid-session model switches.'
  },
  {
    id: 'codex.native.turn_context.effort',
    surface: 'codex_native_jsonl',
    fieldPath: 'turn_context.payload.effort',
    versions: ['0.169.0-alpha.11.1'],
    granularity: 'turn',
    valueType: 'string',
    observability: 'requested',
    disposition: 'PERSISTED',
    targetStoreField: 'session_model_metadata (scope=turn)',
    rationale: 'Reasoning effort configured at turn boundary (low, medium, high, etc.).'
  },
  {
    id: 'codex.native.turn_context.policies',
    surface: 'codex_native_jsonl',
    fieldPath: 'turn_context.payload.{approval_policy,sandbox_policy,collaboration_mode,truncation_policy}',
    versions: ['0.169.0-alpha.11.1'],
    granularity: 'turn',
    valueType: 'object',
    observability: 'requested',
    disposition: 'PERSISTED',
    targetStoreField: 'session_model_metadata.executionPolicy',
    rationale: 'Non-PII operational policy knobs per turn.'
  },
  {
    id: 'codex.native.turn_context.instructions',
    surface: 'codex_native_jsonl',
    fieldPath: 'turn_context.payload.{user_instructions,developer_instructions}',
    versions: ['0.169.0-alpha.11.1'],
    granularity: 'turn',
    valueType: 'string',
    observability: 'requested',
    disposition: 'EXCLUDED_PRIVACY',
    rationale: 'Instruction prompts are private free text and must not be persisted.'
  },
  {
    id: 'codex.native.token_count.total',
    surface: 'codex_native_jsonl',
    fieldPath: 'event_msg(token_count).payload.info.total_token_usage',
    versions: ['0.169.0-alpha.11.1'],
    granularity: 'session',
    valueType: 'object',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'session_usage_facts (scope=session_cumulative)',
    rationale: 'Cumulative session token counters; replaced rather than summed across snapshots.'
  },
  {
    id: 'codex.native.token_count.last',
    surface: 'codex_native_jsonl',
    fieldPath: 'event_msg(token_count).payload.info.last_token_usage',
    versions: ['0.169.0-alpha.11.1'],
    granularity: 'call',
    valueType: 'object',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'session_usage_facts (scope=call_delta)',
    rationale: 'Per-call incremental token delta; paired with turn model/effort without double-counting.'
  },
  {
    id: 'codex.native.token_count.context_window',
    surface: 'codex_native_jsonl',
    fieldPath: 'event_msg(token_count).payload.info.model_context_window',
    versions: ['0.169.0-alpha.11.1'],
    granularity: 'call',
    valueType: 'integer',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'session_model_metadata.contextWindow',
    rationale: 'Reported context window limit for the active model.'
  },
  {
    id: 'codex.native.task_boundary',
    surface: 'codex_native_jsonl',
    fieldPath: 'event_msg(task_started|task_complete).payload.turn_id',
    versions: ['0.169.0-alpha.11.1'],
    granularity: 'task',
    valueType: 'string',
    observability: 'observed',
    disposition: 'PERSISTED',
    targetStoreField: 'session_model_metadata.scopeId',
    rationale: 'Structural turn/task identifier.'
  },
  {
    id: 'codex.native.subagent',
    surface: 'codex_native_jsonl',
    fieldPath: 'session_meta.payload.source.subagent',
    versions: ['0.169.0-alpha.11.1'],
    granularity: 'subagent',
    valueType: 'object',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'session_model_metadata.parentSessionId',
    rationale: 'Links child/subagent usage separately so parent sessions do not double-count child totals.'
  },
  {
    id: 'codex.native.pii_identity',
    surface: 'codex_native_jsonl',
    fieldPath: 'session_meta.payload.{creator_user_id,creator_account_id}',
    versions: ['0.169.0-alpha.11.1'],
    granularity: 'session',
    valueType: 'string',
    observability: 'reported',
    disposition: 'EXCLUDED_PRIVACY',
    targetStoreField: 'session_associations.providerAccountHash',
    rationale: 'Raw account/user IDs are excluded; only SHA-256 providerAccountHash is persisted.'
  },
  {
    id: 'codex.app_server.thread_meta',
    surface: 'codex_native_app_server',
    fieldPath: 'thread.{id,modelProvider,archived,createdAt,updatedAt}',
    versions: ['app-server-v1'],
    granularity: 'session',
    valueType: 'object',
    observability: 'reported',
    disposition: 'PERSISTED',
    targetStoreField: 'session_model_metadata.provider',
    rationale: 'Authorized app-server discovery metadata without transcript text.'
  },

  // Antigravity Native & Hooks
  {
    id: 'antigravity.native.step_metadata',
    surface: 'antigravity_native_step_jsonl',
    fieldPath: '{step_index,type,source,created_at,status,error_code,tool_calls[].name}',
    versions: ['antigravity-step-jsonl-v1'],
    granularity: 'call',
    valueType: 'object',
    observability: 'observed',
    disposition: 'PERSISTED',
    targetStoreField: 'native_reference_events',
    rationale: 'Structural step timing, outcome, and tool names.'
  },
  {
    id: 'antigravity.native.model_usage',
    surface: 'antigravity_native_step_jsonl',
    fieldPath: 'model | effort | token_usage',
    versions: ['antigravity-step-jsonl-v1'],
    granularity: 'call',
    valueType: 'object',
    observability: 'unknown',
    disposition: 'UNAVAILABLE',
    rationale: 'Antigravity step JSONL schema v1 does not emit model, effort, or token counts.'
  },
  {
    id: 'antigravity.vscdb.locator',
    surface: 'antigravity_native_vscdb',
    fieldPath: 'conversation_id | workspace_uris | last_modified_time',
    versions: ['vscdb-v1'],
    granularity: 'session',
    valueType: 'object',
    observability: 'observed',
    disposition: 'REFERENCED',
    rationale: 'Used solely to verify workspace origin and locate authorized transcript files.'
  },
  {
    id: 'native.hook.envelope',
    surface: 'native_hook_envelope',
    fieldPath: '{provider,hookEvent,sessionId,worktreePath,occurredAt}',
    versions: ['hook-v1'],
    granularity: 'session',
    valueType: 'object',
    observability: 'observed',
    disposition: 'PERSISTED',
    targetStoreField: 'session_associations',
    rationale: 'Hook provenance binding without model or token payload.'
  }
] as const

const SENSITIVE_KEY_PATTERN = /(?:prompt|message|text|content|reasoning|thinking|instruction|argument|input_text|output_text|secret|token_value|api_key|apikey|password|authorization|cookie|email|user_id|account_id|creator_)/i

export interface BenignUnknownFieldReport {
  benignPaths: string[]
  excludedSensitivePaths: string[]
}

/**
 * Inspects top-level keys of a structured operational object against known keys,
 * separating additive benign structural keys from sensitive/private keys.
 */
export function detectBenignUnknownFields(
  record: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  prefix = ''
): BenignUnknownFieldReport {
  const benignPaths: string[] = []
  const excludedSensitivePaths: string[] = []
  for (const key of Object.keys(record).sort()) {
    if (knownKeys.has(key)) continue
    const path = prefix ? `${prefix}.${key}` : key
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      excludedSensitivePaths.push(path)
    } else {
      benignPaths.push(path)
    }
  }
  return { benignPaths, excludedSensitivePaths }
}

export function qualifyEntireVersion(version: unknown): '0.12.2' | '0.13.4' | undefined {
  return version === '0.12.2' || version === '0.13.4' ? version : undefined
}

function nonEmptyLabel(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || /[\x00-\x1f\x7f]/.test(trimmed)) return undefined
  return trimmed
}

function optionalNonNegativeInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export interface AuthorizedTokenUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoningOutput?: number
  total?: number
  apiCalls?: number
}

export function extractAuthorizedTokenUsage(raw: unknown): AuthorizedTokenUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const input = optionalNonNegativeInt(obj.input ?? obj.input_tokens)
  const output = optionalNonNegativeInt(obj.output ?? obj.output_tokens)
  const cacheRead = optionalNonNegativeInt(obj.cache_read ?? obj.cached_input_tokens ?? obj.cache_read_input_tokens)
  const cacheWrite = optionalNonNegativeInt(obj.cache_write ?? obj.cache_creation_input_tokens)
  const reasoningOutput = optionalNonNegativeInt(obj.reasoning_output_tokens)
  const total = optionalNonNegativeInt(obj.total ?? obj.total_tokens)
  const apiCalls = optionalNonNegativeInt(obj.api_calls)
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    reasoningOutput === undefined &&
    total === undefined &&
    apiCalls === undefined
  ) {
    return undefined
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoningOutput !== undefined ? { reasoningOutput } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(apiCalls !== undefined ? { apiCalls } : {})
  }
}

export interface AuthorizedCodexTurnContext {
  model?: string
  effort?: string
  approvalPolicy?: string
  sandboxPolicyType?: string
  collaborationMode?: string
  unknownFields: BenignUnknownFieldReport
}

const CODEX_TURN_CONTEXT_KNOWN_KEYS = new Set([
  'cwd',
  'approval_policy',
  'sandbox_policy',
  'model',
  'effort',
  'reasoning_effort',
  'summary',
  'truncation_policy',
  'collaboration_mode',
  'personality',
  'user_instructions',
  'developer_instructions'
])

export function extractAuthorizedCodexTurnContext(payload: unknown): AuthorizedCodexTurnContext | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const obj = payload as Record<string, unknown>
  const model = nonEmptyLabel(obj.model)
  const effort = nonEmptyLabel(obj.effort ?? obj.reasoning_effort, 64)
  const approvalPolicy = nonEmptyLabel(obj.approval_policy, 64)
  const sandboxPolicy = obj.sandbox_policy && typeof obj.sandbox_policy === 'object' && !Array.isArray(obj.sandbox_policy)
    ? nonEmptyLabel((obj.sandbox_policy as Record<string, unknown>).type, 64)
    : nonEmptyLabel(obj.sandbox_policy, 64)
  const collaborationMode = obj.collaboration_mode && typeof obj.collaboration_mode === 'object' && !Array.isArray(obj.collaboration_mode)
    ? nonEmptyLabel((obj.collaboration_mode as Record<string, unknown>).mode, 64)
    : nonEmptyLabel(obj.collaboration_mode, 64)
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(sandboxPolicy ? { sandboxPolicyType: sandboxPolicy } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
    unknownFields: detectBenignUnknownFields(obj, CODEX_TURN_CONTEXT_KNOWN_KEYS, 'turn_context.payload')
  }
}

export interface AuthorizedCodexTokenCount {
  totalUsage?: AuthorizedTokenUsage
  lastUsage?: AuthorizedTokenUsage
  modelContextWindow?: number
  unknownFields: BenignUnknownFieldReport
}

const CODEX_TOKEN_COUNT_KNOWN_KEYS = new Set(['type', 'info', 'rate_limits'])

export function extractAuthorizedCodexTokenCount(payload: unknown): AuthorizedCodexTokenCount | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const obj = payload as Record<string, unknown>
  const info = obj.info && typeof obj.info === 'object' && !Array.isArray(obj.info)
    ? (obj.info as Record<string, unknown>)
    : undefined
  return {
    ...(info?.total_token_usage ? { totalUsage: extractAuthorizedTokenUsage(info.total_token_usage) } : {}),
    ...(info?.last_token_usage ? { lastUsage: extractAuthorizedTokenUsage(info.last_token_usage) } : {}),
    ...(optionalNonNegativeInt(info?.model_context_window) !== undefined
      ? { modelContextWindow: optionalNonNegativeInt(info?.model_context_window) }
      : {}),
    unknownFields: detectBenignUnknownFields(obj, CODEX_TOKEN_COUNT_KNOWN_KEYS, 'token_count.payload')
  }
}

export interface AuthorizedEntireSessionMetadata {
  providerVersion: '0.12.2' | '0.13.4'
  model?: string
  turnsCount?: number
  pendingTurnsCount?: number
  tokenUsage?: AuthorizedTokenUsage
  unknownFields: BenignUnknownFieldReport
}

const ENTIRE_SESSION_KNOWN_KEYS = new Set([
  'session_id',
  'agent',
  'status',
  'worktree_path',
  'started_at',
  'ended_at',
  'model',
  'turns',
  'pending_turns',
  'tokens',
  'token_usage',
  'cli_version',
  'checkpoint_id',
  'strategy',
  'branch',
  'created_at',
  'checkpoints_count',
  'files_touched',
  'redaction',
  'intent'
])

export function extractAuthorizedEntireSessionMetadata(
  raw: unknown,
  version: unknown
): AuthorizedEntireSessionMetadata | undefined {
  const providerVersion = qualifyEntireVersion(version)
  if (!providerVersion || !raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const model = nonEmptyLabel(obj.model)
  const turnsCount = Array.isArray(obj.turns) ? obj.turns.length : optionalNonNegativeInt(obj.turns)
  const pendingTurnsCount = Array.isArray(obj.pending_turns) ? obj.pending_turns.length : optionalNonNegativeInt(obj.pending_turns)
  const tokenUsage = extractAuthorizedTokenUsage(obj.tokens ?? obj.token_usage)
  return {
    providerVersion,
    ...(model ? { model } : {}),
    ...(turnsCount !== undefined ? { turnsCount } : {}),
    ...(pendingTurnsCount !== undefined ? { pendingTurnsCount } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    unknownFields: detectBenignUnknownFields(obj, ENTIRE_SESSION_KNOWN_KEYS, 'entire.session')
  }
}
