import type { CanonicalStage, InvestigationTarget } from '../../shared/types/system-health-types'

const CODESCOPE_STAGE_TARGETS: Record<CanonicalStage, InvestigationTarget> = {
  'Remote Request': {
    systemArea: 'Public Gateway Ingress',
    component: 'Cloudflare Worker Gateway / Public MCP Gateway',
    boundary: 'Client → Public Gateway',
    responsibility: 'HTTP request parsing, routing, and ingress authentication',
    investigationSeeds: ['infra/gateway/cloudflare/worker.ts', 'infra/gateway/domain/public-mcp-gateway.ts']
  },
  'Access Assertion': {
    systemArea: 'Gateway Access Control',
    component: 'Cloudflare Access Assertion Verifier',
    boundary: 'Public Gateway → Access Verifier',
    responsibility: 'Validation of Cloudflare Access JWT assertions and cryptographic signatures',
    investigationSeeds: ['infra/gateway/domain/cloudflare-access-assertion-verifier.ts', 'infra/gateway/domain/public-mcp-gateway.ts']
  },
  'Identity Resolution': {
    systemArea: 'Gateway Identity & Enrollment',
    component: 'External Identity Resolver / D1 Resolver',
    boundary: 'Access Assertion → User Identity',
    responsibility: 'Mapping external identity (issuer, subject) to canonical user and tenant credentials',
    investigationSeeds: ['infra/gateway/domain/external-identity-resolver.ts', 'infra/gateway/cloudflare/d1-external-identity-resolver.ts', 'infra/gateway/domain/enrollment-service.ts']
  },
  'Installation Routing': {
    systemArea: 'Gateway Installation Registry',
    component: 'Installation Router / Registry',
    boundary: 'Identity Resolution → Target Desktop Installation',
    responsibility: 'Resolving and selecting the active online installation for the authenticated principal',
    investigationSeeds: ['infra/gateway/domain/installation-router.ts', 'infra/gateway/cloudflare/d1-installation-registry.ts']
  },
  'Relay Outbound': {
    systemArea: 'Gateway Relay Transport',
    component: 'Installation Relay / Durable Object Session',
    boundary: 'Public Gateway → Relay WebSocket',
    responsibility: 'Forwarding request over established relay session WebSocket connection to desktop',
    investigationSeeds: ['infra/gateway/cloudflare/installation-relay.ts', 'infra/gateway/domain/relay-session.ts']
  },
  'Desktop Request': {
    systemArea: 'Desktop Relay Client Ingress',
    component: 'Relay Transport Port',
    boundary: 'Relay WebSocket → Desktop Ingress',
    responsibility: 'Receiving invoke message on desktop and preparing local dispatch',
    investigationSeeds: ['src/main/mcp/connection/relay-transport.ts', 'src/main/mcp/connection/connection-lifecycle.ts']
  },
  'MCP Request': {
    systemArea: 'Local MCP Transport',
    component: 'MCP connection / relay transport',
    boundary: 'Desktop → Local MCP',
    responsibility: 'Availability and delivery of local MCP request',
    investigationSeeds: ['src/main/mcp/connection/relay-transport.ts', 'src/main/mcp/mcp-lifecycle.ts', 'src/main/mcp/mcp-http-server.ts']
  },
  'CodeScope Execution': {
    systemArea: 'CodeScope Navigation Core',
    component: 'Context Navigation Engine / Adapters',
    boundary: 'Local MCP → ProjectContextNavigation',
    responsibility: 'Execution of CodeScope tools against active project repository',
    investigationSeeds: ['src/main/core/context/project-context-navigation.ts', 'src/main/mcp/channel-mcp-adapter.ts', 'src/main/core/active-project-service.ts']
  },
  'MCP Response': {
    systemArea: 'Local MCP Response Serialization',
    component: 'MCP HTTP Server / Bridge Response',
    boundary: 'CodeScope Execution → Local MCP Response',
    responsibility: 'Formatting and delivering MCP response payload to desktop bridge',
    investigationSeeds: ['src/main/mcp/mcp-http-server.ts', 'src/main/mcp/connection/relay-transport.ts']
  },
  'Relay Inbound': {
    systemArea: 'Desktop Relay Egress',
    component: 'Desktop Relay WebSocket Egress',
    boundary: 'Desktop MCP → Relay Outbound',
    responsibility: 'Serializing and sending MCP result/error frame back over WebSocket to gateway',
    investigationSeeds: ['src/main/mcp/connection/relay-transport.ts', 'src/shared/distribution/relay-protocol.ts']
  },
  'Gateway Response': {
    systemArea: 'Gateway Relay Response Ingress',
    component: 'Installation Relay Inbound Handler',
    boundary: 'Desktop WebSocket → Gateway Inbound',
    responsibility: 'Awaiting and correlating desktop response frame within gateway deadline',
    investigationSeeds: ['infra/gateway/cloudflare/installation-relay.ts', 'infra/gateway/domain/public-mcp-gateway.ts']
  },
  'Client Response': {
    systemArea: 'Gateway Client Egress',
    component: 'Public MCP Gateway Egress',
    boundary: 'Gateway → Calling Client (ChatGPT/AI)',
    responsibility: 'Writing final HTTP response back to the client connection',
    investigationSeeds: ['infra/gateway/domain/public-mcp-gateway.ts', 'infra/gateway/cloudflare/worker.ts']
  }
}

export function getCodeScopeInvestigationTarget(
  stage: CanonicalStage | null,
  _reasonCode?: string | null
): InvestigationTarget | null {
  if (!stage) return null
  return CODESCOPE_STAGE_TARGETS[stage] ?? null
}
