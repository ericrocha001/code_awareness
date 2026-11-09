import type { McpTextContent, McpToolDefinition, McpToolResult } from '../../mcp/mcp-types'
import type { UnitFlowRuntimeFacade } from './unitflow-runtime-facade'
import {
  SmcInvalidSessionIdError,
  SmcSessionClosedError,
  SmcSessionNotFoundError
} from '../smc/session-memory-central-store'
import {
  UnitFlowInvalidPlanError,
  UnitFlowPlanConflictError,
  UnitFlowPlanNotFoundError
} from './unitflow-errors'
import {
  ExecutionAttemptConflictError,
  ExecutionInvalidAttemptIdError
} from '../execution/execution-errors'
import {
  BuildXWorkspaceInvalidError,
  BuildXWorkspaceNotFoundError,
  BuildXWorkspaceRepositoryMismatchError
} from '../execution/workspace-binding-errors'

function readOnlyTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): McpToolDefinition {
  return {
    name,
    description,
    securitySchemes: [{ type: 'oauth2', scopes: [] }],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false
    }
  }
}

function mutationTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): McpToolDefinition {
  return {
    name,
    description,
    securitySchemes: [{ type: 'oauth2', scopes: [] }],
    annotations: {},
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false
    }
  }
}

export const PREPARE_UNITFLOW_PLAN_TOOL = mutationTool(
  'prepare_unitflow_plan',
  'Prepare and activate an ordered UnitFlow engineering plan with manifest units for an open session in the active authorized repository. Idempotent by planId: replaying identical planId and units returns existing plan. Never accepts repositoryId as argument.',
  {
    sessionId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the target open engineering session.'
    },
    planId: {
      type: 'string',
      minLength: 1,
      description: 'Caller-generated stable UUID for this plan. Replaying identical planId returns existing plan.'
    },
    title: {
      type: 'string',
      minLength: 1,
      description: 'Descriptive title for the engineering plan.'
    },
    objective: {
      type: 'string',
      minLength: 1,
      description: 'Core objective and definition of done for the plan.'
    },
    description: {
      type: 'string',
      description: 'Optional additional context or markdown notes for the plan.'
    },
    units: {
      type: 'array',
      description: 'Ordered sequence of units of implementation for this plan.',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        properties: {
          unitId: { type: 'string', minLength: 1, description: 'Stable UUID for this unit.' },
          position: { type: 'integer', minimum: 0, description: '0-based sequential order of execution.' },
          title: { type: 'string', minLength: 1, description: 'Unit title.' },
          objective: { type: 'string', minLength: 1, description: 'Unit objective and scope.' },
          acceptanceCriteria: { type: 'string', minLength: 1, description: 'Objective acceptance criteria.' },
          dependsOnUnitIds: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            description: 'Optional unit IDs that must complete before this unit is eligible.'
          }
        },
        required: ['unitId', 'position', 'title', 'objective', 'acceptanceCriteria'],
        additionalProperties: false
      }
    }
  },
  ['sessionId', 'planId', 'title', 'objective', 'units']
)

export const BIND_UNITFLOW_WORKSPACE_TOOL = mutationTool(
  'bind_unitflow_workspace',
  'Bind an open engineering session to a verified Git worktree in the active repository. Validates presence and branch against Git Operations. Does not accept repositoryId as argument.',
  {
    sessionId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the open engineering session.'
    },
    worktreeId: {
      type: 'string',
      minLength: 1,
      description: 'The stable 64-character SHA identifier of the Git worktree to bind.'
    }
  },
  ['sessionId', 'worktreeId']
)

