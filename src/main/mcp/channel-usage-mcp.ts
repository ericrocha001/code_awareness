import { z } from 'zod'
import type { McpToolDefinition, McpMultimodalToolResult } from './mcp-types'
import type { ChannelUsagePort } from './channel-usage-types'

const schema = z.object({
  view: z.enum(['overview', 'ranking', 'tool']).default('overview'),
  days: z.enum(['7', '15', '30', '60', '90', '180', '365', 'all']).default('30'),
  capability: z.string().min(1).max(128).optional(), repositoryId: z.string().min(1).max(128).optional(),
  toolName: z.string().min(1).max(128).optional(), sort: z.enum(['calls', 'timeouts']).default('calls'),
  order: z.enum(['asc', 'desc']).default('desc'), availability: z.enum(['all', 'exposed', 'unexposed', 'zero']).default('exposed'),
  includeInstrumental: z.boolean().default(true), includeDaily: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(10), cursor: z.string().max(2048).optional()
}).strict().superRefine((value, context) => {
  if (value.view === 'tool' && !value.toolName) context.addIssue({ code: 'custom', message: 'toolName required' })
  if (value.includeDaily && value.view !== 'tool') context.addIssue({ code: 'custom', message: 'Daily series requires tool view' })
  if (value.view === 'overview' && value.cursor) context.addIssue({ code: 'custom', message: 'Overview is not paginated' })
})

export const GET_CHANNEL_USAGE_TOOL: McpToolDefinition = {
  name: 'get_channel_usage',
  description: 'Read local profile MCP completion aggregates. Overview by default; ranking includes exposed tools with zero observed calls; tool detail accepts exact toolName and opt-in paginated daily series. UTC calendar days including today (default 30). repositoryId must be the authorized active repository. This instrumental tool is itself counted. Coverage starts at collector activation; missing calls do not imply low value. No payloads, billing or remote edge failures.',
  inputSchema: { type: 'object', properties: {
    view: { type: 'string', enum: ['overview', 'ranking', 'tool'], default: 'overview' },
    days: { type: 'string', enum: ['7', '15', '30', '60', '90', '180', '365', 'all'], default: '30' },
    capability: { type: 'string', maxLength: 128 }, repositoryId: { type: 'string', maxLength: 128 }, toolName: { type: 'string', maxLength: 128 },
    sort: { type: 'string', enum: ['calls', 'timeouts'] }, order: { type: 'string', enum: ['asc', 'desc'] },
    availability: { type: 'string', enum: ['all', 'exposed', 'unexposed', 'zero'] },
    includeInstrumental: { type: 'boolean' }, includeDaily: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 }, cursor: { type: 'string', maxLength: 2048 }
  }, additionalProperties: false },
  securitySchemes: [{ type: 'oauth2', scopes: [] }],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}

export async function executeGetChannelUsage(usage: ChannelUsagePort | undefined, args: unknown, repositoryId: string | null): Promise<McpMultimodalToolResult> {
  const parsed = schema.safeParse(args ?? {})
  const failure = (code: string): McpMultimodalToolResult => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code }) }] })
  if (!parsed.success) return failure('USAGE_INVALID_ARGUMENT')
  if (parsed.data.repositoryId && parsed.data.repositoryId !== repositoryId) return failure('USAGE_REPOSITORY_UNAUTHORIZED')
  if (!usage) return failure('USAGE_UNAVAILABLE')
  try {
    const result = await usage.query(parsed.data)
    const text = JSON.stringify(result)
    if (Buffer.byteLength(text) > 64 * 1024) return failure('USAGE_RESPONSE_BUDGET_EXCEEDED')
    return { content: [{ type: 'text', text }] }
  } catch (error) {
    const code = error instanceof Error && /^USAGE_[A-Z_]+$/.test(error.message) ? error.message : 'USAGE_UNAVAILABLE'
    return failure(code)
  }
}
