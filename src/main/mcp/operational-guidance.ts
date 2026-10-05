import type { McpToolResult } from './context-navigation-mcp-adapter'

export type Retryability = 'SAFE_AFTER_BACKOFF' | 'SAME_OPERATION_ID' | 'AFTER_STATE_REFRESH' | 'NOT_SAFE'
export interface OperationalGuidance {
  code: string
  retryability: Retryability
  recommendedAction: string
  retryAfterMs?: number
  operationId?: string
  activeOperationId?: string
  activeRunId?: string
}

export const MCP_REQUEST_BUDGET_MS = 20_000
export const VALIDATION_RETRY_AFTER_MS = 2_000

export function operationalFailure(guidance: OperationalGuidance): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(guidance) }], isError: true }
}

export function gitGuidance(code: string, operationId?: string): OperationalGuidance {
  const stale = ['GIT_STATE_CHANGED', 'CONFLICT_STATE_CHANGED'].includes(code)
  return { code, retryability: stale ? 'AFTER_STATE_REFRESH' : 'NOT_SAFE', recommendedAction: stale ? 'REFRESH_STATE' : 'INSPECT_ERROR', ...(operationId ? { operationId } : {}) }
}