export const START_NEXT_UNITFLOW_UNIT_TOOL = mutationTool(
  'start_next_unitflow_unit',
  'Atomically advance to and start supervised execution of the next eligible unit in the active plan. Atomically reserves the unit, prepares the attempt, stages the prompt outside worktree, and initiates supervised Grok CLI execution. Idempotent by attemptId; prevents duplicate execution spawns.',
  {
    sessionId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the target open engineering session.'
    },
    planId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the active plan.'
    },
    reservationId: {
      type: 'string',
      minLength: 1,
      description: 'Caller-generated stable UUID for unit reservation idempotency.'
    },
    attemptId: {
      type: 'string',
      minLength: 1,
      description: 'Caller-generated stable UUID for attempt idempotency.'
    },
    stageOperationId: {
      type: 'string',
      minLength: 1,
      description: 'Caller-generated stable operation ID for prompt staging idempotency.'
    },
    customPromptText: {
      type: 'string',
      description: 'Optional custom prompt text override for the unit task.'
    }
  },
  ['sessionId', 'planId', 'reservationId', 'attemptId', 'stageOperationId']
)

export const GET_UNITFLOW_STATUS_TOOL = readOnlyTool(
  'get_unitflow_status',
  'Query compact, read-only orchestration status, active plan, bound workspace, current unit state, active attempt progress, and allowed next actions. Purely read-only; performs no state mutations.',
  {
    sessionId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the target engineering session.'
    },
    planId: {
      type: 'string',
      description: 'Optional plan UUID to query specifically instead of active plan.'
    },
    attemptId: {
      type: 'string',
      description: 'Optional attempt UUID to inspect specifically.'
    }
  },
  ['sessionId']
)

export const SETTLE_UNITFLOW_UNIT_TOOL = mutationTool(
  'settle_unitflow_unit',
  'Technically confirm and settle a completed or terminal unit execution attempt. Fails closed if the CLI execution is still active. Transitions successful attempt to VALIDATION_READY or failed attempt to RECONCILING.',
  {
    sessionId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the engineering session.'
    },
    attemptId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the attempt to settle.'
    }
  },
  ['sessionId', 'attemptId']
)

export const ACCEPT_UNITFLOW_UNIT_TOOL = mutationTool(
  'accept_unitflow_unit',
  'Accept a validated unit in VALIDATION_READY state using passed, fresh proofs from the Validation Ledger matching the worktree git provenance. Transitions unit to COMPLETED, settles reservation, and records engineering decision in SMC.',
  {
    sessionId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the engineering session.'
    },
    attemptId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the attempt to accept.'
    },
    operationId: {
      type: 'string',
      minLength: 1,
      description: 'Caller-generated stable UUID for acceptance idempotency.'
    },
    proofIds: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      description: 'Array of ledger proof IDs with status PASSED, freshness CURRENT, matching worktree provenance.'
    },
    summary: {
      type: 'string',
      minLength: 1,
      description: 'Semantic rationale and summary of unit acceptance.'
    },
    semanticDecision: {
      type: 'string',
      enum: ['ACCEPTED', 'REJECTED'],
      description: 'Explicit semantic decision. Defaults to ACCEPTED.'
    },
    emitterId: {
      type: 'string',
      description: 'Optional declared identifier of the orchestrating agent.'
    }
  },
  ['sessionId', 'attemptId', 'operationId', 'proofIds', 'summary']
)

export const RECONCILE_UNITFLOW_UNIT_TOOL = mutationTool(
  'reconcile_unitflow_unit',
  'Reconcile a failed or cancelled execution attempt. Resets unit state to PENDING and releases reservation for a retry, or marks the unit abandoned. Records intervention in SMC.',
  {
    sessionId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the engineering session.'
    },
    attemptId: {
      type: 'string',
      minLength: 1,
      description: 'The stable UUID of the attempt to reconcile.'
    },
    operationId: {
      type: 'string',
      minLength: 1,
      description: 'Caller-generated stable UUID for reconciliation idempotency.'
    },
    summary: {
      type: 'string',
      minLength: 1,
      description: 'Summary explanation of the failure diagnosis and recovery decision.'
    },
    action: {
      type: 'string',
      enum: ['RETRY_SAME_UNIT'],
      description: 'Reconciliation action. Defaults to RETRY_SAME_UNIT.'
    },
    emitterId: {
      type: 'string',
      description: 'Optional declared identifier of the reconciling agent.'
    }
  },
  ['sessionId', 'attemptId', 'operationId', 'summary']
)

