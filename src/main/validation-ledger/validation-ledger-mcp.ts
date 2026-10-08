import type { McpToolDefinition, McpToolResult } from '../mcp/channel-mcp-adapter'
import type { ValidationLedger } from './validation-ledger'
import type {
  ListProofsFilter,
  ProofFreshness,
  ProofKind,
  ProofProducer,
  ProofStatus,
  ProofWithFreshness,
  RecordProofInput
} from './validation-ledger-types'

const PROOF_KINDS = [
  'TARGETED_TEST',
  'SUBSYSTEM_TEST',
  'FULL_TEST_SUITE',
  'TYPECHECK',
  'BUILD',
  'E2E',
  'MANUAL_ACCEPTANCE'
] as const

const PROOF_PRODUCERS = ['IMPLEMENTER', 'ARCHITECT', 'USER', 'SYSTEM', 'TESTER'] as const
const PROOF_STATUSES = ['PASSED', 'FAILED', 'ERROR'] as const
const FRESHNESS_VALUES = ['CURRENT', 'SOURCE_STALE', 'RUNTIME_HISTORICAL', 'UNVERIFIABLE'] as const

function oauthProtected(
  definition: Omit<McpToolDefinition, 'securitySchemes'>
): McpToolDefinition {
  return { ...definition, securitySchemes: [{ type: 'oauth2', scopes: [] }] }
}

export const LIST_VALIDATION_PROOFS_TOOL: McpToolDefinition = oauthProtected({
  name: 'list_validation_proofs',
  description:
    'Query the Validation Ledger for recorded proofs. Returns a high-density summary of what has already been validated for the current system state, including freshness classification. Use before running tests to avoid re-executing evidence that is already current and sufficient. Filter by status, kind, producer, requirementId, or freshness.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...PROOF_STATUSES] },
      kind: { type: 'string', enum: [...PROOF_KINDS] },
      producer: { type: 'string', enum: [...PROOF_PRODUCERS] },
      requirementId: { type: 'string', minLength: 1 },
      freshness: { type: 'string', enum: [...FRESHNESS_VALUES] },
      limit: { type: 'number', minimum: 1, maximum: 500 }
    },
    additionalProperties: false
  }
})

export const GET_VALIDATION_PROOF_TOOL: McpToolDefinition = oauthProtected({
  name: 'get_validation_proof',
  description:
    'Retrieve full detail for a single validation proof by proofId, including scope, metrics, evidenceFor requirements, source fingerprint, runtime instance, and freshness classification.',
  inputSchema: {
    type: 'object',
    properties: {
      proofId: { type: 'string', minLength: 1 }
    },
    required: ['proofId'],
    additionalProperties: false
  }
})

export const RECORD_VALIDATION_PROOF_TOOL: McpToolDefinition = oauthProtected({
  name: 'record_validation_proof',
  description:
    'Record a completed validation proof in the Validation Ledger immediately after executing a test, build, typecheck, or acceptance check. This operation registers metadata only — it does not execute commands. Call this after every relevant proof so the Architect can consult existing evidence without re-running suites.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...PROOF_KINDS] },
      producer: { type: 'string', enum: [...PROOF_PRODUCERS] },
      status: { type: 'string', enum: [...PROOF_STATUSES] },
      startedAt: { type: 'string', minLength: 1 },
      finishedAt: { type: 'string', minLength: 1 },
      durationMs: { type: 'number', minimum: 0 },
      scope: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
      sourceFingerprint: { type: 'string' },
      runtimeInstanceId: { type: 'string' },
      summary: { type: 'string', minLength: 1 },
      metrics: {
        type: 'object',
        properties: {
          testFilesPassed: { type: 'number' },
          testFilesFailed: { type: 'number' },
          testsPassed: { type: 'number' },
          testsFailed: { type: 'number' },
          testsSkipped: { type: 'number' },
          durationMs: { type: 'number' }
        },
        additionalProperties: { type: 'number' }
      },
      commandProfile: {
        type: 'object',
        properties: {
          command: { type: 'string', minLength: 1 },
          args: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string' },
          exitCode: { type: 'number' }
        },
        required: ['command'],
        additionalProperties: false
      },
      evidenceFor: { type: 'array', items: { type: 'string', minLength: 1 } },
      deduplicationKey: { type: 'string', minLength: 1 }
    },
    required: ['kind', 'producer', 'status', 'startedAt', 'finishedAt', 'durationMs', 'scope', 'summary'],
    additionalProperties: false
  }
})

