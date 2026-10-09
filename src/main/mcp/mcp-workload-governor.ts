import { randomUUID } from 'node:crypto'
import type { McpMultimodalToolResult as McpToolResult } from './mcp-types'
import { CODE_NAVIGATION_MCP_TOOLS } from './code-navigation-mcp'
import { MCP_REQUEST_BUDGET_MS, operationalFailure } from './operational-guidance'
import { isReceiptedGitMutation } from '../git-operations/git-operation-receipts'

type Lane = 'NAVIGATION' | 'VALIDATION' | 'MUTATIONS'
interface LaneState { activeOperationId?: string; degradedUntil: number; halfOpen: boolean }
export interface GovernorEvent { lane: Lane; event: 'ADMISSION_REFUSED' | 'WORK_STARTED' | 'EXECUTION_FAILED' | 'DEGRADED' | 'HALF_OPEN' | 'RECOVERED'; at: string; operationId: string }
const navigation = new Set(CODE_NAVIGATION_MCP_TOOLS.map(tool => tool.name))

export class McpWorkloadGovernor {
  private readonly lanes: Record<Exclude<Lane, 'NAVIGATION'>, LaneState> = {
    VALIDATION: { degradedUntil: 0, halfOpen: false }, MUTATIONS: { degradedUntil: 0, halfOpen: false }
  }
  private readonly events: GovernorEvent[] = []
  constructor(private readonly timeoutMs = MCP_REQUEST_BUDGET_MS - 2000, private readonly backoffMs = 5000) {}

  snapshot() {
    return { lanes: Object.entries(this.lanes).map(([lane, state]) => ({ lane, state: state.degradedUntil ? state.halfOpen ? 'HALF_OPEN' : 'DEGRADED' : 'HEALTHY', activeOperationId: state.activeOperationId ?? null, retryAfterMs: Math.max(0, state.degradedUntil - Date.now()) })), events: this.events.map((event) => ({ ...event })) }
  }

  private record(lane: Lane, event: GovernorEvent['event'], operationId: string): void {
    this.events.push({ lane, event, operationId, at: new Date().toISOString() })
    if (this.events.length > 20) this.events.shift()
  }

  async run(name: string, args: unknown, requestId: string | undefined, deadlineAtMs: number | undefined, execute: () => Promise<McpToolResult>): Promise<McpToolResult> {
    const values = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
    const lane: Lane | null = navigation.has(name) ? 'NAVIGATION' : name === 'start_validation' ? 'VALIDATION' : isReceiptedGitMutation(name, values) || name === 'stage_git_changes' ? 'MUTATIONS' : null
    if (!lane) return execute()
    const operationId = typeof values.operationId === 'string' ? values.operationId : requestId ?? randomUUID()
    if (lane === 'NAVIGATION') return this.runNavigation(operationId, deadlineAtMs, execute)
    const state = this.lanes[lane]
    if (state.activeOperationId || state.degradedUntil > Date.now()) {
      this.record(lane, 'ADMISSION_REFUSED', operationId)
      const degraded = !!state.degradedUntil
      return operationalFailure({ code: degraded ? 'CHANNEL_DEGRADED' : 'BUSY', retryability: lane === 'MUTATIONS' ? 'SAME_OPERATION_ID' : 'SAFE_AFTER_BACKOFF', retryAfterMs: Math.max(this.backoffMs, state.degradedUntil - Date.now()), recommendedAction: lane === 'MUTATIONS' ? 'RECOVER_SAME_OPERATION' : 'BACKOFF', ...(state.activeOperationId ? { activeOperationId: state.activeOperationId } : {}), ...(typeof values.operationId === 'string' ? { operationId: values.operationId } : {}) })
    }
    state.activeOperationId = operationId
    state.halfOpen = !!state.degradedUntil
    this.record(lane, state.halfOpen ? 'HALF_OPEN' : 'WORK_STARTED', operationId)
    const degrade = () => {
      state.degradedUntil = Date.now() + this.backoffMs
      state.halfOpen = false
      this.record(lane, 'DEGRADED', operationId)
    }
    const work = Promise.resolve().then(execute).then((result) => {
      if (result.isError) {
        this.record(lane, 'EXECUTION_FAILED', operationId)
        if (result.content.some((entry) => entry.type === 'text' && /REQUEST_TIMEOUT|CHANNEL_DEGRADED/.test(entry.text))) degrade()
        else if (state.halfOpen) degrade()
      } else {
        if (state.halfOpen) this.record(lane, 'RECOVERED', operationId)
        state.degradedUntil = 0; state.halfOpen = false
      }
      return result
    }, (error) => {
      this.record(lane, 'EXECUTION_FAILED', operationId); if (state.halfOpen || /TIMEOUT/.test(String(error))) degrade()
      throw error
    }).finally(() => { state.activeOperationId = undefined })
    return work
  }

  private async runNavigation(operationId: string, deadlineAtMs: number | undefined, execute: () => Promise<McpToolResult>): Promise<McpToolResult> {
    this.record('NAVIGATION', 'WORK_STARTED', operationId)
    let timer: NodeJS.Timeout | undefined
    let timedOut = false
    const work = Promise.resolve().then(execute).then(result => {
      if (!timedOut && result.isError) this.record('NAVIGATION', 'EXECUTION_FAILED', operationId)
      return result
    }, error => {
      if (!timedOut) this.record('NAVIGATION', 'EXECUTION_FAILED', operationId)
      throw error
    })
    const budget = Math.max(0, Math.min(this.timeoutMs, (deadlineAtMs ?? Date.now() + MCP_REQUEST_BUDGET_MS) - Date.now() - 1000))
    const timeout = new Promise<McpToolResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        this.record('NAVIGATION', 'EXECUTION_FAILED', operationId)
        resolve(operationalFailure({ code: 'REQUEST_TIMEOUT', retryability: 'SAFE_AFTER_BACKOFF', retryAfterMs: this.backoffMs, activeOperationId: operationId, recommendedAction: 'BACKOFF' }))
      }, budget)
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