export const BUILDX_UNITFLOW_READ_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  GET_UNITFLOW_STATUS_TOOL
])

export const BUILDX_UNITFLOW_MUTATION_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  PREPARE_UNITFLOW_PLAN_TOOL,
  BIND_UNITFLOW_WORKSPACE_TOOL,
  START_NEXT_UNITFLOW_UNIT_TOOL,
  SETTLE_UNITFLOW_UNIT_TOOL,
  ACCEPT_UNITFLOW_UNIT_TOOL,
  RECONCILE_UNITFLOW_UNIT_TOOL
])

export const BUILDX_UNITFLOW_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  ...BUILDX_UNITFLOW_READ_TOOLS,
  ...BUILDX_UNITFLOW_MUTATION_TOOLS
])

export interface ExecuteBuildxUnitflowOptions {
  assertActiveProject?: () => void
  maxResponseBytes?: number
}

function ok(payload: unknown): McpToolResult<McpTextContent> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }]
  }
}

function failure(code: string, message: string): McpToolResult<McpTextContent> {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message }) }]
  }
}

function mapUnitflowError(error: unknown): McpToolResult<McpTextContent> {
  if (error instanceof SmcSessionNotFoundError) return failure('SESSION_NOT_FOUND', 'Session was not found in the active repository')
  if (error instanceof SmcSessionClosedError) return failure('SESSION_CLOSED', 'Session is closed and cannot be modified')
  if (error instanceof SmcInvalidSessionIdError) return failure('INVALID_ARGUMENT', 'sessionId must be a valid UUID')
  if (error instanceof UnitFlowPlanNotFoundError) return failure('PLAN_NOT_FOUND', 'Plan was not found in the specified session')
  if (error instanceof UnitFlowPlanConflictError) return failure('PLAN_CONFLICT', (error as Error).message)
  if (error instanceof UnitFlowInvalidPlanError) return failure('INVALID_ARGUMENT', (error as Error).message)
  if (error instanceof ExecutionAttemptConflictError) return failure('ATTEMPT_CONFLICT', (error as Error).message)
  if (error instanceof ExecutionInvalidAttemptIdError) return failure('INVALID_ARGUMENT', (error as Error).message)
  if (error instanceof BuildXWorkspaceNotFoundError) return failure('WORKSPACE_NOT_FOUND', (error as Error).message)
  if (error instanceof BuildXWorkspaceInvalidError) return failure('WORKSPACE_INVALID', (error as Error).message)
  if (error instanceof BuildXWorkspaceRepositoryMismatchError) return failure('WORKSPACE_REPOSITORY_MISMATCH', (error as Error).message)

  const err = error as any
  const msg = err?.message ?? String(error)
  if (msg.startsWith('INVALID_ARGUMENT:')) {
    return failure('INVALID_ARGUMENT', msg.replace('INVALID_ARGUMENT:', '').trim())
  }
  return failure(err?.code ?? 'EXECUTION_FAILED', msg)
}

