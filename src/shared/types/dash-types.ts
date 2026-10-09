export type DashSetType = 'file-set' | 'element-set' | 'reference-set'
export type DashFollow =
  | 'contains'
  | 'containedBy'
  | 'imports'
  | 'importedBy'
  | 'extends'
  | 'extendedBy'
  | 'implements'
  | 'implementedBy'
  | 'dependencies'
  | 'references'
export interface DashExpect {
  min: number
  max: number
}
export type DashFilter = {
  exact?: string | boolean | null
  contains?: string
  containsAny?: string[]
  containsAll?: string[]
  startsWith?: string
  in?: (string | boolean | null)[]
}
export type DashStep =
  | { id: string; find: 'file' | 'element'; where: Record<string, DashFilter>; expect: DashExpect }
  | { id: string; from: string; follow: DashFollow; expect: DashExpect }
  | { id: string; from: string[]; set: 'union' | 'intersect' | 'subtract'; expect: DashExpect }
export interface DashRequest {
  protocol: 'code-dash/v2'
  intent?: string
  steps: DashStep[]
  emit: { from: string; include: string[] }[]
  limits?: { maxTokens: number }
}
export type DashErrorCode =
  | 'INVALID_JSON'
  | 'UNKNOWN_PROTOCOL'
  | 'UNKNOWN_FIELD'
  | 'INVALID_STEP'
  | 'DUPLICATE_STEP_ID'
  | 'UNKNOWN_STEP_REFERENCE'
  | 'TYPE_MISMATCH'
  | 'UNKNOWN_OPERATOR'
  | 'INVALID_FILTER'
  | 'NOT_FOUND'
  | 'CARDINALITY_MISMATCH'
  | 'EXACT_SOURCE_UNAVAILABLE'
  | 'STALE_SOURCE'
  | 'BUDGET_EXCEEDED'
export interface DashResolutionReport {
  steps: { id: string; type: DashSetType; count: number }[]
  error?: { code: DashErrorCode; message: string; step?: string }
  tokenCount?: number
}
export type DashExecutionResult =
  | { success: true; context: string; tokenCount: number; report: DashResolutionReport }
  | { success: false; report: DashResolutionReport }
