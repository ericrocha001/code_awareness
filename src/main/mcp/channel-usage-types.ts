export interface UsageTool { name: string; capability: string; instrumental: boolean }
export interface UsageCompletion extends UsageTool {
  repositoryId: string | null
  at: number
  durationMs: number
  status: 'success' | 'error' | 'timeout'
}
export interface UsageCatalog { at: number; repositoryId: string | null; tools: UsageTool[] }
export interface UsageBatch {
  id: number
  runId: string
  startedAt: number
  at: number
  completions: UsageCompletion[]
  catalogs: UsageCatalog[]
  losses: number
  stopped?: boolean
}
export interface UsageQuery {
  view: 'overview' | 'ranking' | 'tool'
  days: '7' | '15' | '30' | '60' | '90' | '180' | '365' | 'all'
  capability?: string
  repositoryId?: string
  toolName?: string
  sort: 'calls' | 'timeouts'
  order: 'asc' | 'desc'
  availability: 'all' | 'exposed' | 'unexposed' | 'zero'
  includeInstrumental: boolean
  includeDaily: boolean
  limit: number
  cursor?: string
}
export interface ChannelUsagePort {
  complete(event: UsageCompletion): void
  catalog(event: UsageCatalog): void
  query(query: UsageQuery): Promise<unknown>
}