export async function executeBuildxUnitflowTool(
  facade: UnitFlowRuntimeFacade,
  repositoryId: string,
  name: string,
  args: unknown,
  options?: ExecuteBuildxUnitflowOptions
): Promise<McpToolResult<McpTextContent>> {
  try {
    options?.assertActiveProject?.()
  } catch {
    return failure('PROJECT_CONTEXT_CHANGED', 'Active repository project context changed or was invalidated')
  }

  if (!repositoryId || typeof repositoryId !== 'string' || !repositoryId.trim()) {
    return failure('REPOSITORY_CONTEXT_REQUIRED', 'A valid active repositoryId is required and cannot be omitted')
  }

  if (facade.repositoryId !== repositoryId.trim()) {
    return failure('REPOSITORY_MISMATCH', 'Target repository does not match authenticated runtime facade')
  }

  const rawArgs = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}

  try {
    switch (name) {
      case 'prepare_unitflow_plan': {
        const sessionId = String(rawArgs.sessionId ?? '')
        const planId = String(rawArgs.planId ?? '')
        const title = String(rawArgs.title ?? '')
        const objective = String(rawArgs.objective ?? '')
        const description = rawArgs.description !== undefined ? String(rawArgs.description) : undefined
        const units = rawArgs.units as any[]

        const result = await facade.preparePlan(sessionId, {
          planId,
          title,
          objective,
          description,
          units
        })
        return ok(result)
      }

      case 'bind_unitflow_workspace': {
        const sessionId = String(rawArgs.sessionId ?? '')
        const worktreeId = String(rawArgs.worktreeId ?? '')

        const result = await facade.bindWorkspace(sessionId, worktreeId)
        return ok(result)
      }

      case 'start_next_unitflow_unit': {
        const sessionId = String(rawArgs.sessionId ?? '')
        const planId = String(rawArgs.planId ?? '')
        const reservationId = String(rawArgs.reservationId ?? '')
        const attemptId = String(rawArgs.attemptId ?? '')
        const stageOperationId = String(rawArgs.stageOperationId ?? '')
        const customPromptText = rawArgs.customPromptText !== undefined ? String(rawArgs.customPromptText) : undefined

        const result = await facade.startNextUnit(sessionId, planId, {
          reservationId,
          attemptId,
          stageOperationId,
          customPromptText
        })
        return ok(result)
      }

      case 'get_unitflow_status': {
        const sessionId = String(rawArgs.sessionId ?? '')
        const planId = rawArgs.planId !== undefined ? String(rawArgs.planId) : undefined
        const attemptId = rawArgs.attemptId !== undefined ? String(rawArgs.attemptId) : undefined

        const result = await facade.getStatus(sessionId, { planId, attemptId })
        return ok(result)
      }

      case 'settle_unitflow_unit': {
        const sessionId = String(rawArgs.sessionId ?? '')
        const attemptId = String(rawArgs.attemptId ?? '')

        const result = await facade.settleUnit(sessionId, attemptId)
        return ok(result)
      }

      case 'accept_unitflow_unit': {
        const sessionId = String(rawArgs.sessionId ?? '')
        const attemptId = String(rawArgs.attemptId ?? '')
        const operationId = String(rawArgs.operationId ?? '')
        const proofIds = Array.isArray(rawArgs.proofIds) ? (rawArgs.proofIds as string[]) : []
        const summary = String(rawArgs.summary ?? '')
        const semanticDecision = rawArgs.semanticDecision as 'ACCEPTED' | 'REJECTED' | undefined
        const emitterId = rawArgs.emitterId !== undefined ? String(rawArgs.emitterId) : undefined

        const result = await facade.acceptUnit(sessionId, attemptId, {
          operationId,
          proofIds,
          summary,
          semanticDecision,
          emitterId
        })
        return ok(result)
      }

      case 'reconcile_unitflow_unit': {
        const sessionId = String(rawArgs.sessionId ?? '')
        const attemptId = String(rawArgs.attemptId ?? '')
        const operationId = String(rawArgs.operationId ?? '')
        const summary = String(rawArgs.summary ?? '')
        const action = rawArgs.action as 'RETRY_SAME_UNIT' | undefined
        const emitterId = rawArgs.emitterId !== undefined ? String(rawArgs.emitterId) : undefined

        const result = await facade.reconcileUnit(sessionId, attemptId, {
          operationId,
          summary,
          action,
          emitterId
        })
        return ok(result)
      }

      default:
        return failure('UNKNOWN_TOOL', `Tool "${name}" is not recognized by BuildX UnitFlow runtime`)
    }
  } catch (error) {
    return mapUnitflowError(error)
  }
}