function proofSummaryLine(p: ProofWithFreshness): Record<string, unknown> {
  return {
    proofId: p.proofId,
    kind: p.kind,
    producer: p.producer,
    status: p.status,
    freshness: p.freshness,
    scope: p.scope,
    summary: p.summary,
    recordedAt: p.recordedAt,
    ...(p.evidenceFor.length > 0 ? { evidenceFor: p.evidenceFor } : {}),
    ...(p.metrics ? { metrics: p.metrics } : {})
  }
}

function err(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function ok(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function validateArgs(args: unknown): Record<string, unknown> | null {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) return null
  return args as Record<string, unknown>
}

export function executeListValidationProofs(
  ledger: ValidationLedger,
  args: unknown
): McpToolResult {
  const values = validateArgs(args)
  if (!values) return err('INVALID_ARGUMENT: Expected an arguments object')

  const filter: ListProofsFilter = {}
  if (values.status !== undefined) filter.status = values.status as ProofStatus
  if (values.kind !== undefined) filter.kind = values.kind as ProofKind
  if (values.producer !== undefined) filter.producer = values.producer as ProofProducer
  if (values.requirementId !== undefined) filter.requirementId = values.requirementId as string
  if (values.freshness !== undefined) filter.freshness = values.freshness as ProofFreshness
  if (values.limit !== undefined) filter.limit = values.limit as number

  try {
    const proofs = ledger.listProofs(filter)
    return ok({
      count: proofs.length,
      proofs: proofs.map(proofSummaryLine)
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return err(`LEDGER_ERROR: ${msg}`)
  }
}

export function executeGetValidationProof(
  ledger: ValidationLedger,
  args: unknown
): McpToolResult {
  const values = validateArgs(args)
  if (!values) return err('INVALID_ARGUMENT: Expected an arguments object')
  if (typeof values.proofId !== 'string' || !values.proofId) {
    return err('INVALID_ARGUMENT: proofId is required')
  }

  try {
    const proof = ledger.getProofWithFreshness(values.proofId)
    if (!proof) return err(`PROOF_NOT_FOUND: No proof with id "${values.proofId}"`)
    return ok(proof)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return err(`LEDGER_ERROR: ${msg}`)
  }
}

export function executeRecordValidationProof(
  ledger: ValidationLedger,
  args: unknown
): McpToolResult {
  const values = validateArgs(args)
  if (!values) return err('INVALID_ARGUMENT: Expected an arguments object')
  if (values.commandProfile && typeof values.commandProfile === 'object' && 'checkout' in values.commandProfile) return err('INVALID_ARGUMENT: Checkout provenance is issued only by Validation Execution')

  const required = ['kind', 'producer', 'status', 'startedAt', 'finishedAt', 'durationMs', 'scope', 'summary']
  for (const field of required) {
    if (!(field in values)) return err(`INVALID_ARGUMENT: Missing required field "${field}"`)
  }

  try {
    const input: RecordProofInput = {
      kind: values.kind as RecordProofInput['kind'],
      producer: values.producer as RecordProofInput['producer'],
      status: values.status as RecordProofInput['status'],
      startedAt: values.startedAt as string,
      finishedAt: values.finishedAt as string,
      durationMs: values.durationMs as number,
      scope: values.scope as string[],
      summary: values.summary as string,
      sourceFingerprint: (values.sourceFingerprint as string | undefined) ?? null,
      runtimeInstanceId: (values.runtimeInstanceId as string | undefined) ?? null,
      metrics: (values.metrics as RecordProofInput['metrics']) ?? null,
      commandProfile: (values.commandProfile as RecordProofInput['commandProfile']) ?? null,
      evidenceFor: (values.evidenceFor as string[] | undefined) ?? [],
      deduplicationKey: (values.deduplicationKey as string | undefined) ?? null
    }

    const proof = ledger.recordProof(input)
    return ok({ proofId: proof.proofId, recordedAt: proof.recordedAt, status: proof.status })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.startsWith('INVALID_ARGUMENT:')) return err(msg)
    return err(`LEDGER_ERROR: ${msg}`)
  }
}
