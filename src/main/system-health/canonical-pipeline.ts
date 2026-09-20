import type { CodeScopeTraceStage } from '../mcp/code-scope-health'
import type { CanonicalStage } from '../../shared/types/system-health-types'

const PIPELINE: CanonicalStage[] = [
  'Remote Request',
  'Access Assertion',
  'Identity Resolution',
  'Installation Routing',
  'Relay Outbound',
  'Desktop Request',
  'MCP Request',
  'CodeScope Execution',
  'MCP Response',
  'Relay Inbound',
  'Gateway Response',
  'Client Response',
]

const STAGE_TO_CANONICAL: Partial<Record<CodeScopeTraceStage, CanonicalStage>> = {
  'gateway-request-started': 'Remote Request',
  'access-assertion-received': 'Access Assertion',
  'access-assertion-validated': 'Access Assertion',
  'identity-resolved': 'Identity Resolution',
  'installation-routed': 'Installation Routing',
  'relay-request-sent': 'Relay Outbound',
  'relay-request-received': 'Relay Outbound',
  'relay-request-forwarded': 'Relay Outbound',
  'desktop-request-received': 'Desktop Request',
  'relay-response-received': 'Relay Outbound',
  'bridge-forward-started': 'MCP Request',
  'mcp-request-started': 'MCP Request',
  'mcp-request-received': 'MCP Request',
  'mcp-dispatch-started': 'MCP Request',
  'codescope-request-started': 'CodeScope Execution',
  'codescope-handler-started': 'CodeScope Execution',
  'codescope-operation-routed': 'CodeScope Execution',
  'codescope-snapshot-started': 'CodeScope Execution',
  'codescope-snapshot-completed': 'CodeScope Execution',
  'codescope-readiness-requested': 'CodeScope Execution',
  'codescope-readiness-satisfied': 'CodeScope Execution',
  'codescope-readiness-failed': 'CodeScope Execution',
  'codescope-index-query-started': 'CodeScope Execution',
  'codescope-index-query-completed': 'CodeScope Execution',
  'codescope-result-assembly-started': 'CodeScope Execution',
  'codescope-result-assembly-completed': 'CodeScope Execution',
  'codescope-execution': 'CodeScope Execution',
  'codescope-response-produced': 'CodeScope Execution',
  'codescope-handler-completed': 'CodeScope Execution',
  'mcp-response-produced': 'MCP Response',
  'mcp-response-sent': 'MCP Response',
  'bridge-response-received': 'MCP Response',
  'desktop-relay-response-sent': 'Relay Inbound',
  'relay-response-forwarded': 'Relay Inbound',
  'gateway-relay-response-received': 'Gateway Response',
  'relay-response-delivered': 'Gateway Response',
  'gateway-response-produced': 'Gateway Response',
  'http-response-returned': 'Client Response',
  'client-response-completed': 'Client Response',
  'gateway-response-delivered': 'Client Response',
}

export const CANONICAL_PIPELINE = PIPELINE

export function toCanonicalStage(stage: CodeScopeTraceStage): CanonicalStage | null {
  return STAGE_TO_CANONICAL[stage] ?? null
}

export function pipelineIndexOf(stage: CanonicalStage): number {
  return PIPELINE.indexOf(stage)
}
